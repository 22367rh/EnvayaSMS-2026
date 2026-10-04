# UI & Settings

The app ships with a small set of Android **activities** (screens) plus a live log
view. Everything reads/writes through the `App` singleton and its `SharedPreferences`.

---

## 1. Activity map (`AndroidManifest.xml`)

| Activity | Purpose |
|----------|---------|
| `ui/Main` | Launcher entry point; immediately forwards to `LogView`. |
| `ui/LogView` | Live log viewer + quick actions (test, check now, pending, forward). |
| `ui/Prefs` | Settings (`PreferenceActivity`, backed by `res/xml/prefs.xml`). |
| `ui/Help` | In-app help text. |
| `ui/TestPhoneNumbers` | Manage test-mode recipient numbers. |
| `ui/IgnoredPhoneNumbers` | Manage ignored senders. |
| `ui/ExpansionPacks` | Show the SMS rate-limit / expansion-pack info. |
| `ui/PendingMessages` | Inspect & retry pending inbound/outbound messages. |
| `ui/MessagingSmsInbox`, `ui/MessagingMmsInbox`, `ui/MessagingSentSms` | Browse forwarded/saved message lists (the "Forward Saved" feature). |
| `ui/MessagingForwarder` | Abstract base for the three inbox browsing activities above. |

`Main` is deliberately tiny: it just starts `LogView`. The real UI state machine is
driven by broadcasts rather than explicit navigation.

---

## 2. The live log — `LogView`

The app keeps an in-memory, bounded log buffer in `App.displayedLog` (capped at
`MAX_DISPLAYED_LOG = 8000` entries). `App.log(...)` appends to it and broadcasts
`LOG_CHANGED_INTENT`. `LogView` registers a receiver, and on change does
`TextView.append()` of only the new range for smooth updates. A `getLogEpoch()`
counter lets it cheaply detect whether a full `setText()` is needed.

`LogView` also hosts inline controls: **Test Connection** (a `TestTask`),
**Check Messages**, and links to pending messages / expansion packs / test numbers.

---

## 3. Settings screen — `Prefs`

`Prefs extends PreferenceActivity`, loaded from `res/xml/prefs.xml`. It supports
every input type via Android preference widgets:

- **EditTextPreference** — server URL, password, phone number, phone id/token.
- **ListPreference** — drop-down choices (e.g. outgoing poll interval, wifi sleep).
- **CheckBoxPreference** — booleans (`enabled`, `amqp_enabled`, `test_mode`, …).

It implements `OnSharedPreferenceChangeListener` so edits take effect immediately.

### Settings keys (summary)

Full table with defaults in [Glossary & Config Keys](glossary.md), but the
important ones:

| Category | Keys |
|----------|------|
| Connection | `server_url`, `password`, `phone_number`, `phone_id`, `phone_token` |
| Enable | `enabled`, `outgoing_interval`, `test_mode`, `auto_add_test_number` |
| AMQP | `amqp_enabled`, `amqp_host`, `amqp_port`, `amqp_ssl`, `amqp_vhost`, `amqp_user`, `amqp_password`, `amqp_queue`, `amqp_heartbeat` |
| Filters | `keep_in_inbox`, `ignore_shortcodes`, `ignore_non_numeric`, `call_notifications` |
| Network | `network_failover`, `wifi_sleep_policy` |

---

## 4. Pending messages — `PendingMessages`

Lists the current `QueuedMessage`s (inbound + outbound) with their retry status,
and offers a per-item **Retry** action that calls `retryStuckMessages()`. It listens
for `INBOX_CHANGED_INTENT` / `OUTBOX_CHANGED_INTENT` to refresh live.

---

## 5. Remote configuration

The server can reconfigure the app at runtime via the `settings` event (see
[Server Communication](server-communication.md#5-the-event-model-json)):
`JsonUtils.updateSettings()` writes values into `SharedPreferences`, then calls
`app.configuredChanged()`, which re-runs enable/disable logic — so a server can flip
`enabled` or change the poll interval without the user touching the device.

---

## 6. Broadcasts at a glance (UI coordination)

| Intent constant | Sent by | Consumed by |
|-----------------|---------|-------------|
| `LOG_CHANGED_INTENT` | `App.log()` | `LogView` |
| `INBOX_CHANGED_INTENT` | `Inbox` | `PendingMessages`, inbox UIs |
| `OUTBOX_CHANGED_INTENT` | `Outbox` | `PendingMessages` |
| `SETTINGS_CHANGED_INTENT` | `App.configuredChanged()` | UIs |
| `EXPANSION_PACKS_CHANGED_INTENT` | `App.setExpansionPacks()` | `ExpansionPacks` |

---

Next: [Server-Side Integration](server-side-integration.md), or the
[Class Reference](class-reference.md).
