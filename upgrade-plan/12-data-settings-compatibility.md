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

- [ ] After upgrading, all previously configured settings (server URL, AMQP config, filters, test/ignored numbers) are intact and functional.
- [ ] Pending messages restored from the DB after the update.
- [ ] No `ClassCastException` from type coercion on pre-existing values.

---

## Dependencies / risks

- Depends on Steps 10 & 11 being stable (so new keys/flags are finalized).
- Low risk overall — the main failure mode is accidentally renaming a key during refactoring; guard with the checklist in action 1.
