# Class Reference

Alphabetical cheat-sheet for every class in `src/org/envaya/sms`. Each entry states
its package and one-line job. Package root is `org.envaya.sms`.

> Not sure which page to read? Jump to the relevant topic:
> [Architecture](architecture.md) · [Incoming](incoming-messages.md) ·
> [Outgoing](outgoing-messages.md) · [Server comms](server-communication.md) ·
> [AMQP](amqp-connection.md) · [Persistence](persistence-and-reliability.md).

---

## Application core

| Class | File | Purpose |
|-------|------|---------|
| `App` | `App.java` | **Application singleton.** Holds all shared state: settings, Inbox/Outbox, DatabaseHelper, MessagingObserver, CallListener, AmqpConsumer. Coordinates rate limiting, connectivity, and the in-memory log. |
| `ValidationException` | `ValidationException.java` | Thrown by `OutgoingSms.validate()` for invalid recipients/bodies. |
| `Base64Coder` | `Base64Coder.java` | Minimal Base64 encoder used for request signatures. |

---

## Message model — inbound

| Class | File | Purpose |
|-------|------|---------|
| `IncomingMessage` | `IncomingMessage.java` | Abstract base for received messages. Holds from/to/body/timestamp, processing state (`None→Queued→Forwarding→Forwarded`), and builds the `ForwarderTask`. |
| `IncomingSms` | `IncomingSms.java` | A received SMS (reassembles multipart PDUs). |
| `IncomingMms` | `IncomingMms.java` | A received MMS; lazily loads parts, sends them as multipart form upload. |
| `IncomingCall` | `IncomingCall.java` | A ringing-call notification. |
| `MmsPart` | `MmsPart.java` | One part of an MMS (content-type, text/binary data, cid, filename). |

---

## Message model — outbound

| Class | File | Purpose |
|-------|------|---------|
| `OutgoingMessage` | `OutgoingMessage.java` | Abstract base for server-requested messages. Server id, priority, send/timeout alarms. |
| `OutgoingSms` | `OutgoingSms.java` | An outgoing SMS; divides body via `SmsManager`, broadcasts to `OutgoingSmsReceiver`. |
| `QueuedMessage` | `QueuedMessage.java` | Base for both directions: retry bookkeeping, escalating backoff, persistence id. |

---

## Queues & persistence

| Class | File | Purpose |
|-------|------|---------|
| `Inbox` | `Inbox.java` | Thread-safe inbound queue; dedupe + forward ≤2 concurrently; persists to DB. |
| `Outbox` | `Outbox.java` | Thread-safe outbound queue; validate, rate-limit gate, send ≤2 concurrently; caches recent URIs to avoid dupes. |
| `DatabaseHelper` | `DatabaseHelper.java` | SQLite (`envayasms.db`): `pending_incoming_messages`, `pending_outgoing_messages`; restore on startup. |
| `MessagingObserver` | `MessagingObserver.java` | Content observer on `content://mms-sms/` that triggers messaging checks. |
| `MessagingUtils` | `MessagingUtils.java` | Reads SMS/MMS from the Messaging content provider; tracks seen IDs. |

---

## Receivers (`receiver/`)

