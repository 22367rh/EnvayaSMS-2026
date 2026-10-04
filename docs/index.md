# EnvayaSMS

EnvayaSMS is an Android application (package `org.envaya.sms`) that turns a
phone into an **SMS/MMS two-way messaging gateway**. It sits between the
Android telephony stack and a remote server: it forwards inbound text
messages, MMS messages, and incoming calls to a server over HTTP or a real‑time
AMQP (RabbitMQ) connection, and it delivers outbound messages from the server
to the cellular network.

The project is a classic *Android* library-style application built with **Ant**
(`build.xml`) targeting very old Android SDKs (`minSdkVersion = 4`, version name
`3.0.1`). It uses Apache HttpClient (the `org.apache.http` stack) and, for the
real-time transport, the RabbitMQ Java client (`libs/rabbitmq-client.jar`).

> **This document** is an auto-generated architectural tour of the code as it
> exists in this repository. It is organized so you can read top-down
> (overview → architecture → each subsystem) or use it as a reference to find
> how one specific piece works.

---

## What the app does, in one sentence

> Forward every inbound SMS / MMS / call to a configurable server, deliver every
> outbound message the server requests, and keep going across reboots, battery
> swaps, and flaky networks — using an optional persistent AMQP connection when
> configured.

---

## Core capabilities

| Capability | Where it lives | Short description |
|-----------|----------------|------------------|
| Inbound SMS forwarding | `receiver/SmsReceiver`, `Inbox` | Listens for `SMS_RECEIVED`, forwards forwardable messages to the server. |
| Inbound MMS forwarding | `IncomingMms`, `CheckMessagingService` | Polls the MMS content provider, forwards new parts. |
| Incoming-call notifications | `CallListener`, `IncomingCall` | Optionally notifies the ringtone/call to the server. |
| Outgoing SMS delivery | `Outbox`, `OutgoingSms`, `receiver/OutgoingSmsReceiver` | Sends messages via `SmsManager`, honours per-app rate limits. |
| Server push (polling) | `task/PollerTask`, `task/HttpTask` | Periodic HTTP GET to fetch server events. |
| Real-time server push (AMQP) | `AmqpConsumer`, `service/AmqpConsumerService` | Persistent RabbitMQ connection for instant delivery. |
| Persistence & retries | `DatabaseHelper`, `Inbox`, `Outbox`, `QueuedMessage` | SQLite backup of pending messages + exponential backoff retry. |
| Expansion packs / rate limiting | `App.chooseOutgoingSmsPackage` | Round-robin per-package SMS rate limit; other apps can extend the limit. |
| Live log UI | `ui/LogView`, `ui/Main` | Streams app log from a in-memory buffer to the UI. |

---

## The two transport paths

EnvayaSMS talks to its server over **two independent channels**, and both are
documented in detail below:

1. **HTTP polling** (the default, always-available path). Every `outgoing_interval`
   seconds the app issues an `ACTION_OUTGOING` request; the server can reply with
   *events* (send/cancel messages, update settings, log). Incoming messages are
   pushed by the app via `ACTION_INCOMING` / `ACTION_FORWARD_SENT` requests.

2. **AMQP** (the real-time path). When `amqp_enabled` is set, the app opens a
   persistent connection to a RabbitMQ server and consumes a queue. Messages from
   the server arrive instantly as AMQP deliveries instead of waiting for the next
   poll. See [Real-time AMQP Connection](amqp-connection.md).

Both channels are normalized through `JsonUtils.processEvent(...)` /
`XmlUtils`, so the *event model* (`send`, `cancel`, `cancel_all`, `log`,
`settings`) is identical regardless of transport.

---

## How to read this document

- **Start with [Overview](overview.md)** for a non-technical tour and the
  "install & run" basics.
- **[Architecture](architecture.md)** draws the component map and the request /
  message lifecycle.
- Each subsystem has its own page (incoming, outgoing, server comms, AMQP,
  persistence).
- **[Class Reference](class-reference.md)** is an alphabetical cheat-sheet for
  every class in `src/org/envaya/sms`.
- **[Glossary & Config Keys](glossary.md)** defines terms and lists every
  settings key read by the app.

---

## A note on this codebase

This is a real, shipping production app (EnvayaSMS, ~2012–2013 era of Android).
A few things worth flagging so you are not surprised:

- It targets **API level 4+**, so the source uses APIs (`org.apache.http.*`,
  `SmsManager`, `TelephonyManager` phone-state listeners) that no longer exist on
  modern Android. The documentation describes *how the code works as written*.
- State lives in the application singleton [`App`](class-reference.md#application-core).
  Almost every class is reached through `context.getApplicationContext()` cast to
  `App`.
- Reliability is achieved with **persistent SQLite storage + AlarmManager-driven
  retries**, which is why the app has so many `*Receiver` classes.

Happy reading!
