# Step 2 — Target SDK, Manifest & Basic Permission Model

**Objective.** Move the manifest off `minSdkVersion = 4` to a modern target/compile SDK,
and fix the *structural* manifest requirements that Android 12+ (API 31+) and later make
mandatory: explicit exported flags and a correct permission model. This is a low-risk,
high-value step that must happen early because it changes the manifest shape for later steps.

---

## Current state

- `AndroidManifest.xml`: `package="org.envaya.sms"`, `uses-sdk android:minSdkVersion="4"`.
  No `targetSdkVersion` / `compileSdkVersion` (Ant inferred these).
- Permissions declared but none requested at runtime; several are "dangerous".
- Every `<receiver>`/`<service>`/`<activity>` lacks `android:exported`; those with an
  intent-filter implicitly rely on the pre-API-31 default of `exported="false"` being *wrong*.
- Implicit manifest receivers listen for broadcasts like `CONNECTIVITY_CHANGE`,
  `ACTION_POWER_CONNECTED`, `BATTERY_LOW`, `PACKAGE_ADDED/REMOVED` — **implicit** broadcasts.

---

## Target state

- `compileSdkVersion = 33`, `targetSdkVersion = 33`, `minSdkVersion` raised to a still-reasonable floor (e.g. 21) so we keep broad device coverage while dropping pre-Lollipop support that can't run the modern APIs anyway.
- All components carry an explicit `android:exported` value consistent with whether they declare an intent-filter.
- Permissions are declared and, for dangerous ones, requested at runtime (Step 5).
- The manifest is validated against AndroidX/AGP lint with zero blocking errors.

---

## Incremental actions

1. Set `uses-sdk`: `<uses-sdk android:minSdkVersion="21" android:targetSdkVersion="33" />` and drop the Ant-inferred values. Keep `versionCode=30 / versionName 3.0.1`.
2. Add explicit `android:exported`:
   - Activities with intent-filters → `true`.
   - Receivers with an intent-filter (e.g. `SmsReceiver`, `NudgeReceiver`, `ConnectivityChangeReceiver`, `DeviceStatusReceiver`, `ExpansionPackInstallReceiver`) → `true` (they must be exported to receive system broadcasts).
   - Receivers **without** a filter (`DequeueOutgoingMessageReceiver`, `OutgoingMessageRetry`, etc., used via `AlarmManager`) → `false`.
   - Services → `false` unless they must be bound externally.
3. Add `<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />` (the API-33 notification permission; note the exact casing — it is uppercase, unlike older names).
4. Audit each declared permission against actual usage and keep only what is needed:
   `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`, `CHANGE_NETWORK_STATE`, `CHANGE_WIFI_STATE`, `READ_PHONE_STATE`, `RECEIVE_SMS`, `SEND_SMS`, `READ_SMS`, `WRITE_SMS`, `RECEIVE_MMS`, `WAKE_LOCK`, `RECEIVE_BOOT_COMPLETED`, `INTERNET`, `FOREGROUND_SERVICE` (+ specific FS types in Step 5), and `SETTINGS` (for the existing `WRITE_SETTINGS` Wi-Fi policy).
5. Run Android Studio / `lint` and resolve all "missing exported" and "permission" warnings.

---

## Acceptance criteria

- [ ] Manifest has no component lacking an explicit `android:exported`.
- [ ] Lint reports no "Missing application:exported" or fatal errors.
- [ ] `targetSdkVersion = 33` is set; app still launches on the emulator.

---

## Dependencies / risks

- This step only touches the **manifest and build config** — no Java changes yet, so it's safe to do before refactoring logic.
- Raising `minSdkVersion` reduces the installable base but is necessary: APIs used by the modernized code (OkHttp 4.x, modern RabbitMQ client) require API 21+.
- Do **not** yet remove implicit manifest receivers — that restriction is handled in Step 6. This step only makes exported flags explicit and sets the permission/SDK baseline.
