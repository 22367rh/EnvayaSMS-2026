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

## Acceptance criteria

- [ ] App requests and grants all dangerous permissions; a device without them degrades gracefully (logged, feature disabled).
- [ ] No `ForegroundServiceType`/`IllegalStateException` on API 29–33.
- [ ] Notifications appear only after `POST_NOTIFICATIONS` is granted, and are suppressed cleanly before then.

---

## Dependencies / risks

- Coordinate with Step 6 (exported components) since the permission rationale UI is an activity.
- The SMS permissions being "development-verified" means **Play Console** has extra obligations; if distribution is via sideload/ADB this is lower risk, but keep a justification screen for Play readiness.
- Do not block app startup on permission grants — gate only the features that need them (SMS forwarding, notifications).