| Class | File | Purpose |
|-------|------|---------|
| `SmsReceiver` | `SmsReceiver.java` | Handles `SMS_RECEIVED`; builds `IncomingSms`, forwards if forwardable, optionally aborts broadcast. |
| `OutgoingSmsReceiver` | `OutgoingSmsReceiver.java` | Receives the `.OUTGOING_SMS` broadcast; calls `SmsManager.sendMultipartTextMessage`. |
| `MessageStatusNotifier` | `MessageStatusNotifier.java` | Maps SMS delivery result codes → `outbox.messageSent/messageFailed`. |
| `IncomingMessageRetry` | `IncomingMessageRetry.java` | Alarm target: re-enqueues a failed inbound message. |
| `OutgoingMessageRetry` | (generated) | Alarm target: re-enqueues a failed outgoing message. |
| `DequeueOutgoingMessageReceiver` | `receiver/DequeueOutgoingMessageReceiver.java` | Alarm target: resume the outgoing queue after rate-limit wait. |
| `OutgoingMessageTimeout` | `receiver/OutgoingMessageTimeout.java` | Alarm target: safety net if no status arrives after a send. |
| `OutgoingMessagePoller` | `OutgoingMessagePoller.java` | Periodic alarm that calls `app.checkOutgoingMessages()`. |
| `NudgeReceiver` | `receiver/NudgeReceiver.java` | Boot/periodic nudge to re-initialize app state. |
| `StartAmqpConsumer` | `receiver/StartAmqpConsumer.java` | Alarm target: delayed retry of a failed AMQP start. |
| `ConnectivityChangeReceiver` | `receiver/ConnectivityChangeReceiver.java` | On connectivity change, (re)start the AMQP consumer / check connectivity. |
| `DeviceStatusReceiver` | `receiver/DeviceStatusReceiver.java` | Power/battery events → `device_status` notifications. |
| `ReenableWifiReceiver` | `receiver/ReenableWifiReceiver.java` | Re-enables Wi-Fi after a failover window expires. |
| `ExpansionPackInstallReceiver` | `receiver/ExpansionPackInstallReceiver.java` | Watches for expansion-pack installs/removals; refreshes the rate-limit pool. |
| `MessageDeliveryNotifier` | `receiver/MessageDeliveryNotifier.java` | (Reserved) delivery-notification plumbing. |

---

## Services (`service/`)

| Class | File | Purpose |
|-------|------|---------|
| `ForegroundService` | `service/ForegroundService.java` | Keeps the app foregrounded while enabled. |
| `EnabledChangedService` | `service/EnabledChangedService.java` | Runs enable/disable side effects (foreground, poll alarm, observer, call listener, restore, AMQP). |
| `CheckMessagingService` | `service/CheckMessagingService.java` | Scans content provider for new MMS/sent SMS and forwards them. |
| `AmqpConsumerService` | `service/AmqpConsumerService.java` | Runs the AMQP consume loop (`startBlocking`/`stopBlocking`). |
| `AmqpHeartbeatService` | `service/AmqpHeartbeatService.java` | Keeps the AMQP heartbeat alarm alive. |

---

## Transport tasks (`task/`)

| Class | File | Purpose |
|-------|------|---------|
| `BaseHttpTask` | `task/BaseHttpTask.java` | Base async HTTP task (form parts, content-type handling). |
| `HttpTask` | `task/HttpTask.java` | Adds common params + signature; dispatches JSON vs XML responses. |
| `PollerTask` | `task/PollerTask.java` | `action=outgoing` poll; marks poll complete on finish. |
| `ForwarderTask` | `task/ForwarderTask.java` | Forwards one inbound message; updates inbox on success/failure. |
| `CheckConnectivityTask` | `task/CheckConnectivityTask.java` | Probes reachability to the server host (failover). |

---

## Real-time transport

| Class | File | Purpose |
|-------|------|---------|
| `AmqpConsumer` | `AmqpConsumer.java` | Owns the RabbitMQ connection, consume thread, retries, WifiLock. |

---

## UI (`ui/`)

| Class | File | Purpose |
|-------|------|---------|
| `Main` | `ui/Main.java` | Launcher; forwards to `LogView`. |
| `LogView` | `ui/LogView.java` | Live log viewer + test/check actions. |
| `Prefs` | `ui/Prefs.java` | Settings (`PreferenceActivity`). |
| `Help` | `ui/Help.java` | In-app help text. |
| `TestPhoneNumbers` | `ui/TestPhoneNumbers.java` | Manage test-mode recipients. |
| `IgnoredPhoneNumbers` | `ui/IgnoredPhoneNumbers.java` | Manage ignored senders. |
| `ExpansionPacks` | `ui/ExpansionPacks.java` | Show rate-limit/expansion-pack info. |
| `PendingMessages` | `ui/PendingMessages.java` | Inspect & retry pending messages. |
| `MessagingForwarder` | `ui/MessagingForwarder.java` | Base for the three inbox-browsing activities. |
| `MessagingSmsInbox`, `MessagingMmsInbox`, `MessagingSentSms` | `ui/*.java` | Browse forwarded/saved SMS / MMS / sent lists. |

---

## Utilities

| Class | File | Purpose |
|-------|------|---------|
| `JsonUtils` | `JsonUtils.java` | Parses JSON responses; processes events (`send/cancel/log/settings`). |
| `XmlUtils` | `XmlUtils.java` | Legacy XML response parsing. |
