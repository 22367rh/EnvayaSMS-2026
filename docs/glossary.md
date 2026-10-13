# Glossary & Config Keys

Reference tables for terms and every settings key read by the app.

---

## 1. Glossary

| Term | Meaning |
|------|---------|
| **Expansion pack** | A package that registers for `QUERY_EXPANSION_PACKS_INTENT`; it shares and raises the outgoing-SMS rate limit. |
| **Forwardable** | A sender whose messages EnvayaSMS will forward, per ignore/test rules. |
| **Inbox** | In-memory (+ SQLite) queue of inbound messages awaiting forwarding. |
| **Outbox** | In-memory (+ SQLite) queue of server-requested outgoing messages. |
| **Polling** | Periodic HTTP `action=outgoing` request to fetch server events. |
| **QueuedMessage** | Base class adding retry/backoff + persistence to a message. |
| **Rate limit** | Per-app SMS cap (~100/hr) shared across expansion packs. |
| **Server id** | Identifier the server assigns; used for `cancel`/`send_status`. |
| **Test mode** | Relaxes recipient validation so testers can send to any number. |
| **AMQP consumer** | Persistent RabbitMQ connection for real-time delivery. |

---

## 2. Settings keys

All read through `App`'s defensive accessors (`tryGetStringSetting`, etc.) from
Android `SharedPreferences`. Defaults shown where the code supplies them.

### Connection & identity

| Key | Type | Default | Read by / used for |
|-----|------|---------|--------------------|
| `server_url` | string | `""` | **Required.** Base URL for all HTTP. If empty, app is "not configured". |
| `password` | string | `""` | Shared secret; signs every request. |
| `phone_number` | string | `""` | Sent as `phone_number`; used as default `from`. |
| `phone_id` | string | `""` | Device id sent to server. |
| `phone_token` | string | `""` | Device token sent to server. |

### Enable & poll

| Key | Type | Default | Used for |
|-----|------|---------|----------|
| `enabled` | bool | `false` | Master switch; drives enable/disable side effects. |
| `outgoing_interval` | int | `0` | Seconds between HTTP polls when no AMQP connection. `0` disables polling. |
| `test_mode` | bool | `false` | Allow sending to any recipient (adds test numbers). |
| `auto_add_test_number` | bool | `false` | Auto-add invalid-but-test recipients instead of rejecting. |

### Filters

| Key | Type | Default | Used for |
|-----|------|---------|----------|
| `keep_in_inbox` | bool | `false` | Keep forwarded SMS/MMS in the phone inbox rather than deleting. |
| `ignore_shortcodes` | bool | `false` | Don't forward short (<7 digit) numbers. |
| `ignore_non_numeric` | bool | `false` | Don't forward non-numeric senders. |
| `call_notifications` | bool | `false` | Forward incoming-call notifications. |

### AMQP (real-time)

| Key | Type | Default | Used for |
|-----|------|---------|----------|
| `amqp_enabled` | bool | `false` | Master switch for the real-time connection. |
| `amqp_host` | string | — | RabbitMQ host. |
| `amqp_port` | int | `0` | RabbitMQ port. |
| `amqp_ssl` | bool | `false` | Use SSL/TLS. |
| `amqp_vhost` | string | — | AMQP virtual host. |
| `amqp_user` | string | — | Username. |
| `amqp_password` | string | — | Password. |
| `amqp_queue` | string | — | Queue to consume. |
| `amqp_heartbeat` | int | `300` | AMQP heartbeat interval (seconds). |

### Network behaviour

| Key | Type | Default | Used for |
|-----|------|---------|----------|
| `network_failover` | bool | `false` | Toggle Wi-Fi radio when the host is unreachable. |
| `wifi_sleep_policy` | list | — | Controls whether Wi-Fi sleeps (see `Prefs`). |

---

## 3. App-wide constants (`App`)

| Constant | Value / meaning |
|----------|-----------------|
| `MAX_DISPLAYED_LOG` | `8000` — in-memory log cap. |
| `LOG_TIMESTAMP_INTERVAL` | `30000` ms — timestamp cadence in the log. |
| `HTTP_CONNECTION_TIMEOUT` | `10000` ms. |
| `HTTP_SOCKET_TIMEOUT` | `60000` ms. |
| `MESSAGE_SEND_TIMEOUT` | `30000` ms — outgoing send timeout safety net. |
| `OUTGOING_SMS_MAX_COUNT` | `100` — per-app SMS cap (matches Android's SMSDispatcher). |
| `OUTGOING_SMS_CHECK_PERIOD` | ~1 hour — sliding window for rate limiting. |
| `DISABLE_WIFI_INTERVAL` | 1 hour — how long Wi-Fi stays off during failover. |
| `CONNECTIVITY_FAILOVER_INTERVAL` | `900000` ms — min time between wifi/mobile toggles. |

---

## 4. Actions & events (server API)

| Name | Value | Direction |
|------|-------|-----------|
| `ACTION_INCOMING` | `incoming` | app → server |
| `ACTION_FORWARD_SENT` | `forward_sent` | app → server |
| `ACTION_OUTGOING` | `outgoing` | server → app (poll) |
| `ACTION_SEND_STATUS` | `send_status` | app → server |
| `ACTION_DEVICE_STATUS` | `device_status` | app → server |
| `ACTION_AMQP_STARTED` | `amqp_started` | app → server |
| `ACTION_TEST` | `test` | app → server |
| `EVENT_SEND` / `CANCEL` / `CANCEL_ALL` / `LOG` / `SETTINGS` | send/cancel/cancel_all/log/settings | server → app |

---

## 5. Retry schedule (backoff)

| Attempt number | Delay before retry |
|----------------|--------------------|
| 1st | 20 s |
| 2nd | 5 min |
| 3rd | 1 h |
| 4th | 24 h |
| 5th | give up (logged) |

---

## 6. Message types

`sms`, `mms`, `call` — the three `MESSAGE_TYPE_*` values stored in the database and
used to reconstruct message objects on restore.
