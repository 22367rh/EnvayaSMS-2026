# Step 6 — Android 12+ Component Rules: PendingIntent Mutability, Implicit Broadcasts, Exported Flags

**Objective.** Satisfy the hard runtime requirements introduced in Android 12 (API 31) and
enforced through Android 13/14:
- Every `PendingIntent` must declare mutability flags.
- Manifest receivers cannot listen for **implicit** broadcasts.
- All components need explicit `android:exported` (partly covered in Step 2; this step fixes the *behavioral* consequences).

---

## Current state

- **PendingIntents** are created with integer-flag literals like `0` or `FLAG_ONE_SHOT`:
  - `App.setOutgoingMessageAlarm()`, `AmqpConsumer.getStartPendingIntent()` / `getHeartbeatPendingIntent()`,
    `ForegroundService.handleCommand()`, `OutgoingSmsReceiver` (per-part sent/delivery intents).
- **Implicit manifest receivers** listen for broadcasts that are *implicit* and therefore
  **no longer delivered to manifest receivers on Android 14 (API 34)**:
  - `ConnectivityChangeReceiver` → `android.net.conn.CONNECTIVITY_CHANGE`
  - `DeviceStatusReceiver` → `ACTION_POWER_CONNECTED/DISCONNECTED`, `BATTERY_LOW`, `BATTERY_OKAY`
  - `ExpansionPackInstallReceiver` → `PACKAGE_ADDED/REMOVED/REPLACED`
- Exported flags were made explicit in Step 2; the intent-filter *contents* are fine to keep.

---

## Target state

- Every `PendingIntent.*Xxx(...)` call passes an explicit, correct mutability flag:
  - Use `FLAG_IMMUTABLE` where the intent is not meant to be mutated by the target component
    (alarms, service starts) and `FLAG_IMMUTABLE | FLAG_UPDATE_CURRENT` where an update is intended.
- Implicit manifest receivers are **removed**; their work is moved to:
  - explicit (explicit-component) sends, or
  - `Context.registerReceiver()` with an exported/registered receiver scoped to a component lifetime, or
  - `ConnectivityManager.registerDefaultNetworkCallback` / `WorkManager` for connectivity & battery-style events.

---

## As-built status (this commit)

**Action #1 — PendingIntent mutability: COMPLETE.** Every `PendingIntent.*Xxx(...)` creation
site now passes an explicit mutability flag instead of a bare `0`/int literal. On Android 12+
(API 31+) creating a `PendingIntent` without an explicit mutability flag throws a `SecurityException`
and the app would crash at that call, so this is the hard, mechanical half of Step 6.

| File | Site | Flag applied |
|------|------|--------------|
| `App.java` | `setOutgoingMessageAlarm()` (outgoing poller alarm) | `FLAG_IMMUTABLE` |
| `AmqpConsumer.java` | `getStartPendingIntent()` → `StartAmqpConsumer` | `FLAG_IMMUTABLE` |
| `AmqpConsumer.java` | `getHeartbeatPendingIntent()` → `AmqpHeartbeatService` | `FLAG_IMMUTABLE` |
| `Outbox.java` | Dequeue-outgoing alarm | `FLAG_IMMUTABLE` |
| `OutgoingMessage.java` | `getTimeoutPendingIntent()` → `OutgoingMessageTimeout` | `FLAG_IMMUTABLE` |
| `QueuedMessage.java` | retry alarm | `FLAG_IMMUTABLE` |
| `CheckConnectivityTask.java` | re-enable-WiFi alarm → `ReenableWifiReceiver` | `FLAG_IMMUTABLE` |
| `OutgoingSmsReceiver.java` | per-part **sent** intent (×1) | `FLAG_IMMUTABLE \| FLAG_ONE_SHOT` |
| `OutgoingSmsReceiver.java` | per-part **delivery** intent (×1) | `FLAG_IMMUTABLE \| FLAG_ONE_SHOT` |
| `EnabledChangedService.java` | `alarmManager.cancel(...)` match for `NudgeReceiver` | `FLAG_IMMUTABLE` |
| `ForegroundService.java` | notification content `getActivity()` | already `FLAG_IMMUTABLE` (unchanged) |

