# Step 8 — Modern UI & Connectivity Helpers

**Objective.** Replace deprecated/removed helper APIs used in the UI and connectivity code:
`Html.fromHtml`, `ConnectivityManager.getActiveNetworkInfo()`, and `PreferenceActivity`.
These are not compile-blockers on API 33 (they're deprecated), but they produce warnings,
may be removed later, and should be modernized for correctness.

---

## Current state

| Location | Deprecated/removed API | Notes |
|-----------|------------------------|-------|
| `ui/Help.java`, `ui/LogView.java` | `android.text.Html.fromHtml(String)` | Removed the 2-arg form long ago; the single-arg form is deprecated. |
| `App.asyncCheckConnectivity()` / `onConnectivityChanged()` | `ConnectivityManager.getActiveNetworkInfo()` | Deprecated in API 31; replaced by `getNetworkCapabilities`/`registerDefaultNetworkCallback`. |
| `ui/Prefs.java` | `PreferenceActivity` | Deprecated since API 26; replaced by `PreferenceFragmentCompat`. |

---

## Target state

- Rich-text rendering via `androidx.core.text.HtmlCompat.fromHtml(...)`, which works on all
  supported API levels and returns a `Spanned`.
- Connectivity queries use `ConnectivityManager.getNetworkCapabilities(connectivityManager.getActiveNetwork())`
  (or the `NetworkCallback` from Step 6) instead of the deprecated `getActiveNetworkInfo()`.
- Settings UI migrated to `PreferenceFragmentCompat` (AndroidX), preserving all existing keys/defaults.

---

## Incremental actions

1. **Html.** Replace `Html.fromHtml(text)` with `HtmlCompat.fromHtml(text, Compat.FROM_HTML_MODE_COMPACT)` in `Help` and `LogView`. Add `androidx.core:core` (already pulled by AndroidX).
2. **Connectivity.** In `App`, swap `NetworkInfo active = cm.getActiveNetworkInfo()` for:
   ```java
   Network net = cm.getActiveNetwork();
   NetworkCapabilities caps = net == null ? null : cm.getNetworkCapabilities(net);
   boolean connected = caps != null && caps.hasCapability(NET_CAPABILITY_INTERNET);
   ```
   Update any `networkInfo.getTypeName()`/`getState()` usage to the capabilities model.
3. **Prefs.** Convert `Prefs extends PreferenceActivity` to `Prefs extends AppCompatActivity` (or `PreferenceFragmentCompat`) hosting a `PreferenceFragmentCompat` inflated from `res/xml/prefs.xml`. Keep `res/xml/prefs.xml` unchanged in semantics; adjust only if switching preference types is needed.

---

## Acceptance criteria

- [ ] No deprecated `Html.fromHtml` / `getActiveNetworkInfo` calls remain (verify with lint).
- [ ] Settings screen renders identically and reads/writes the same `SharedPreferences` keys.
- [ ] Connectivity detection still triggers failover correctly.

---

## Dependencies / risks

- Low risk, self-contained; can be done after Steps 3–7.
- If you skip the `PreferenceActivity` migration for time, at minimum confirm it still compiles against the AndroidX preference library (add `androidx.preference:preference`).
