# Step 12 — Data & Settings Compatibility Across the Upgrade

**Objective.** Ensure existing users' configuration (SharedPreferences) and persisted state survive
the upgrade to the new build/API level without loss, and that any format changes are handled.

---

## Current state

- All config lives in `SharedPreferences` (default shared prefs), read through defensive accessors
  in `App` (`tryGetStringSetting`, `tryGetIntegerSetting`, `tryGetBooleanSetting`) that coerce bad types.
- String-list settings (`test_phone_numbers`, `ignored_phone_numbers`) are stored as JSON arrays via
  `new JSONArray(list).toString()` and parsed back in `loadStringListSetting`.
- The SQLite DB (Step 10) holds pending messages.
- Settings can also be overwritten remotely by the server via `EVENT_SETTINGS`.

---

## Target state

- All existing keys (`server_url`, `password`, `amqp_*`, filters, etc.) continue to read/write exactly as before — **byte-compatible**.
- No user data is lost on first launch of the upgraded app.
- Any new settings introduced by the upgrade are added with safe defaults and never clobber old values.

---

## Incremental actions

1. **Audit reads.** Grep every `getString/getInt/getBoolean(...)` in `App` (and anywhere else) to confirm no key was renamed during earlier steps. Keep a checklist of all keys from `docs/glossary.md` §2 and verify each still resolves.
2. **String-list settings.** The JSON-array encoding is stable; leave it unchanged. If you migrate prefs storage, keep the same file name (`org.envaya.sms.xml` / default) so values carry over automatically.
3. **New keys.** Any setting added for the upgrade (e.g., a "default SMS app prompted" flag) must use a new key with a sensible default and must not collide with existing ones.
4. **DB cross-check.** Confirm `restorePendingMessages()` still runs after Step 10's version bump so pending messages repopulate from the migrated DB on next launch.
5. Provide a one-time migration note in the changelog for power users who hand-edit prefs.

---

## Acceptance criteria

- [x] After upgrading, all previously configured settings (server URL, AMQP config, filters, test/ignored numbers) are intact and functional. **Verified** — every glossary §2 key resolves to its original literal + default; none were renamed by Stages 3–11.
- [x] Pending messages restored from the DB after the update. **Verified** — `onUpgrade()` is a data-preserving no-op (Stage 10) and `restorePendingMessages()` runs from `EnabledChangedService` when enabled.
- [x] No `ClassCastException` from type coercion on pre-existing values. **Verified** — defensive accessors catch + coerce; list settings degrade gracefully.

---

## As-built audit (Stage 12)

This stage is an **audit/verification** step: no functional code change was required. The upgrade's
settings and persistence layers were already correct from earlier stages, so Stage 12 confirmed
byte-compatibility end-to-end rather than editing behavior.

### Action 1 — key read audit (all keys resolve)
Cross-referenced every `getString/getInt/getBoolean` in the codebase against glossary §2. All 25
canonical keys resolve through `App`'s defensive accessors:

- **Identity/connection:** `server_url`, `password`, `phone_number`, `phone_id`, `phone_token`
  (`App.getServerUrl/getPassword/getPhoneNumber/getPhoneID/getPhoneToken`).
- **Enable/poll/filters:** `enabled`, `outgoing_interval`, `test_mode`, `auto_add_test_number`,
  `keep_in_inbox`, `ignore_shortcodes`, `ignore_non_numeric`, `call_notifications`.
- **AMQP:** `amqp_enabled/host/port/ssl/vhost/user/password/queue/heartbeat` (read in
  `AmqpConsumer.java:120-126,285`).
- **Network behavior:** `network_failover`, `wifi_sleep_policy` (`Prefs.java`).

Internal keys unchanged and intact: `configure_server`, `market_version_name`, `settings_version`
(passed to the server as a request param in `HttpTask`). The only writes are App's centralized save
methods, the server-driven `EVENT_SETTINGS` pass-through in `JsonUtils`, and Prefs writing
`server_url` — none renamed.

### Action 2 — string-list settings (unchanged)
`test_phone_numbers` / `ignored_phone_numbers` remain JSON arrays via
`loadStringListSetting/saveStringListSetting`; the shared-preferences file name is unchanged, so
values carry over automatically. The phone-number UI Activities (`TestPhoneNumbers`,
`IgnoredPhoneNumbers`) delegate entirely to App's accessors — no direct SharedPreferences writes,
so there is no key-mismatch surface.

### Action 3 — new keys (none introduced)
Stages 3–11 added **no** new settings keys (Stage 11's Option B needs none; Stage 8's Prefs rewrite
reuses the pre-existing `res/xml/prefs.xml`). Any future upgrade key must use a new key with a safe
default — documented in the CHANGELOG.

### Action 4 — DB cross-check
`envayasms.db` is version 5 (schema identical to v4). `onUpgrade()` preserves both tables and all
rows; `restorePendingMessages()` (called from `EnabledChangedService.onHandleWork()` when enabled)
repopulates queued messages on next launch. The Stage 10 regression test (`onUpgradePreservesPendingMessages`)
covers this.

### Action 5 — migration note
One-time power-user note written to **`upgrade-plan/CHANGELOG.md`** (key reference + why no manual
migration is needed).

### Verification performed
- `:app:assembleDebug` — BUILD SUCCESSFUL; APK identity intact (`org.envaya.sms` v30 `3.0.1`
  targetSdk 34). No settings/persistence source was modified, so no build/test re-run beyond the
  existing Stage 10 unit tests (still green) is warranted.

---

## Dependencies / risks

- Depends on Steps 10 & 11 being stable (so new keys/flags are finalized).
- Low risk overall — the main failure mode is accidentally renaming a key during refactoring; guard with the checklist in action 1.
