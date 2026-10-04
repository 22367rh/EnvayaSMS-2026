# Overview & Getting Started

This page gives a non-technical tour of EnvayaSMS: what it is, why it exists,
how to build and configure it, and where things live in the source tree. If you
are new to this codebase, read this first, then jump to
[Architecture](architecture.md).

---

## What is EnvayaSMS?

EnvayaSMS lets a normal Android phone act as a **messaging gateway / small
SMS modem**. It is commonly used with a server that wants to:

- receive text messages from real people and reply automatically (e.g. a chat
  bot, a helpline, a community health system),
- send bulk SMS on demand,
- stay in near real-time contact with the phone.

The phone runs EnvayaSMS as a *service*: it stays alive in the background,
forwards inbound traffic to your server, and pushes outbound traffic out over
the cellular network.

### Who uses it?

- Developers building two-way SMS applications in regions where the phone is the
  only computer available.
- Testers who want to automate interaction with a device fleet.
- Anyone who wants an extensible "phone as a modem" platform — other apps can
  install **expansion packs** that both extend functionality and raise the
  outgoing-SMS rate limit (see below).

---

## Building the app

The project uses **Ant** as its build tool (`build.xml`). Before building:

1. Install an Android SDK compatible with this era of the platform.
2. Create a `local.properties` file in the project root pointing at your SDK:
   ```
   sdk.dir=C:\\android-sdk
   ```
3. Run `ant debug` (or build via NetBeans / Eclipse ADT, as the README notes).

The app bundles third-party libraries under `libs/`:

| Library | Purpose |
|---------|---------|
| `rabbitmq-client.jar` | Real-time AMQP consumer (RabbitMQ). |
| `httpmime-4.1.2.jar` / `commons-io`, `commons-cli` | Apache HTTP client + MIME multipart for MMS uploads. |

> The app is a *library-style* Android project: its main entry point is the
> `App` (`android:name=".App"`) and a launcher `Activity` (`ui/Main`).

---

## Permissions & what they enable

The full list lives in [`AndroidManifest.xml`](#appendix-manifest-permissions).
Broadly, the app needs access to:

- **Telephony**: receive/send SMS/MMS, read phone state (to detect incoming
  calls and report device identity), listen for call state.
- **Network & boot**: reach the server, survive reboots (`RECEIVE_BOOT_COMPLETED`),
  keep the CPU/wifi awake while needed.
- **Storage / package**: watch for expansion-pack installs, read MMS parts.

---

## Configuration (settings)

EnvayaSMS is configured through Android `SharedPreferences`, edited from the
`ui/Prefs` screen and — remotely — by the server via `EVENT_SETTINGS`. The most
important keys:

| Key | Meaning |
|-----|---------|
| `server_url` | Base URL the app POSTs to / polls. **Required** for anything to work. |
| `password` | Shared secret; used to sign every request (see [Server Communication](server-communication.md#4-request-signing-authentication)). |
| `phone_number` | The phone's own number, sent with each request. |
| `phone_id`, `phone_token` | Device identity tokens sent to the server. |
| `enabled` | Master on/off switch for forwarding/sending. |
| `amqp_enabled` + `amqp_*` keys | Enable and configure the real-time AMQP connection. |
| `outgoing_interval` | Seconds between HTTP polls when no AMQP connection is active. |
| `keep_in_inbox` | If true, keep forwarded SMS/MMS in the phone inbox instead of deleting. |
| `test_mode`, `auto_add_test_number` | Test helpers that relax recipient validation. |
| `ignore_shortcodes`, `ignore_non_numeric` | Filters for which senders are "forwardable". |
| `call_notifications` | Allow forwarding incoming calls to the server. |
| `network_failover`, `wifi_sleep_policy` | Connectivity-management behaviour. |

Every key read from settings is tabulated in
[Glossary & Config Keys](glossary.md).

---

## The "expansion pack" rate limit (a neat idea)

Android's telephony stack enforces a per-app SMS sending cap (roughly 100 SMS /
hour). EnvayaSMS works *within* that limit but adds its own twist: it counts
outgoing SMS **per installed package** and round-robins across them.

Other packages ("expansion packs") register for the
`QUERY_EXPANSION_PACKS_INTENT` broadcast, answer with their package name, and in
return get permission to share — and raise — the outgoing-SMS quota. This is how
the platform stays extensible: install a pack and your effective limit grows.

Details are in [Outgoing Messages](outgoing-messages.md#5-rate-limiting-the-expansion-pack-model).

---

## Where everything lives

```
src/org/envaya/sms/
├── App.java                 # Application singleton; central state & coordination
├── IncomingMessage / Sms / Mms / Call   # Inbound message models
├── OutgoingMessage / OutgoingSms        # Outbound message models
├── QueuedMessage                           # Shared retry/backoff behaviour
├── Inbox / Outbox                        # In-memory + persistence queues
├── DatabaseHelper                          # SQLite (pending messages)
├── MessagingObserver / MessagingUtils      # Content-provider access for SMS/MMS
├── AmqpConsumer                            # Real-time RabbitMQ connection
├── receiver/        # BroadcastReceivers (boot, connectivity, alarms, retries)
├── service/         # IntentServices (AMQP consume loop, messaging checks)
├── task/            # HttpTasks: HTTP polling / forwarding / connectivity
└── ui/              # Activities & settings screens
```

See [Class Reference](class-reference.md) for a full alphabetical index.

---

## Appendix — Manifest permissions

A summary of the permissions declared in [`AndroidManifest.xml`]:

| Permission | Why it is used |
|-----------|----------------|
| `RECEIVE_SMS`, `SEND_SMS` | Forward inbound SMS / send outbound SMS. |
| `RECEIVE_MMS` | Forward inbound MMS. |
| `READ_SMS`, `WRITE_SMS` | Manage the local message store. |
| `READ_PHONE_STATE` | Identify device/line, detect incoming call number. |
| `ACCESS_NETWORK_STATE` / `ACCESS_WIFI_STATE` | Connectivity awareness & failover. |
| `WAKE_LOCK` | Keep CPU alive while sending / holding AMQP connection. |
| `RECEIVE_BOOT_COMPLETED` | Restart forwarding after reboot. |
| `INTERNET` | Reach the server. |
| `WRITE_SETTINGS` | Adjust Wi-Fi sleep policy as configured. |
