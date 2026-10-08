# Step 13 — Testing & Quality Gates

**Objective.** Provide a repeatable verification strategy so each incremental step can be merged
with confidence that behavior is preserved. The app's domain logic is subtle (rate limiting,
retries, dedup), so automated + manual checks are both required.

---

## Test strategy

### 1. Unit tests (fast, no device needed)
- **Signature**: pin `HttpTask.getSignature()` output for a fixed param set + password.
- **Rate limiter**: `App.chooseOutgoingSmsPackage` / `getNextValidOutgoingTime` round-robin + backoff math; expansion-pack limit = `packages * 100`.
- **Validation**: `OutgoingSms.validate()` rejects empty/invalid recipients and bodies; test-mode auto-add.
- **Forwardable logic**: `isForwardablePhoneNumber` (test mode, ignore list, shortcodes, non-numeric).
- **Event processing**: `JsonUtils.processEvent` dispatch for send/cancel/log/settings against a stubbed app.
- **DB migration**: open a v4 fixture, run `onUpgrade`, assert rows preserved (Step 10).

### 2. Integration / contract tests
- Stand up a small stub HTTP server (or reuse the PHP example) and assert:
  - Poll returns events; inbound forward posts identical params + signature header (compare to pre-migration baseline — Step 3).
  - `send_status`/`device_status` payloads are correct.
- AMQP smoke test against a local RabbitMQ if available (Step 9).

### 3. Manual / device matrix
Cover the following Android versions and note which are emulated vs physical (SMS needs hardware):

| Android | API | Purpose |
|---------|-----|---------|
| 5.1 | 22 | Baseline (minSdk target floor) |
| 8.1 | 27 | Background-service behavior |
| 10 | 29 | Foreground service types, default-SMS-app prompt |
| 12 | 31 | PendingIntent mutability, exported flags |
| 13 | 33 | Target SDK; POST_NOTIFICATIONS |
| 14 | 34 | Development-verified SMS permissions, implicit-broadcast rules |

---

## Verification checklist (per step)

- [ ] Clean build (`./gradlew :app:assembleDebug`) with zero lint errors.
- [ ] Unit tests pass; signature/param regression test green.
- [ ] App installs and launches on the emulator; settings screen loads.
- [ ] End-to-end: configure server URL → inbound SMS/MMS forwarded → server event → outbound SMS sent → status reported back.
- [ ] Reboot + battery-swap simulation: pending messages restored and retried (Step 10/12).
- [ ] No crash logs related to permissions, services, or broadcasts (`adb logcat`).

---

## Acceptance criteria

- [ ] Full automated suite green in CI on the target SDK.
- [ ] Manual E2E pass on API 33 and API 34 devices/emulators.
- [ ] Signature + wire-format diff vs. old build shows no unintended changes.

---

## Dependencies / risks

- Requires a stub server or the existing PHP example (`server/php/example`).
- SMS/MMS testing needs physical devices for an accurate picture; emulate the rest.
