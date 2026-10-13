# Architecture

This page describes how the pieces fit together. It is the single most useful
starting point for understanding *how the whole thing works*. Read
[Overview](overview.md) first if you haven't already.

---

## 1. The big picture

EnvayaSMS is a **message-forwarding daemon** wrapped in an Android app. Its job
splits cleanly into three concerns:

```
   ┌────────────────────┐      ┌─────────────────────┐      ┌──────────────────────┐
   │  Sources / sinks   │      │  Core engine        │      │  Transport           │
   │  on the device     │      │  (App singleton)    │      │  to/from server      │
  ─────────────────────┼──────────────────────────────┼───────────────────────────┤
   • SMS receiver       │      • App                  │      • HTTP polling tasks   │
   • MMS content probe  │      • Inbox / Outbox       │      • AMQP consumer        │
   • Call listener      │   →  • DatabaseHelper       │      • Connectivity mgmt    │
   • Boot / alarms      │      • MessagingObserver    │      • Retry/backoff        │
   └────────────────────┘      └─────────────────────┘      └──────────────────────┘
```

Everything is coordinated by the **`App`** application singleton. There is no
MVC framework, dependency injection, or service locator beyond casting
`context.getApplicationContext()` to `App`. This is intentional for a 2012-era
app: it keeps things fast and avoids extra dependencies.

---

## 2. The `App` singleton — the heart of everything

`App extends android.app.Application` and holds *all* shared state and
coordination logic. Almost every other class reaches back to it via
`((App) context.getApplicationContext())`.

Key responsibilities (see `App.java`):

- **Settings accessors** (`getServerUrl`, `isEnabled`, `isAmqpEnabled`, …) that
  read `SharedPreferences` with defensive type coercion.
- **Inbox / Outbox** holders (`public final Inbox inbox; public final Outbox outbox`).
- **Rate limiting** for outgoing SMS (`chooseOutgoingSmsPackage`,
  `getNextValidOutgoingTime`) and expansion-pack management.
- **Connectivity handling** (`onConnectivityChanged`, `asyncCheckConnectivity`,
  wifi failover).
- **In-memory log buffer** (`displayedLog`, `log()`, `getDisplayedLog`) that the
  UI streams live.
- **Subsidiaries**: `DatabaseHelper`, `MessagingObserver`, `CallListener`,
  `AmqpConsumer`, `MessagingUtils`.

```java
public final class App extends Application {
    public final Inbox inbox = new Inbox(this);
    public final Outbox outbox = new Outbox(this);
    private DatabaseHelper dbHelper;
    private MessagingObserver messagingObserver;
    private CallListener callListener;
    private AmqpConsumer amqpConsumer;
    ...
}
```

> **Design pattern to notice:** `App` is a *facade* over the whole system. It
> also doubles as the logger and the settings store, which keeps method counts
> low (important on old Android/Dalvik).

---

## 3. Component map

```
                         ┌──────────────────────────┐
   SMS_RECEIVED  ──────▶ │ SmsReceiver              │──▶ app.inbox.forwardMessage()
   (priority 101)        └──────────────────────────┘

         Content Provider (mms-sms)
                    │  onChange()
                    ▼
        ┌──────────────────────┐   MessagingObserver / CheckMessagingService
        │ getMessagesInMmsInbox│   getSentSmsMessages(...)  →  app.inbox.forwardMessage()
        └──────────────────────┘

         RINGING call ─────▶ CallListener ─────▶ IncomingCall → app.inbox.forwardMessage()


   Server events (HTTP or AMQP)
                    │
                    ▼
        JsonUtils.processEvent(event)  ──▶  app.outbox.sendMessage(outgoingMsg)
                                            OutgoingSms.send() ─▶ OutgoingSmsReceiver (SmsManager)
```

### Layers

| Layer | Classes | Role |
|-------|---------|------|
| **Entry / broadcast** | `SmsReceiver`, `IncomingMms`, `IncomingCall`, `MessagingObserver` | Turn device events into `IncomingMessage` objects. |
| **Inbound queue** | `Inbox`, `IncomingMessage`(s) | Deduplicate, persist, forward up to 2 at a time. |
| **Outbound queue** | `Outbox`, `OutgoingMessage`(s) | Validate, rate-limit, send up to 2 at a time. |
| **Persistence** | `DatabaseHelper`, `QueuedMessage` | SQLite backup + AlarmManager retries. |
| **Transport** | `HttpTask`, `PollerTask`, `ForwarderTask`, `AmqpConsumer` | Move bytes to/from the server. |
| **Coordination** | `App`, services, receivers | Wire it all together and survive reboot/restart. |

