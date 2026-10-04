# Receiving Messages (Inbound)

How inbound **SMS**, **MMS**, and **calls** get from the telephony stack to the
server. This is [`IncomingMessage`](class-reference.md#message-model-inbound) family +
`Inbox` + a set of receivers/services.

---

## 1. Three sources, one destination

Every inbound source ultimately calls the same method:

```java
app.inbox.forwardMessage(incomingMessage);
```

The three sources are:

| Source | Class | Trigger |
|--------|-------|---------|
| SMS | `receiver/SmsReceiver` | `SMS_RECEIVED` broadcast (priority `101`). |
| MMS | `service/CheckMessagingService` | Content-provider change on `content://mms-sms/`. |
| Call | `CallListener` → `IncomingCall` | Phone state → `CALL_STATE_RINGING`. |

---

## 2. SMS path — `SmsReceiver`

`SmsReceiver extends BroadcastReceiver` is registered in the manifest with a
high intent priority (`101`) on `android.provider.Telephony.SMS_RECEIVED`.

Flow:

```java
onReceive():
    app = getApplicationContext()
    if !app.isEnabled(): return
    sms = getMessageFromIntent(intent)          // parse PDUs → IncomingSms
    if sms.isForwardable():
        app.inbox.forwardMessage(sms)
        if !app.getKeepInInbox(): this.abortBroadcast()   // hide from stock SMS app
    else: log("Ignoring incoming SMS ...")
```

- **Multipart SMS**: the intent bundle may contain several PDUs (parts). They are
  reassembled into a single `IncomingSms`, and an exception is thrown if they come
  from different senders.
- **`abortBroadcast()`** hides the message from the default SMS app when we're not
  keeping a copy (`keep_in_inbox = false`).

### Who is "forwardable"?

`isForwardable()` consults `App.isForwardablePhoneNumber()`:

- In **test mode**, the sender must match a *test phone number*.
- Otherwise senders on the *ignored list* are dropped.
- Non-numeric / short (< 7 digit) numbers can be filtered by
  `ignore_non_numeric` / `ignore_shortcodes`.

---

## 3. MMS path — content observer + service

MMS is more involved because parts (images, audio, SMIL) must be read from the
Messaging content provider.

```
MessagingObserver.onChange()            (registered on content://mms-sms/)
        └▶ startService(CheckMessagingService)
                └ checkNewMms():
                      getMessagesInMmsInbox(newMessagesOnly=true)
                      → for each new MMS: markSeenMms(), isForwardable()?
                              inbox.forwardMessage(IncomingMms)
```

- `MessagingObserver` watches the combined mms-sms content URI. To avoid double
  processing it tracks seen IDs in `seenMmsIds`.
- `CheckMessagingService` (an `IntentService`, so one request at a time) also
  scans **sent SMS** (`getSentSmsMessages`) for the *forward-sent-messages*
  feature, which forwards messages the user sends via the stock Messaging app.

### Reading parts — `MessagingUtils` / `MmsPart`

`IncomingMms.getParts()` lazily loads parts from `content://mms/part`. Each
`MmsPart` knows its content type, text/binary data, filename, and content-id (used
to resolve SMIL references like `<img src="cid:..."/>`). The sender number is
resolved on demand via the `content://mms/{id}/addr` table.

---

## 4. Call path — `CallListener`

```java
onCallStateChanged(state, incomingNumber):
    if state == CALL_STATE_RINGING:
        call = new IncomingCall(app, incomingNumber, now)
        if call.isForwardable() && callNotificationsEnabled():
            app.inbox.forwardMessage(call)
```

Only *ringing* calls are forwarded and only when `call_notifications` is on.

---

## 5. The inbound queue — `Inbox`

`Inbox` is a small thread-safe manager keyed by message `Uri`:

```java
forwardMessage(msg):   dedupe → log → DB.insertPendingMessage → enqueueMessage
enqueueMessage(msg):   only if state == None|Scheduled; adds to incomingQueue
maybeDequeueMessage():  allows up to 2 concurrent forwarding (numForwardingMessages < 2)
messageForwarded(msg): remove from map + DB, call onForwardComplete(), dequeue next
messageFailed(msg):     schedule retry / mark scheduled, decrement counter, dequeue next
deleteMessage(msg):     user-deleted; notify server of cancellation-ish state
```

Why a queue with a concurrency limit? Forwarding is network I/O; capping it at 2
prevents the app from piling up work during a network blip.

### Per-message lifecycle

```
   received ─▶ QUEUED ─▶ FORWARDING ─▶ FORWARDED (deleted)
                 │        │
                 │        └── success → messageForwarded()
                 │        │
                 └────────┴── failure → scheduleRetry() → SCHEDULED ─(retry)──▶ FORWARDING
```

`IncomingMessage.onForwardComplete()` does transport-specific cleanup — for MMS,
it deletes the message from the phone inbox when `keep_in_inbox` is false.

---

## 6. Forwarding to the server — `ForwarderTask`

Each inbound message is sent with a `ForwarderTask` (an `HttpTask` subclass):

- **action** = `incoming` (SMS/call) or `forward_sent` (user-sent SMS).
- Parameters: `message_type`, `from`/`to`, `timestamp`, `message` body.
- For MMS, parts are attached as multipart form fields (`part0`, `part1`, …) plus
  a `mms_parts` JSON metadata blob describing each part's name/cid/type/filename.

On success → `inbox.messageForwarded(message)`; on failure → `inbox.messageFailed`.

See [Server Communication](server-communication.md) for the wire format and
[Persistence & Reliability](persistence-and-reliability.md) for retries.
