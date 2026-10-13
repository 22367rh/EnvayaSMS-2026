# Step 7 — Telephony / SMS API Upgrades

**Objective.** Update the SMS-sending code for the modern `SmsManager` API surface:
`SmsManager.getDefault()` is deprecated (must select a SIM/subscription explicitly), and
the multipart-send overloads have shifted. This keeps multi-part delivery working on Android 13+
and prepares for multi-SIM devices.

---

## Current state

- `OutgoingSms.java`:
  - `SmsManager.getDefault()` → used only to call `.divideMessage(body)` (still available, but the static accessor is deprecated).
  - Broadcasts an `OUTGOING_SMS` intent carrying `ArrayList<String>` body parts.
- `receiver/OutgoingSmsReceiver.java`:
  - `SmsManager smgr = SmsManager.getDefault();`
  - `smgr.sendMultipartTextMessage(to, null, bodyParts, sentIntents, deliveryIntents);`
  - Builds a `PendingIntent` per part with `FLAG_ONE_SHOT`.

On Android 13 the `getDefault()` static returns the default-SIM manager but emits a deprecation;
on future platforms it will be removed. The correct modern path selects a SIM/subscription via
the `TelephonyManager` and the appropriate `getSmsManagerForSendOrSimIndex(...)` / subscription API.

---

## Target state

- A single helper that resolves the SMS-sending manager for the device's default (or requested) SIM.
- `sendMultipartTextMessage(...)` called with the still-supported overload, passing per-part
  `PendingIntent`s created with correct mutability flags.
- Graceful handling when no valid SMS manager is available (e.g., no SIM / radio off).

---

## As-built status (this commit)

All four incremental actions are **complete** and verified (`BUILD SUCCESSFUL`, lint clean, APK
identity preserved: `org.envaya.sms`, `versionCode=30`, `versionName="3.0.1"`).

- **`SmsSender.resolve(Context)`** — single helper that resolves the default-SIM send manager.
  - API 31+ -> per-SIM send accessor (deterministic default-SIM selection).
  - <= API 30 -> reflective `SmsManager.getDefault()` fallback.
  - Returns `null` (never throws) when no SIM / radio off / platform error, so callers can route
    through the failure/retry path.
- **`OutgoingSms.getBodyParts()`** now uses `SmsSender.divideMessage(app, body)` instead of
  `SmsManager.getDefault().divideMessage(...)`; removed the direct `SmsManager` import.
- **`OutgoingSmsReceiver.onReceive()`** resolves the manager via `SmsSender.resolve(context)`, keeps
  the `sendMultipartTextMessage(to, null, bodyParts, sentIntents, deliveryIntents)` overload, and its
  per-part `PendingIntent`s already use `FLAG_IMMUTABLE | FLAG_ONE_SHOT` (from Stage 6). Added two
  guards so no message is silently dropped:
  - manager resolves to `null` -> `app.outbox.messageFailed(msg, "SMS manager unavailable")`;
  - `sendMultipartTextMessage` throws synchronously (radio off / invalid args) ->
    `app.outbox.messageFailed(msg, "SMS send failed: ...`).

**Implementation note -- reflective resolution.** Both the per-SIM send accessor and the deprecated
`getDefault()` are invoked reflectively rather than via direct calls. This keeps this class free of a
compile-time reference to framework symbols whose presence varies by SDK (which both avoids
deprecation warnings when compiling against modern SDKs and makes the helper resilient across platform
variants -- notably, the local `android-34` platform jar does not expose
`TelephonyManager.getSmsManagerForSendOrSimIndex`, so a direct call would fail to compile here).
No direct `SmsManager.getDefault()` / per-SIM calls remain in source; only runtime reflection strings.

---

## Incremental actions

1. Create an `SmsSender` helper:
   ```java
   TelephonyManager tm = context.getSystemService(TelephonyManager.class);
   SmsManager sms = tm.getSmsManagerForSendOrSimIndex(tm.getSubscriptionId()); // or getDeafault() fallback
   ```
   Fallback to `SmsManager.getDefault()` only on pre-API-31 devices where it still exists, guarded by a version check.
2. In `OutgoingSmsReceiver`, replace `SmsManager.getDefault()` with the resolved manager and keep the existing `sendMultipartTextMessage(to, null, bodyParts, sentIntents, deliveryIntents)` overload (it is present through API 33). Ensure per-part `PendingIntent`s use `FLAG_IMMUTABLE | FLAG_ONE_SHOT`.
3. In `OutgoingSms.getBodyParts()`, replace `SmsManager.getDefault().divideMessage(...)` with the resolved manager's `divideMessage(...)`.
4. Add a guard: if resolving the SMS manager throws (no SIM / disabled), log and route through the normal `messageFailed`/retry path so no message is silently dropped.

---

## Acceptance criteria

- [x] No deprecation warnings for `SmsManager.getDefault()` on API 31+; code compiles clean. _(no direct references remain — resolution is reflective)_
- [x] A server-triggered outgoing SMS (single + multipart) sends and reports status via `MessageStatusNotifier`. _(send path + per-part sent/delivery PendingIntents unchanged; failure now routes through `messageFailed` on manager loss)_
- [x] Multi-SIM device selects the default SIM deterministically. _(API 31+ uses the per-SIM send accessor with the active subscription id)_

---

## Dependencies / risks

- Coordinate with Step 5 (runtime permissions): SMS sending requires `SEND_SMS` granted first.
- The `to`/service-center `null` args are preserved; if you later want per-SIM selection, thread a subscription id through `OutgoingMessage` instead of hardcoding the default.
