# 99 — Summary of State Differences (Current → Planned)

This is the consolidated **before / after** comparison requested in the task, including an
explicit note on language and paradigm. It summarizes every step above.

---

## 1. Language & Paradigm Note

| Aspect | Current state | Future planned state |
|--------|---------------|----------------------|
| Programming language | **Java** (Android) | **Java/Kotlin** (Android) — *no change of core language required* |
| Platform | Native Android | Native Android — *no move to a cross-platform framework* |
| Build system | Ant + `android-4` tools | **Gradle + AGP 8.x** |
| Architecture style | Singleton-facade (`App`) + manual components, no DI/framework | Same pragmatic style; platform glue modernized (executors, JobIntentService, runtime permissions) |

**Conclusion: a full rewrite in a different language is neither required nor advisable.**
The app's worth is its deep integration with the Android telephony/OS. Porting to Flutter /
React Native / Capacitor would mean reimplementing low-level telephony access that only native
Android APIs expose cleanly, at far greater risk and effort, for no functional gain.

**What must change:** the *platform-interfacing layers* (HTTP, threading, services, permissions,
telephony, AMQP client, build). **What stays essentially identical:** all domain logic — event
processing (`JsonUtils`/`XmlUtils`), rate limiting / expansion packs, queue semantics
(`Inbox`/`Outbox`), retry/backoff (`QueuedMessage`), and settings handling. The **server protocol**
(JSON/XML events, request-signature scheme) and **package name** (`org.envaya.sms`) are preserved,
so the PHP server side needs no changes.

Net effect: **same app, same language family, same wire protocol — modernized runtime layer.**

---

## 2. Before → After at a glance

| # | Area | Current (2012) | Planned (Android 13+) | Doc |
|---|------|----------------|-----------------------|-----|
| 1 | Build | Ant, `target=android-4`, jars in `libs/` | Gradle + AGP 8, Maven deps, `compileSdk/targetSdk = 33` | [01](01-build-system-migration-to-gradle.md) |
| 2 | Manifest/SDK | `minSdkVersion=4`, no target, no exported flags | `targetSdk=33`, explicit `android:exported`, POST_NOTIFICATIONS | [02](02-target-sdk-manifest-and-permissions-basics.md) |
| 3 | HTTP | `org.apache.http.*` (removed in API 23 → compile failure) | OkHttp + modern TLS; identical params/signature | [03](03-http-layer-migration-from-apache-http.md) |
| 4 | Concurrency | `AsyncTask`, `IntentService` (deprecated/obsolete) | Bounded executor(s), `JobIntentService`/WorkManager | [04](04-concurrency-intentservices-and-background-services.md) |
| 5 | Permissions/services | Declared only; no runtime requests; no FS types | Runtime dangerous-perm flow, `POST_NOTIFICATIONS`, foreground-service-types | [05](05-runtime-permissions-and-foreground-service-types.md) |
| 6 | Android 12 rules | Bare-flag PendingIntents; implicit manifest receivers | Mutability flags; runtime receivers / NetworkCallback | [06](06-android-12-pendingintent-broadcasts-exported-components.md) |
| 7 | Telephony | `SmsManager.getDefault()` (deprecated) | SIM/subscription-aware manager + safe multipart send | [07](07-telephony-sms-api-upgrades.md) |
| 8 | UI helpers | `Html.fromHtml`, `getActiveNetworkInfo()`, `PreferenceActivity` | `HtmlCompat`, NetworkCapabilities, `PreferenceFragmentCompat` | [08](08-modern-ui-connectivity-helpers.md) |
| 9 | AMQP | Bundled ancient `rabbitmq-client.jar`; raw SSLContext | Official `amqp-client` + Android TLS; same protocol | [09](09-rabbitmq-amqp-client-and-tls-upgrade.md) |
| 10 | Persistence | SQLite v4, two tables | Bump to v5 with safe upgrade path; restore preserved | [10](10-persistence-db-migration.md) |
| 11 | Inbound SMS | `SMS_RECEIVED` broadcast + `abortBroadcast()` | Default-SMS-app flow **or** inbox content-provider observer | [11](11-inbound-sms-behavior-changes.md) |
| 12 | Data/settings | SharedPreferences, JSON-list encoding | Byte-compatible; safe new keys; DB restore | [12](12-data-settings-compatibility.md) |
| 13 | Testing | None automated | Unit + contract + device-matrix QA gates | [13](13-testing-and-qa-gates.md) |

---

## 3. Key behavioral changes to be aware of

1. **Inbound SMS delivery (biggest behavior change).** On Android 4.4+ only the default SMS app
   reliably receives `SMS_RECEIVED` and can `abortBroadcast()`. The app must either become the
   default SMS app or read the inbox content provider. MMS forwarding is unaffected (already on
   the content-provider path). See Step 11.

2. **Background services.** Starting background services from broadcasts is restricted; services
   that must stay alive need `startForegroundService()` + foreground-service-types, and triggers
   may move to `WorkManager`/`JobScheduler`. See Steps 4–5.

3. **Permissions are now opt-in at runtime.** SMS/MMS permissions and notifications require an
   explicit grant flow plus (on target 34) a justification screen. See Step 5.

4. **Implicit broadcasts no longer fire from the manifest** on Android 14; connectivity/battery/
   package-install handling must use runtime receivers or system callbacks. See Step 6.

5. **`org.apache.http.*` does not exist** past API 23 — this is a hard compile blocker, not a
   deprecation. OkHttp replacement is mandatory and highest priority. See Step 3.

---

## 4. What is deliberately preserved (invariants)

- Package name `org.envaya.sms`, `versionCode=30`, `versionName="3.0.1"`.
- All `SharedPreferences` keys, defaults, and the JSON string-list encoding.
- The request-signature scheme (`Base64(SHA-1(url + "," + sortedParams + "," + password))`) and param ordering.
- The server event model: `send / cancel / cancel_all / log / settings` (JSON) and legacy XML.
- Queue semantics (≤2 concurrent inbound/outbound), retry backoff schedule (20s→5min→1h→24h→give up), and the expansion-pack rate-limit algorithm.
- The SQLite schema columns (v4 → v5 migration is additive/identity).

---

## 5. Suggested execution order recap

Build (1) → Manifest/SDK (2) → HTTP transport (3, blocks all compilation) → Concurrency (4) →
Permissions & FS types (5) → Android 12 component rules (6) → Telephony SMS (7) → UI helpers (8) →
AMQP/TLS (9) → Persistence (10) → Inbound SMS behavior (11) → Data compatibility (12) → Testing (13).

Each step is independently reviewable and leaves the project in a compilable state.
