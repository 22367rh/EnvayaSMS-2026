# Migration Note — Data & Settings Compatibility (Android 13 modernization)

**For power users who hand-edit `SharedPreferences`.** One-time, applies once when upgrading an
existing EnvayaSMS installation to the Android 13 / API 34 build. After this upgrade nothing about
how settings are stored changes, so **no manual migration is required** — your existing
`org.envaya.sms.xml` preferences and `envayasms.db` load exactly as before.

## Why it's safe

- **SharedPreferences keys are unchanged.** Every key the app reads (`server_url`, `password`,
  `phone_number`, `amqp_*`, filters, …) is written and read with the exact same string literals and
  defaults as before. The defensive accessors in `App` (`tryGetStringSetting`, `tryGetIntegerSetting`,
  `tryGetBooleanSetting`) still coerce bad types, so a value stored under one type is transparently
  fixed on next read — no `ClassCastException`.
- **String-list settings are byte-compatible.** `test_phone_numbers` and `ignored_phone_numbers`
  remain JSON arrays (`new JSONArray(list).toString()`) under the same keys. The file name
  (`org.envaya.sms.xml`, the default shared-preferences file) is unchanged, so values carry over
  automatically on first launch.
- **Pending messages survive the database upgrade.** `envayasms.db` was bumped from version 4 to
  version 5 (schema identical — only `INTEGER`/`VARCHAR`/`TEXT` columns). The previous
  `onUpgrade()` silently dropped both tables on every major update; it is now a **data-preserving
  no-op**. On next launch, enabled messages are repopulated from the migrated DB via
  `restorePendingMessages()`.

## What you can safely hand-edit (key → meaning)

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `server_url` | string | `""` | Base URL; empty = "not configured". Pref UI may prefix `http://`. |
| `password` | string | `""` | Shared secret that signs every request. |
| `phone_number` / `phone_id` / `phone_token` | string | `""` | Identity sent to the server. |
| `enabled` | bool | `false` | Master switch. |
| `outgoing_interval` | int | `0` | Poll interval (s) when no AMQP connection; `0` disables polling. |
| `test_mode` / `auto_add_test_number` | bool | `false` | Test-mode behavior. |
| `keep_in_inbox` / `ignore_shortcodes` / `ignore_non_numeric` / `call_notifications` | bool | `false` | Forwarding filters. |
| `network_failover` | bool | `false` | Toggle Wi-Fi when the host is unreachable. |
| `amqp_enabled` / `amqp_host` / `amqp_port` / `amqp_ssl` / `amqp_vhost` / `amqp_user` / `amqp_password` / `amqp_queue` / `amqp_heartbeat` | mixed | see app | Real-time RabbitMQ connection. |
| `wifi_sleep_policy` | string | `"screen"` | Wi-Fi sleep behavior (see the Prefs screen). |
| `test_phone_numbers` / `ignored_phone_numbers` | JSON array | — | Managed through the app's phone-number screens; do not edit by hand. |

Internal keys (`configure_server`, `market_version_name`, `settings_version`) are used by the app and
need no attention. The server can also overwrite settings remotely via `EVENT_SETTINGS`; those writes
use the same keys above.

## If something looks wrong after upgrade

1. Confirm your existing `org.envaya.sms.xml` is present (it is, by default) — no copy step needed.
2. Check the in-app log for type-coercion messages; the accessors recover from these automatically.
3. Verify pending messages repopulated: enable the feature and confirm queued items clear as they
   forward. If a message never leaves the queue it was likely already delivered — not data loss.

No keys were renamed, added, or removed by this upgrade, so no migration script is required.
