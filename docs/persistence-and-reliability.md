# Persistence & Reliability

EnvayaSMS is designed to **never lose a message**. Whether inbound (to forward) or
outbound (to send), every in-flight message is persisted to SQLite and retried with
an escalating schedule via `AlarmManager`. If the app crashes, the phone loses
battery, or the network drops, pending work survives and resumes on restart.

---

## 1. The database — `DatabaseHelper`

A single SQLite database (`envayasms.db`, version 4) with two tables:

```sql
CREATE TABLE pending_incoming_messages (
    _id           INTEGER PRIMARY KEY AUTOINCREMENT,
    message_type  VARCHAR,          -- sms / mms / call
    messaging_id  INTEGER,          -- id in the Messaging app DB (if applicable)
    from_number   VARCHAR,
    to_number     VARCHAR,
    message       TEXT,
    direction     INTEGER,          -- Incoming/Sent ordinal
    timestamp     INTEGER
);

CREATE TABLE pending_outgoing_messages (
    _id           INTEGER PRIMARY KEY AUTOINCREMENT,
    message_type  VARCHAR,
    from_number   VARCHAR,
    to_number     VARCHAR,
    message       TEXT,
    priority      INTEGER,
    server_id     TEXT              -- id assigned by the server
);
```

These are **backups of the in-memory `Inbox`/`Outbox`**. The comment in
`onCreate` explains the intent: *"allows us to restore pending messages after
restart if phone runs out of batteries or app crashes."*

### Restore on startup — `restorePendingMessages()`

On boot / enable, `EnabledChangedService` calls `restorePendingMessages()`, which
rehydrates both queues from disk by reconstructing the right subclass per
`message_type` (`IncomingSms`/`IncomingMms`/`IncomingCall`, `OutgoingSms`) and
handing each back to `inbox.forwardMessage(...)` / `outbox.sendMessage(...)`.

---

## 2. The shared base — `QueuedMessage`

`IncomingMessage` and `OutgoingMessage` both extend `QueuedMessage`, which adds:

- **Retry bookkeeping**: `numRetries`, `nextRetryTime`, `dateCreated`.
- **Persistence id** (`persistedId`) linking the in-memory object to its DB row.
- **Escalating backoff** via `scheduleRetry()`.
- An abstract `getRetryIntent()` each subclass implements to point at its own retry
  receiver.

### Retry schedule (`QueuedMessage.scheduleRetry`)

| Attempt | Backoff |
|---------|---------|
| 1st failure | +20 s |
| 2nd failure | +5 min |
| 3rd failure | +1 h |
| 4th failure | +24 h |
| 5th failure | **give up** (logged) |

Each attempt arms an `AlarmManager` alarm (`ELAPSED_REALTIME_WAKEUP`) targeting the
subclass's retry receiver, so a wake-up is required to actually retry.

---

## 3. Retry wiring — who re-queues what

| Failure happens in | Receiver that retries |
|--------------------|-----------------------|
| Inbound forwarding | `receiver/IncomingMessageRetry` → `inbox.enqueueMessage(msg)` |
| Outgoing send | `receiver/OutgoingMessageRetry` → `outbox.enqueueMessage(msg)` |
| Scheduled dequeue timer | `receiver/DequeueOutgoingMessageReceiver` |
| Send timeout safety net | `receiver/OutgoingMessageTimeout` |

---

## 4. When does a message get persisted?

- **Inbound**: `Inbox.forwardMessage()` calls `dbHelper.insertPendingMessage(msg)`
  *before* forwarding, and deletes the row in `messageForwarded()`.
- **Outbound**: `Outbox.sendMessage()` persists via `insertPendingMessage` before
  enqueueing; rows are deleted on `messageSent`, `messageFailed`(final), or
  `deleteMessage`.

So a DB row exists for exactly as long as the message is potentially in flight.

---

## 5. Connectivity-driven recovery

`App` coordinates retries around network state:

- `onConnectivityError()` — flags an error and kicks `asyncCheckConnectivity()`,
  which may toggle Wi-Fi (network failover) if a connection exists but can't reach
  the host.
- `onConnectivityRestored()` — drains `inbox`/`outbox`/queued tasks: calls
  `inbox.retryAll()`, `checkOutgoingMessages()`, and `retryQueuedTasks()`.
- `retryStuckMessages()` — manual "Retry" from the UI forces all three.

HTTP tasks created with `retryOnConnectivityError(true)` are re-queued via
`addQueuedTask` and drained on restore (`retryQueuedTasks`).

---

## 6. Full lifecycle example (inbound)

```
SMS received
   → inbox.forwardMessage()
       → DB INSERT (pending_incoming_messages)
       → incomingQueue.add(); maybeDequeue (≤2 concurrent)
       → ForwarderTask.execute()  (action=incoming)
          ├── success → inbox.messageForwarded() → DB DELETE, onForwardComplete()
          └── failure → inbox.messageFailed()
                 → QueuedMessage.scheduleRetry()   (arm alarm + increment counter)
                        → [20s later] IncomingMessageRetry fires
                        → inbox.enqueueMessage() → maybeDequeue → ForwarderTask ...
```

The same shape applies to outbound, with `Outbox`/`OutgoingMessageRetry` and the
added rate-limit gate before sending.

---

## 7. Why this matters

- **Crash/battery loss resilience**: pending work is on disk, restored on next start.
- **Transient-resilient**: escalating backoff spreads out retries under load/outage.
- **Bounded concurrency**: at most 2 inbound / 2 outbound in flight prevents a
  network recovery from flooding the app with I/O at once.

---

Next: [UI & Settings](ui-and-settings.md), or browse the [Class Reference](class-reference.md).
