# Step 4 — Concurrency & Services: retire `AsyncTask` / `IntentService`

**Objective.** Replace the obsolete/removed threading primitives with modern equivalents:
- `AsyncTask` (marked obsolete in API 30, behavior changed) → a bounded `ExecutorService` or coroutines.
- `IntentService` (deprecated in API 30) → `JobIntentService` or a foreground service + `WorkManager`.

This preserves the "run off the main thread" and "one request at a time" semantics the app relies on.

---

## Current state

- `BaseHttpTask extends AsyncTask<String, Void, HttpResponse>` — HTTP runs on Android's
  internal thread pool; results posted back via `onPostExecute`.
- `CheckConnectivityTask extends AsyncTask<...>` similarly.
- `App.onCreate()` contains a workaround for an old `AsyncTask` class-loading bug.
- Services extend `IntentService`: `EnabledChangedService`, `CheckMessagingService`,
  `AmqpConsumerService`, `AmqpHeartbeatService`. IntentService auto-stops after
  `onHandleIntent` and processes one intent at a time — behavior the app depends on.

On Android 13 these still *compile* (they're deprecated, not removed), but:
- `AsyncTask.execute()` now uses a single serial executor by default in some lineages;
  the shared pool semantics are unreliable for long-running background work.
- `IntentService` is deprecated and its one-worker-thread model fights Android 8+
  background-service limits (see Steps 5).

---

## Target state

- A single reusable background executor (`App.httpExecutor`, a fixed/central thread pool)
  drives HTTP tasks; completion callbacks run on the main looper.
- Services use `JobIntentService` (drop-in replacement preserving one-at-a-time,
  work-queue semantics) or are converted to foreground services where they must stay alive.
- The `App.onCreate()` AsyncTask workaround is removed.

---

## Incremental actions

1. Introduce a central `Executor` in `App` (e.g. `Executors.newSingleThreadExecutor()` for
   ordered pollers, plus a cached pool for independent forwards). Keep it injectable so tests can stub it.
2. Refactor `BaseHttpTask`:
   - Remove `AsyncTask`; implement the run loop with the new executor: `execute()` submits a task that calls the existing `doInBackground()` then posts to `onPostExecute` on a `Handler(Looper.getMainLooper())`.
   - Preserve the connection-retry workaround (HTTPCLIENT-881) inside `doInBackground()`.
3. Refactor `CheckConnectivityTask` the same way.
4. Convert each `IntentService`:
   - Replace `onHandleIntent(intent)` body with `JobIntentService.enqueueWork(context, this, requestId, intent)` style dispatch, or extend `JobIntentService` and override `onHandleIntent`.
   - Ensure no work is left on the main thread (the existing code already offloads).
5. Remove the `Class.forName("android.os.AsyncTask")` workaround in `App.onCreate()`.

---

## Acceptance criteria

- [ ] No `extends AsyncTask` remains; all network work runs on the new executor(s).
- [ ] `JobIntentService` (or foreground service) processes one intent at a time, exactly as before.
- [ ] Polling still serializes correctly (`markPollComplete` gating in `App`).

---

## Dependencies / risks

- Do this **after** Step 3 (transport swap) so the executor drives OkHttp requests.
- The AMQP consume loop (`AmqpConsumer.ConsumeThread`) already uses its own `Thread`; leave that logic intact — only the *hosting* primitives change if needed.
- Watch for code that assumed `AsyncTask`'s default threading (e.g., calling `.get()`); prefer callbacks to avoid blocking.
