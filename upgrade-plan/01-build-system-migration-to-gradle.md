# Step 1 — Build System Migration: Ant → Gradle (AGP)

**Objective.** Replace the obsolete Ant + `android-4` build tooling with a modern,
maintainable **Gradle + Android Gradle Plugin (AGP)** setup so the project can be
compiled against a current Android SDK and produce an installable APK/AAB.

---

## Current state

- Build is driven by **Ant** (`build.xml`) which imports `${sdk.dir}/tools/ant/build.xml`.
- `default.properties` / `project.properties` set `target=android-4` (API level 4, Android 1.6).
- `local.properties` supplies `sdk.dir`; the SDK is the old "Android SDK tools" r2x era.
- Third-party jars live in `libs/`: `rabbitmq-client.jar`, `httpmime-4.1.2.jar`,
  `commons-io-1.2.jar`, `commons-cli-1.1.jar`.
- No Gradle files exist anywhere in the repo.

This toolchain predates AndroidX, does not understand `compileSdkVersion`/`targetSdkVersion`
as first-class concepts, cannot resolve AAR dependencies, and cannot build for API 33+.

---

## Target state

- Project builds with **Gradle 8.x + AGP 8.x** (or a stable 7.4+ line) using the
  Android `application` plugin.
- Source sets unchanged (`src/`, `res/`, `AndroidManifest.xml`) — Gradle consumes them directly.
- Dependencies resolved from Maven Central / Google; no hand-managed jars required for the
  *platform* build (the Apache HTTP jars can be dropped entirely — see Step 3).
- `build.gradle` declares `compileSdk = 33`, `targetSdk = 33`, and a sane `minSdk`.

---

## Incremental actions

1. **Add Gradle wrapper** (`gradlew`, `gradlew.bat`, `gradle/wrapper/...`) pinned to
   Gradle 8.x so builds are reproducible. Do not commit build outputs.
2. **Create root `settings.gradle`** including the app module; create `build.gradle`
   at project root with a single Android application module.
3. **Write module `build.gradle`**:
   - `compileSdk 33`, `defaultConfig { targetSdk 33; minSdk 21; versionCode 30; versionName "3.0.1" }`.
     (Keep `versionCode`/`versionName` identical to the current manifest so this is a true drop-in.)
   - `sourceCompatibility` / `targetCompatibility = JavaVersion.VERSION_1_8` (or 11).
   - `buildFeatures { buildConfig = true }`.
4. **Port dependencies** from `libs/`:
   - Move the RabbitMQ client to a Maven dependency (`com.rabbitmq:amqp-client:<current>`) — do **not** copy the ancient jar (Step 9 refines this further).
   - Add OkHttp for Step 3 (`com.squareup.okhttp3:okhttp`).
   - Keep `commons-io` / `commons-cli` only if still referenced after a grep (they are legacy; prefer dropping them).
5. **Delete/neutralize** the Ant artifacts once Gradle builds cleanly: `build.xml`,
   `default.properties`, `project.properties`, `ant.properties`, and the old `libs/*.jar`
   as they are replaced by declared dependencies. Keep a git history note.
6. **Verify parity**: run a clean Gradle build (`./gradlew :app:assembleDebug`) and confirm
   it produces an APK equivalent to the old Ant output (same package, same version name).

---

## Acceptance criteria

- [ ] `./gradlew build` succeeds with no reference to `${sdk.dir}/tools/ant`.
- [ ] Resulting APK installs on an API 33 emulator and reports `versionName = 3.0.1`, `versionCode = 30`.
- [ ] No remaining references to the Ant build in docs or CI without migration notes.

---

## Dependencies / risks

- This step is **prerequisite** for everything else — you cannot target API 33 with Ant.
- The old `libs/*.jar` files (especially `rabbitmq-client.jar`) may not be ABI/API compatible
  with a modern `compileSdk`; replacing them via Maven is expected here and refined in Step 9.
- Do **not** yet change any Java source; this step is purely about the build so that the *current*
  code compiles under the new toolchain before we start removing deprecated APIs.
