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

- [ ] No `PendingIntent` is created with an ambiguous/zero mutability flag on API 31+.
- [ ] App builds and runs on Android 13/14 with zero "implicit broadcast" lint errors.
- [ ] Connectivity, battery/power, and package-install handling still function via runtime receivers/callbacks.

---

## Dependencies / risks

- Depends on Step 2 (exported flags) — this step fixes the *delivery mechanism* for those receivers.
- Runtime `registerReceiver` requires a valid `Context`/lifecycle; wire it to a long-lived component (the foreground service or a dedicated lifecycle owner) so handlers survive across process events but are unregistered on destroy to avoid leaks.
