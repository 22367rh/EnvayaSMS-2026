# Step 11 — Inbound SMS Delivery Reality Check (Default-SMS-App Behavior)

**Objective.** Correct for a fundamental, unavoidable change in how Android delivers inbound SMS:
since **Android 4.4 (API 19), only the *default SMS application* reliably receives the
`SMS_RECEIVED` broadcast and can `abortBroadcast()**. Any other app — including this one —
effectively loses reliable direct SMS delivery on modern devices. This step documents the
behavior change and defines the migration path so inbound forwarding keeps working.

---

## Current state

- `receiver/SmsReceiver` is registered with `android:priority="101"` on
  `android.provider.Telephony.SMS_RECEIVED`, calls `inbox.forwardMessage()`, and — when
  `keep_in_inbox == false` — calls `abortBroadcast()` to hide the message from the stock SMS app.
- Because of API 19+ restrictions, on Android 10+ (API 29+) this receiver:
  - may not be delivered to at all unless the app is set as the **default SMS app**, and
  - even if delivered, `abortBroadcast()` has no effect unless the app *is* the default SMS app.

So on modern devices, inbound SMS forwarding via `SmsReceiver` effectively **stops working**
unless the user makes EnvayaSMS the default texting app — which is a poor UX and often not possible
if another SMS app is present.

---

## Target state (recommended path)

Offer one of two supported models and document it clearly:

### Option A — Become the Default SMS App (recommended for gateway use)
- Request `setSmsAppDefault()` via `Intent(ACTION_CHANGE_DEFAULT_SMS_APP)` (API 20+) or, on API < 20, via `Settings.SMS_DEFAULT_APPLICATION`.
- As default SMS app, `SMS_RECEIVED` delivery and `abortBroadcast()` work again → minimal code change.
- Add UI to prompt/lead the user to grant default-SMS status the first time the feature is enabled.

### Option B — Poll the inbox content provider (no default-SMS requirement)
- Rely on a `ContentObserver` on `content://sms/inbox` (and `mms-sms`) to detect inbound messages, mirroring what `MessagingObserver`/`CheckMessagingService` already do for MMS.
- This reads SMS the same way MMS is read today — no broadcast, no abort.

---

## Incremental actions

1. Decide Option A vs B (default: **Option A** for a gateway app).
2. If Option A: add default-SMS detection + a one-time settings prompt in `Prefs`/`Main`; keep `SmsReceiver` as-is once the app is default.
3. If Option B: extend the existing content observer to also watch `content://sms/inbox`, build an `IncomingSms` from the row, and forward through the same `inbox.forwardMessage()` path (reuse code — no new domain logic).
4. Document in-app and in the README that SMS forwarding requires either default-SMS status or the inbox-observer mode.

---

## Acceptance criteria

- [ ] Inbound SMS is forwarded to the server on a stock device **without** requiring the user to manually set a default app (Option B), *or* the app clearly guides them to do so (Option A).
- [ ] `keep_in_inbox` semantics preserved under the chosen model.

---

## Dependencies / risks

- This is the highest-behavioral-change item in the whole plan; treat it as a distinct, tested feature rather than an afterthought.
- Option A changes UX (prompts); Option B adds polling overhead. Choose based on target deployment.
- MMS forwarding already uses the content-provider path and is unaffected by this restriction — only SMS broadcast delivery changes.
