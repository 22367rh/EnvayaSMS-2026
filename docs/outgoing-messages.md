# Sending Messages (Outbound)

How outbound SMS is created, validated, rate-limited, and delivered — plus how
delivery status comes back. This is [`Outbox`](class-reference.md#queues-persistence) +
[`OutgoingMessage`/`OutgoingSms`](class-reference.md#message-model-outbound) +
`receiver/OutgoingSmsReceiver`.

---

## 1. Where outgoing messages come from

An outgoing message arrives from the **server**, via either transport:

- **HTTP poll** → `PollerTask.handleResponseJSON/XML` → `JsonUtils`/`XmlUtils`
  build `OutgoingMessage`s → `app.outbox.sendMessage(msg)`.
- **AMQP delivery** → `AmqpConsumer.ConsumeThread.processMessage` →
  `JsonUtils.processEvent(event)` with `event == "send"` → iterates the message
  list → `app.outbox.sendMessage(msg)`.

Both call the exact same `Outbox.sendMessage(...)`, so the send path is
transport-agnostic.

---

## 2. The outbound queue — `Outbox`

Like `Inbox`, `Outbox` is a thread-safe manager keyed by message `Uri`:

```java
sendMessage(msg):   validate state → insertPendingMessage (DB) → enqueueMessage
enqueueMessage():   only if None|Scheduled; adds to outgoingQueue, maybeDequeue
maybeDequeueMessage(): see rate-limit + allow up to 2 concurrent sends
messageSent(msg):   remove from map+DB, notify server STATUS_SENT, dequeue next
messageFailed(msg): scheduleRetry() or give up, notify STATUS_FAILED, dequeue next
deleteMessage(msg): user/server cancel → notify STATUS_CANCELLED
```

A `PriorityQueue` orders ready messages by **priority desc, then local id asc**
(oldest first within the same priority). At most **2** outgoing messages are in
flight at once (`numSendingOutgoingMessages < 2`).

To avoid duplicate delivery (e.g. if a `send_status` POST is lost), recent sent
URIs are cached in a bounded ring buffer (`MAX_RECENT_URIS = 100`); re-sending a
known URI re-notifies the server as *sent* instead of sending twice.

---

## 3. Validation — `OutgoingSms.validate()`

Before anything is sent, `validate()` throws `ValidationException`:

- Destination (`to`) must be non-empty **and** allowed by `isForwardablePhoneNumber`.
- In production (non-test mode) the recipient must pass validation; in test mode
  an invalid number can be auto-added to the *test numbers* list.
- Body must be non-empty.
- Must not exceed `OUTGOING_SMS_MAX_COUNT` parts (~100).

This guard exists mainly to stop accidental real SMS sends while testing.

---

## 4. Multipart division

`OutgoingSms.getBodyParts()` uses `SmsManager.getDefault().divideMessage(body)` to
split a long message into the parts Android can send. `getNumParts()` feeds both
the rate limiter and the actual send.

---

## 5. Rate limiting — the expansion-pack model

Android caps each app at ~100 SMS/hour via its internal `SMSDispatcher` counter.
EnvayaSMS implements a compatible per-app limit **and** shares/raises it through
expansion packs.

### How `App.chooseOutgoingSmsPackage(numParts)` works

1. Round-robin across the list of installed packages (`outgoingMessagePackages`).
2. For each package, keep a sliding window of send timestamps (last
   `OUTGOING_SMS_CHECK_PERIOD` = 1 hour).
3. If adding this message's parts keeps the count ≤ `OUTGOING_SMS_MAX_COUNT`
   (100), reserve those slots and return the package name.
4. If no package has headroom, return `null`.

When it returns `null`, the message is scheduled for the next valid time
(`getNextValidOutgoingTime`) **and** a `DEVICE_STATUS_SEND_LIMIT_EXCEEDED`
notification is sent to the server. Installing another expansion pack raises the
limit because the limit is `packages.size() * 100`.

```java
// simplified
public int getOutgoingMessageLimit() {
    return outgoingMessagePackages.size() * OUTGOING_SMS_MAX_COUNT; // e.g. 2 packs = 200/hr
}
```

`updateExpansionPacks()` asks every registered pack via an ordered broadcast
(`QUERY_EXPANSION_PACKS_INTENT`) which packages to include, then rebalances.

---

## 6. Actually sending — `OutgoingSms.send()`

```java
send(schedule):
    bodyParts = getBodyParts()
    intent = new Intent(packageName + ".OUTGOING_SMS", uri)
    intent.putExtra(OUTGOING_SMS_EXTRA_TO, to)
    intent.putExtra(OUTGOING_SMS_EXTRA_BODY, bodyParts)
    intent.putExtra(OUTGOING_SMS_EXTRA_DELIVERY_REPORT, false)
    app.sendBroadcast(intent, "android.permission.SEND_SMS")
```

The broadcast is received by `receiver/OutgoingSmsReceiver`, which calls
`SmsManager.sendMultipartTextMessage(...)` with a **PendingIntent per part** so a
per-part delivery report can be routed back through `MessageStatusNotifier`.

### Delivery status

`MessageStatusNotifier` (receives the `MESSAGE_STATUS_INTENT` broadcasts) maps
Android result codes (`RESULT_ERROR_NO_SERVICE`, `RESULT_ERROR_GENERIC_FAILURE`,
…) to strings and calls `outbox.messageSent(...)` / `outbox.messageFailed(...)`.
Failures schedule an escalating retry; final failure notifies the server of the
error.

---

## 7. Scheduling & timeouts

- **Scheduled sends**: if rate-limited, `Outbox` arms an `AlarmManager` alarm via
  `DequeueOutgoingMessageReceiver` to resume when the window opens.
- **Send timeout**: each in-flight message sets a ~30s `OutgoingMessageTimeout`
  alarm (`MESSAGE_SEND_TIMEOUT`) as a safety net if no status arrives.

---

## 8. Summary flow

```
   server event (send)
        │
        ▼
   outbox.sendMessage(msg)
        │  validate + persist to DB
        ▼
   outgoingQueue (priority order)
        │  maybeDequeueMessage(): rate-limit check, ≤2 concurrent
        ▼
   OutgoingSms.send() → OUTGOING_SMS broadcast
        │
        ▼
   OutgoingSmsReceiver → SmsManager.sendMultipartTextMessage(...)
        │  (per-part PendingIntents)
        ▼
   MessageStatusNotifier → outbox.messageSent / messageFailed
```

See [Outgoing Messages — rate limiting](outgoing-messages.md#5-rate-limiting-the-expansion-pack-model)
and [Persistence & Reliability](persistence-and-reliability.md).