> Note: the two SMS per-part intents keep `FLAG_ONE_SHOT` (they are one-shot delivery tokens) and
> simply gain `FLAG_IMMUTABLE`. The cancel() site in `EnabledChangedService` only needs a valid
> mutability flag for identity matching — `FLAG_IMMUTABLE` is correct there.

**Actions #2–#4 — Implicit-broadcast receiver conversions: DEFERRED to the next stage.**
The three manifest receivers that listen for implicit broadcasts (`ConnectivityChangeReceiver`,
`DeviceStatusReceiver`, `ExpansionPackInstallReceiver`) are **not** converted in this commit. This is a
deliberate scoping decision, not an omission:

- These conversions each require wiring runtime `registerReceiver(...)` / `NetworkCallback` to a valid
  lifecycle owner (the foreground service or a dedicated lifecycle owner) so handlers survive process
  events but are unregistered on destroy to avoid leaks. That is non-trivial and best done in isolation.
- The app's `minSdkVersion` is **21**; `ConnectivityManager.registerDefaultNetworkCallback` only exists
  from API 23, so the connectivity conversion additionally needs an SDK guard — a separate concern to
  reason about carefully rather than cramming into the PendingIntent commit.
- Manifest-declared implicit receivers do **not** fail the build or lint (they are a runtime enforcement),
  so deferring them keeps this commit zero-risk while the project stays green and compilable.

They remain listed under Target state / Incremental actions #2–#4 for the follow-up stage.

---

## Incremental actions

1. **PendingIntent mutability.** For each call site, replace the bare flag int:
   - Alarms (`setOutgoingMessageAlarm`, `AmqpConsumer.startDelayed`) → `FLAG_IMMUTABLE`.
   - Service/pending broadcasts that must be updatable → `FLAG_IMMUTABLE | FLAG_UPDATE_CURRENT` (or `FLAG_NO_CREATE` where used with `getBroadcast(..., FLAG_NO_CREATE, ...)`).
   - Per-part sent/delivery intents in `OutgoingSmsReceiver` → `FLAG_IMMUTABLE | FLAG_ONE_SHOT`.
2. **Connectivity.** Replace the `CONNECTIVITY_CHANGE` manifest receiver:
   - Register a `NetworkCallback` via `ConnectivityManager.registerDefaultNetworkCallback(...)` (or `requestNetwork`) to drive `onConnectivityChanged()`.
   - Keep an explicit broadcast only if a foreground component registers it at runtime.
3. **Battery / power events.** These implicit broadcasts cannot be received from the manifest on API 34. Register a receiver at runtime (`registerReceiver` scoped to an activity/service lifecycle) or fold battery/power handling into the existing foreground service / `WorkManager`.
4. **Package install/remove (expansion packs).** Register `ExpansionPackInstallReceiver`'s logic via a runtime `Context.registerReceiver(...)` for `PACKAGE_ADDED/REMOVED/REPLACED`, since manifest receivers for these implicit broadcasts are blocked on API 34. Keep the `QUERY_EXPANSION_PACKS_INTENT` ordered broadcast (that's an *explicit* app→pack broadcast, which is fine).
5. Run a lint/build pass to confirm no "implicit broadcast in manifest" warnings remain.

---

## Acceptance criteria

- [x] No `PendingIntent` is created with an ambiguous/zero mutability flag on API 31+. _(done this commit)_
- [ ] App builds and runs on Android 13/14 with zero "implicit broadcast" lint errors. _(deferred; manifest implicit receivers not yet removed — see As-built status)_
- [ ] Connectivity, battery/power, and package-install handling still function via runtime receivers/callbacks. _(deferred to follow-up stage — see As-built status)_

---

## Dependencies / risks

- Depends on Step 2 (exported flags) — this step fixes the *delivery mechanism* for those receivers.
- Runtime `registerReceiver` requires a valid `Context`/lifecycle; wire it to a long-lived component (the foreground service or a dedicated lifecycle owner) so handlers survive across process events but are unregistered on destroy to avoid leaks.