---

## 4. The central request/response cycle

The app is *server-driven*. Two mechanisms deliver "do this" instructions:

1. **HTTP poll** — every `outgoing_interval` seconds (or on connectivity
   restore / boot) the app calls `App.checkOutgoingMessages()` →
   `PollerTask` issues an HTTP GET with `action=outgoing`. The server replies
   with a JSON or XML *event list*.
2. **AMQP delivery** — when configured, messages arrive instantly on a queue and
   are processed by the `ConsumeThread` in `AmqpConsumer`.

Both paths funnel through the same event processor:

```
processEvent(event)  ──▶ send    → outbox.sendMessage()
                        ├── cancel    → outbox.deleteMessage()
                        ├── cancel_all→ delete all cancellable
                        ├── log       → app.log(message)
                        └── settings  → updateSettings() + configuredChanged()
```

Meanwhile, the **app pushes inbound data up** whenever it happens:

```
inbound SMS/MMS/call → inbox.forwardMessage()
                     → ForwarderTask (action=incoming) POSTs to server
```

And **outgoing status comes back** via `ACTION_SEND_STATUS` requests so the
server knows what was actually delivered.

---

## 5. Lifecycle: from boot to delivery

```
   Device boots / app starts
            │
            ▼
   App.onCreate()
     • build Inbox/Outbox, DatabaseHelper, MessagingObserver, CallListener, AmqpConsumer
     • updateExpansionPacks()      (round-robin rate-limit pool)
     • configuredChanged()         (if server_url set → enabledChanged())
            │
            ▼
   EnabledChangedService.onHandleIntent()   (started by App.enabledChanged())
     • ForegroundService            (keep app alive)
     • setOutgoingMessageAlarm()    (periodic poller alarm)
     • MessagingObserver.register() (watch content provider)
     • TelephonyManager.listen(...) (call-state listener)
     • DatabaseHelper.restorePendingMessages()   (restore from SQLite after restart)
     • AmqpConsumer.startAsync()    (real-time connection, if enabled)
```

`NudgeReceiver` (fired by `AlarmManager` on `BOOT_COMPLETED` and periodically)
is the trigger that re-initializes `App` state after a reboot.

---

## 6. Concurrency model — read this to avoid confusion

The app threads work across many Android components, so it uses explicit
`synchronized` carefully:

- **`Inbox` / `Outbox`** synchronize on themselves; they allow at most **2**
  in-flight messages (`maybeDequeueMessage` checks a counter).
- **`App`** synchronizes rate-limit and log-buffer methods.
- **`AmqpConsumer`** has an explicit deadlock-avoidance note: its async/start
  paths must *not* hold locks that the main thread also needs, so it talks to
  services via `startService(...)` rather than calling back directly.

HTTP tasks run on Android's `AsyncTask` background threads; UI updates happen on
the main thread via broadcasts (`LOG_CHANGED_INTENT`, `INBOX_CHANGED_INTENT`,
`OUTBOX_CHANGED_INTENT`).

---

## 7. Reliability at a glance

If forwarding or sending fails, the message is **not lost**:

1. It stays in `Inbox`/`Outbox` (in memory) **and** a row in SQLite.
2. `QueuedMessage.scheduleRetry()` sets an escalating `AlarmManager` alarm
   (20s → 5min → 1h → 1 day, max 5 attempts).
3. On the next success the DB row is deleted; on final failure the server is
   notified of the failure status.

See [Persistence & Reliability](persistence-and-reliability.md) for the full
retry schedule and restore flow.

---

## Next up

- **[Incoming Messages](incoming-messages.md)** — how SMS/MMS/calls become forwarded events.
- **[Outgoing Messages](outgoing-messages.md)** — validation, rate limiting, sending.
- **[Server Communication](server-communication.md)** — HTTP request signing, JSON vs XML, the event model.
