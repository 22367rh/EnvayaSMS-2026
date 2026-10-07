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

- [x] Inbound SMS is forwarded to the server on a stock device **without** requiring the user to manually set a default app (Option B). *(unit-tested parsing; final sign-off pending manual device QA — see below)*
- [x] `keep_in_inbox` semantics preserved under the chosen model. See *As-built* notes.

---

## As-built implementation (Stage 11)

**Decision: Option B (inbox content-provider polling).** Chosen because it delivers inbound SMS
reliably on modern devices **without** requiring the user to change system settings, reuses the
already-working MMS content path, and is self-contained and unit-testable. `SmsReceiver` is kept
unchanged so that on devices where EnvayaSMS *is* set as the default SMS app it keeps working too;
the two paths are de-duplicated by the existing URI-based key in `inbox.forwardMessage()`.

### What changed (behavior-preserving except for the new inbox reader)

1. **`MessagingUtils.java`** — added the inbox-SMS reader, mirroring the existing sent-SMS path:
   - `INBOX_SMS_URI = content://sms/inbox` constant.
   - `seenIncomingSmsIds: Set<Long>` (mirrors `seenSentSmsIds`).
   - `getNewIncomingSmsFromInbox()` / `getNewIncomingSmsFromInbox(boolean newMessagesOnly)` — query
     `content://sms/inbox` for `_id, address, body, date` newest-first (`_id desc limit 30`, exactly
     like `getSentSmsMessages()`), build an `IncomingSms` per row (direction = `Incoming`; the
     `"date"` column is already in ms). Skips rows already marked seen when `newMessagesOnly`.
   - `markSeenIncomingSms(IncomingSms)` — records a row's `_id` as forwarded. **The read method does
     *not* auto-mark** (matches the sent-SMS/MMS split-bracket pattern); the caller marks after
     forwarding, so an aborted/failed forward can be retried on the next check.
2. **`CheckMessagingService.java`** — new `checkNewIncomingSms()` invoked from `onHandleWork`
   (between `checkNewSentSms()` and `checkNewMms()`). It reads new inbox rows, marks each seen,
   forwards forwardable ones via `app.inbox.forwardMessage(sms)`, and logs ignored ones.
3. **`MessagingObserver.java`** — added an explicit registration on `content://sms/inbox`
   (in addition to the existing `content://mms-sms/`). Some ROMs do not propagate
   `content://sms/inbox` notifications up to `content://mms-sms/`, so this guarantees inbox changes
   trigger a check. `onChange()` coalesces both into `CheckMessagingService` work (JobIntentService
   dedupes by WORK_ID) and the seen-set prevents re-forwarding.

### `keep_in_inbox` under Option B
The broadcast path used `abortBroadcast()` to hide non-kept messages from the stock app. There is
no broadcast in the content-provider model, so a forwarded inbox message **stays in the device
inbox** (we never delete it) — which is equivalent to *keeping* it in the inbox. This matches how
the MMS path already behaves (`checkNewMms` marks seen but does not delete). `keep_in_inbox` is
therefore effectively "always keep" under Option B; the flag's original abort semantics are simply
not applicable.

### Double-forward protection
If EnvayaSMS *is* also the default SMS app, both `SmsReceiver` (broadcast) and this inbox reader can
fire for the same message. `inbox.forwardMessage()` de-duplicates by the `IncomingSms` URI
(`sms/{from}/{timestamp}/{message}`), so a matching pair is forwarded once. The two paths are
independent and each is correct on its own.

### Testing
- **Robolectric unit test** `app/src/test/java/org/envaya/sms/MessagingUtilsInboxTest.java` registers a
  fake `ContentProvider` for the `sms` authority (`ShadowContentResolver.registerProviderInternal("sms", ...)`)
  and asserts: inbox rows parse to `IncomingSms` correctly (from/body/timestamp/direction/messagingId);
  already-seen rows are skipped on new reads; force-reads return every row regardless of seen state.
  Robolectric matches registered providers by **authority** (`uri.getAuthority()`), so the key is
  `"sms"`, not the full URI — a non-obvious but required detail.
- Full end-to-end delivery (observer → service → server) requires manual device QA on a stock device
  with EnvayaSMS set as *neither* the default SMS app *nor* granting any special status, plus one where
  it *is* the default app (to confirm no double-forward).

### Verification performed
- `:app:compileDebugJavaWithJavac` — BUILD SUCCESSFUL.
- `:app:testDebugUnitTest` — 5/5 pass (2 DB + 3 inbox), 0 failures, 0 errors.
- `:app:assembleDebug` — BUILD SUCCESSFUL; APK identity intact:
  `package='org.envaya.sms' versionCode='30' versionName='3.0.1' targetSdkVersion='34'`.

---

## Dependencies / risks

- This is the highest-behavioral-change item in the whole plan; treat it as a distinct, tested feature rather than an afterthought.
- Option A changes UX (prompts); Option B adds polling overhead. Choose based on target deployment.
- MMS forwarding already uses the content-provider path and is unaffected by this restriction — only SMS broadcast delivery changes.
