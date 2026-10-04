# Upgrade Plan — EnvayaSMS → Android 13+ (API 33+)

This directory contains an **ordered, incremental** plan for taking the 2012-era
EnvayaSMS application (`org.envaya.sms`, `minSdkVersion = 4`, Ant build) and making
it run correctly on **Android 13 / API level 33 and above**.

The steps are ordered so that each one is independently reviewable, builds on the
previous ones, and leaves the project in a compilable state at the end of as many
steps as possible. Follow them top to bottom.

---

## TL;DR — what actually has to change

| # | Area | Why it breaks on Android 13+ | Affected code |
|---|------|------------------------------|---------------|
| 1 | Build system | Ant + `android-4` build tools are obsolete and unmaintainable | `build.xml`, `default.properties`, `project.properties` |
| 2 | Target/compile SDK | Must target API 33+ to be installable/distributable | `AndroidManifest.xml`, `uses-sdk` |
| 3 | HTTP stack | `org.apache.http.*` was **removed** from the platform in Android 6 (API 23) | `App`, `BaseHttpTask`, `HttpTask`, `PollerTask`, `ForwarderTask`, `IncomingMms`, `JsonUtils`, `XmlUtils`, `DeviceStatusReceiver`, `LogView` |
| 4 | Concurrency | `AsyncTask` is obsolete (API 30); `IntentService` deprecated (API 30) | `BaseHttpTask`, `CheckConnectivityTask`, all `service/*` |
| 5 | Background services | Starting background services from broadcasts is restricted; foreground-service types required | `ForegroundService`, `EnabledChangedService`, `CheckMessagingService`, AMQP services |
| 6 | Telephony SMS API | `SmsManager.getDefault()` deprecated → must select SIM/subscription explicitly | `OutgoingSms`, `OutgoingSmsReceiver` |
| 7 | Inbound SMS delivery | Since Android 4.4 (API 19) only the **default SMS app** reliably receives `SMS_RECEIVED` + can `abortBroadcast()` | `receiver/SmsReceiver` |
| 8 | Runtime permissions | SMS/MMS perms are "dangerous"; notifications need `POST_NOTIFICATIONS`; declared+justified on target 34 | manifest + `App`/UI |
| 9 | Android 12 components | `PendingIntent` mutability flags required; explicit `android:exported`; no implicit manifest receivers | every `<receiver>`/`<service>`, all `PendingIntent.*` calls |
| 10 | AMQP client + TLS | Bundled `rabbitmq-client.jar` is ancient; old Apache SSL helpers are gone | `AmqpConsumer`, `libs/rabbitmq-client.jar` |
| 11 | UI helpers | `Html.fromHtml`, `getActiveNetworkInfo()`, `PreferenceActivity` deprecated/removed | `Help`, `LogView`, `App`, `Prefs` |
| 12 | Persistence | DB is v4; new target SDK forces schema/version review + migration path | `DatabaseHelper` |

See **`99-summary-state-differences.md`** for the full before → after comparison,
including a language/paradigm note.

---

## Language & rewrite assessment (important)

**A different programming language is *not* required.** The entire application can
and should remain on the native Android platform in **Java (or Kotlin)**. Rewriting
in a cross-platform framework (Flutter / React Native / Capacitor) would be a far
larger, riskier effort and provides no benefit here — the app's value is its tight
integration with the Android telephony stack, which only native code accesses cleanly.

What **is** required is a substantial **refactor of the platform-interfacing layers**
while preserving the domain logic:

- **Keep as-is (pure logic):** event model (`JsonUtils`/`XmlUtils` processing), rate-limiting / expansion-pack algorithm, queue semantics (`Inbox`/`Outbox`), retry/backoff math (`QueuedMessage`), settings-key handling. These are transport/framework agnostic and move over verbatim.
- **Rewrite (framework glue):** HTTP client, SMS sending, broadcast receivers, services, notifications, permission handling, build system.

So the net effect is: **same language family (Java/Kotlin on Android), same package
name and server protocol, but a modernized runtime layer.** The server-side PHP and
the JSON/XML event wire format stay byte-compatible, so no backend changes are needed.

---

## How to read this plan

Each document below follows the same structure:

- **Objective** — what this step delivers.
- **Current state** — where things are now (with file/line pointers).
- **Target state** — what "done" looks like.
- **Incremental actions** — ordered, reviewable tasks.
- **Acceptance criteria** — how to verify the step is complete and safe.
- **Dependencies / risks** — what must happen before or after, and pitfalls.

### Ordered steps

1. [`01-build-system-migration-to-gradle.md`](01-build-system-migration-to-gradle.md) — abandon Ant; adopt Gradle + AGP.
2. [`02-target-sdk-manifest-and-permissions-basics.md`](02-target-sdk-manifest-and-permissions-basics.md) — target API 33+, manifest permission model, exported flags.
3. [`03-http-layer-migration-from-apache-http.md`](03-http-layer-migration-from-apache-http.md) — replace the removed `org.apache.http.*` stack with OkHttp (+ TLS).
4. [`04-concurrency-intentservices-and-background-services.md`](04-concurrency-intentservices-and-background-services.md) — retire `AsyncTask`/`IntentService`; move to executors + JobIntentService/WorkManager.
5. [`05-runtime-permissions-and-foreground-service-types.md`](05-runtime-permissions-and-foreground-service-types.md) — dangerous SMS/notification permissions, foreground service types & declarations.
6. [`06-android-12-pendingintent-broadcasts-exported-components.md`](06-android-12-pendingintent-broadcasts-exported-components.md) — PendingIntent mutability, implicit-broadcast ban, explicit exported components.
7. [`07-telephony-sms-api-upgrades.md`](07-telephony-sms-api-upgrades.md) — `SmsManager` SIM/subscription selection and multipart-send overloads.
8. [`08-modern-ui-connectivity-helpers.md`](08-modern-ui-connectivity-helpers.md) — `HtmlCompat`, NetworkCapabilities, PreferenceFragmentCompat.
9. [`09-rabbitmq-amqp-client-and-tls-upgrade.md`](09-rabbitmq-amqp-client-and-tls-upgrade.md) — modern RabbitMQ client + TLS context.
10. [`10-persistence-db-migration.md`](10-persistence-db-migration.md) — DB version bump, schema review, migration path.
11. [`11-inbound-sms-behavior-changes.md`](11-inbound-sms-behavior-changes.md) — default-SMS-app reality for `SMS_RECEIVED`/`abortBroadcast()`.
12. [`12-data-settings-compatibility.md`](12-data-settings-compatibility.md) — preserve user settings & DB across the upgrade (SharedPreferences + schema v4→v5).
13. [`13-testing-and-qa-gates.md`](13-testing-and-qa-gates.md) — test matrix, CI, manual verification checklist.
14. [`99-summary-state-differences.md`](99-summary-state-differences.md) — full before/after state comparison + language note (the deliverable the task specifically asks for).
