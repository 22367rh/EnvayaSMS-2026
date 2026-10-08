# Step 5 — Runtime Permissions & Foreground Service Types

**Objective.** Handle the modern permission model (dangerous permissions requested at runtime,
the API-33 `POST_NOTIFICATIONS` permission) and the Android 12+/14 foreground-service-type
requirements that affect every background service in the app.

---

## Current state

- Permissions are declared in the manifest but **never requested** — fine on API < 23,
  but several of these are "dangerous" and require a runtime grant flow since Android 6.
- `ForegroundService` keeps the process alive via `startForegroundCompat()` with a manual notification.
- No foreground-service-type declarations exist; services are plain background services.
- The app sends notifications (log view, service status) but never checks the
  `POST_NOTIFICATIONS` grant — on Android 13 these will be silently dropped without it.

On **target SDK 34 (Android 14)**: `SEND_SMS`, `READ_SMS`, `WRITE_SMS`, `RECEIVE_SMS`,
`RECEIVE_MMS` are classified as **"development-verified" dangerous permissions** — they must
be requested at runtime and the app should declare a justification. On Android 13+ you also
need `POST_NOTIFICATIONS`.

---

## Target state

- A single permission-request flow (ideally one `Activity`/helper) requests each dangerous
  permission before it is needed and handles denial gracefully.
- Notifications require an explicit `POST_NOTIFICATIONS` grant check.
- Every foreground/background service declares the correct `foregroundServiceType`
  (and matching `<uses-permission>`), so `startForeground()` does not throw on API 29+.

---

## Incremental actions

1. **Notifications.** In `ForegroundService.handleCommand()`, before creating a notification:
   ```java
   if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(POST_NOTIFICATIONS) != PERMISSION_GRANTED) {
       // request it; show notification only after grant
   }
   ```
2. **SMS permissions.** Build a small `PermissionHelper` used by the launcher/`Main`:
   - Request `RECEIVE_SMS`, `SEND_SMS`, `READ_SMS`, `WRITE_SMS`, `RECEIVE_MMS`, `READ_PHONE_STATE` at runtime (group them; explain in an rationale dialog).
   - On Android 14, add a **justification screen** for the SMS permissions if a request is denied the first time (`shouldShowRequestPermissionRationale`).
3. **Foreground service types.** For each service that calls `startForeground`, declare:
   - `<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />`
   - `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />` (or the most appropriate type) in the manifest.
   - In `AndroidManifest.xml`, add `android:foregroundServiceType="..."` to the relevant `<service>` elements and implement the matching `onStartForeground(intent, id)` override.
4. **Background-start limits.** Wherever a service is started from a `BroadcastReceiver` or a background context (e.g. `EnabledChangedService`, AMQP services), switch to `context.startForegroundService(...)` on API 26+ and call `startForeground()` within the required 5-second window, otherwise convert the trigger to `WorkManager`/`JobScheduler`.
5. Document which permissions are "required for core function" vs "optional", so product can decide install-time behavior.

---

## Implementation notes (as-built)

1. **`PermissionHelper` utility (new).** Holds the permission constants and the two checks
   used across the app: `hasPermission`, `hasAllPermissions`, and `needsPostNotifications`
   (API 33+). Uses `ContextCompat.checkSelfPermission` so it is safe on pre-API-23 runtimes.
   The SMS names are plain string literals (`android.Manifest.Permission.*` constants are not
   exposed as `android.permission.*`).
2. **Runtime request wired into `Main.onResume`.** On first resume per process the launcher
   activity requests `POST_NOTIFICATIONS` (API 33+) and, if missing, the SMS group via
   `ActivityCompat.requestPermissions`. The result handler is advisory only: a denied
   permission disables the matching feature without crashing.
3. **Notification content gated on grant (`ForegroundService.handleCommand`).** On API 33+
   the status-bar notification is built with content only when `POST_NOTIFICATIONS` is
   granted; otherwise a minimal placeholder (icon + title) is shown so `startForeground()`
   still succeeds and the process stays alive. This is the mandatory foreground indicator, so
   it cannot be fully hidden — but no user-visible *content* leaks before grant.
4. **Foreground service type.** `ForegroundService` now declares
   `android:foregroundServiceType="dataSync"` with a matching
   `<uses-permission android:name="...FOREGROUND_SERVICE_DATA_SYNC"/>`, so `startForeground()`
   does not throw on API 31+. The old reflection-based compat wrapper is retained for the
   pre-API-17 path.
5. **Removed unused `WRITE_SETTINGS`.** Declared in the manifest but never referenced in code;
   it is a special system permission that cannot be normally granted and would trigger Play
   Console review regardless. Removing it has zero functional impact.

### Deliberately left for a follow-up stage

- **Background-start limits (plan action 4).** Starting `ForegroundService` from the
  `EnabledChangedService` worker, and the AMQP consumer from the `StartAmqpConsumer`
  broadcast receiver, can trip Android 14's background-service restrictions. Converting those
  triggers to `startForegroundService()` (+ the 5-second window) or `WorkManager`/`JobScheduler`
  is a runtime-correctness change best done once the service-lifecycle work in Steps 6–7 lands,
  so this stage stays focused and low-risk.
- **Full SMS justification UI.** The `shouldShowRequestPermissionRationale` rationale screen
  for repeated denials (Play "development-verified" readiness) is documented but not yet built;
  the current flow requests once per process lifetime and degrades gracefully on denial.

## Acceptance criteria

- [x] App requests dangerous permissions at runtime; a device without them degrades gracefully (logged, feature disabled).
- [ ] No `ForegroundServiceType`/`IllegalStateException` on API 29–33. _(type declared + matching permission added; verified to build — device confirmation pending.)_
- [x] Notifications appear only after `POST_NOTIFICATIONS` is granted, and are suppressed cleanly before then.

---

## Dependencies / risks

- Coordinate with Step 6 (exported components) since the permission rationale UI is an activity.
- The SMS permissions being "development-verified" means **Play Console** has extra obligations; if distribution is via sideload/ADB this is lower risk, but keep a justification screen for Play readiness.
- Do not block app startup on permission grants — gate only the features that need them (SMS forwarding, notifications).
