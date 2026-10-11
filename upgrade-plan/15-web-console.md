# Step 15 — Web-Based Admin / Management Console (`server/node`)

**Objective.** Add an operator-facing web console on top of `server/node` so a gateway owner can
register/login, reveal the configuration their devices need to link (server URL + shared secret), and
inspect cross-device activity: battery history, message sent/received trends, an aggregated inbox/outbox,
and per-phone-number conversation timelines — all without touching the phone.

This is **Stage 15** of the modernization plan. It builds on Step 14 (the multi-tenant gateway) and adds
no new runtime dependencies: it uses only Node's built-in `http` module plus a small vanilla-JS SPA in
`public/`.

---

## Why this step exists

Step 14 gave us a working, byte-compatible, multi-tenant gateway — but provisioning tenants and
troubleshooting delivery still required editing files on the server or writing ad-hoc scripts. The console
turns `server/node` into something an operator can actually run: create accounts, hand out device
credentials, and answer "why isn't my message sending?" from a browser.

---

## Current state (before this step)

* `server/node/` serves only `/gateway.php`. There is no way to list tenants or read data without
  opening the SQLite files directly.
* Provisioning is done with `scripts/register-user.js`, which requires knowing the master key and editing
  environment variables by hand.
* No web surface exists at all; every client of the server is the Android app.

## Target state (after this step)

A single Node process serves **both**:

1. `/<user>/gateway` — the existing app protocol (unchanged, byte-compatible). The tenant is selected from
   the path segment, so the signed request URL is exactly the Server URL configured on the device.
2. `/` — a public, unauthenticated landing page describing how the gateway works and how to link devices.
3. `/console` — a dependency-free SPA plus JSON API (`/api/*`) for account management and read-only analytics.

The two are isolated: the gateway authenticates by request signature; the console authenticates by
httpOnly session cookie. A tenant's data is only ever visible to that tenant's own logged-in operator.

---

## Architecture

```
                         Browser (console)                     Android app
                              │                                      │
        ┌─────────────────────┴──────────────────────┐   POST /gateway.php?user=XYZ
        │              server.js (http)                │            X-Request-Signature
        ├───────────────┬──────────────────────────────┤         ┌──────────────┐
        │  static/       │  /api/*  (webApi.js)         │         │  gateway.js    │
        │  index.html     │  register/login/me/config/   │         │  parse tenant  │
        │  styles.css     │  devices/history/inbox/outbox/ │  ─────►│  verify sig    │
        │  app.js         │  conversations/conversation    │         │  dispatch      │
        └───────────────┴──────────────────────────────┘         └──────┬───────┘
                                                                        │ open <user>.db
                                                          createWebApi() │
                                                                  ▼       ▼
                                                        Core.db (users,   userDb.js
                                                        password_enc,     (<user>.db)
                                                        password_hash)    incoming/
                                                                          outgoing/
                                                                          device_state
```

### The pure-handler pattern (testability first)

Both the gateway (`gateway.js`) and the console API (`webApi.js`) are written as **pure functions**:

```js
const gw = createHandler({ coreDb, userDb });
const res = await gw.handle({ url, method, headers, bodyJson });
// res => { status, body /* JSON string */, setCookie /* | null */ }
```

`handle()` never touches a socket — it returns `{ status, body, setCookie }`. `server.js` is the only
place that turns that into an HTTP response and applies `setCookie` to the `Set-Cookie` header. This makes
the entire console API unit-testable without opening a listening port (see *Testing* below).

---

## Account & session model

A key design requirement was that **the website login password and the device shared secret must never be
the same value**, and that changing the login password must not break devices. This is modeled with two
independent credentials per user:

| Column | Purpose | Mutated by |
|--------|---------|------------|
| `password_enc` | AES-256-GCM ciphertext of the **device** signing secret (sealed under `GATEWAY_MASTER_KEY`). Read-only from the operator's point of view; only revealed via `/api/config`. | Never changed by the console. Devices keep working after a password change. |
| `password_hash` | scrypt hash of the **login** password for the web console. | Changed by `/api/change-password`. |

* **Registration** (`createAccount`) generates a random 24-char hex shared secret, stores it encrypted in
  `password_enc`, and hashes the chosen login password into `password_hash`. The two are unrelated.
* **Login** verifies the login password against `password_hash` only — the device secret is never checked.
* **Change-password** (`/api/change-password`) updates `password_hash` and calls
  `accounts.clearSessionsForUser(username)`, which invalidates every session token for that user, forcing
  re-login everywhere. The device secret is untouched, so already-linked devices keep signing correctly.

### Sessions

* Stored in an **in-memory map** keyed by a random 32-byte token → `{ username, expiresAt }` (7-day TTL).
* Issued on register/login as the `session` cookie (`HttpOnly`, `SameSite=Lax`, `Secure=false`).
* Cleared on logout and on password change. Destroyed lazily when expired tokens are evicted.

> The in-memory store is intentional for this environment (zero dependencies, no extra process). A
> production deployment behind multiple instances would back sessions with Redis/memcached; the API surface
> is unchanged by that swap.

---

## Endpoints

All responses are JSON. Authenticated routes return **401** (`{"error":"Not logged in."}`) when the cookie
is missing or expired — mirroring the gateway's `{"error":{"message":...}}` style.

| Method & path | Purpose |
|---------------|---------|
| `POST /api/register` | Create an account `{username,password}`; sets session cookie. |
| `POST /api/login` | Sign in; sets session cookie. |
| `GET  /api/me` | Current user profile (or 401). |
| `POST /api/logout` | Destroy session + clear cookie. |
| `POST /api/change-password` | Change only the login password (`currentPassword`,`newPassword`). Invalidates all sessions. |
| `GET  /api/config` | `{server_url, username, shared_secret}` for linking devices. |
| `GET  /api/devices` | Device registry (with last battery/network). |
| `GET  /api/history` | `{battery:[...], buckets:[...]}` — add `?range=24h\|7d\|30d\|all` and optional `?device=<phone_id>`. Hourly buckets for spans ≤ 24 h, daily otherwise. |
| `GET  /api/inbox` | Incoming messages (`?sender=&limit=`). |
| `GET  /api/outbox` | Outgoing messages (`?to=&status=&limit=`). |
| `GET  /api/conversations` | Peer list with last-message summary. |
| `GET  /api/conversation?phone=<number>` | Date-ordered timeline for a number across all devices. |

### History bucketing rule

To keep charts readable, the API chooses the time granularity from the requested span:

* **≤ 24 hours** → hourly buckets (`ts` = start-of-hour ISO string).
* **> 24 hours** → daily buckets.

The response echoes `{from,to,bucketKind}` so the frontend can render consistent axes without re-deriving
the rule.

---

## Frontend (`public/`)

A single-page app in plain ES5-ish JavaScript (no framework, no build step):

* `index.html` — shell with three views: **Login/Register**, **Dashboard**, **Settings**.
* `styles.css` — minimal, dependency-free styling; the layout is responsive and keyboard-accessible.
* `app.js` — routes on hash (`#/dashboard`, `#/settings`), talks to `/api/*`, and renders charts inline as
  SVG (a line chart for battery-over-time and grouped bars for sent/received per time bucket).

The **Dashboard** shows the device-linking config with a "reveal" control so the shared secret is not shown
until interacted with, plus the battery and message graphs. The **Inbox/Outbox** pages aggregate across all
of the operator's devices; clicking a peer opens the conversation timeline.

---

## Security & isolation notes

* **Tenant isolation.** Every console route resolves the tenant from the logged-in username (via the session
  cookie) and opens *only* that user's `<user>.db`. Cross-tenant reads are structurally impossible because
  the username is never attacker-controlled at query time — it comes from a validated session.
* **Secrets at rest.** The device shared secret stays encrypted in `Core.db` under `GATEWAY_MASTER_KEY`;
  `/api/config` decrypts it server-side and returns it once, to the authenticated operator only.
* **Password ≠ secret.** Registration guarantees two distinct values; change-password never touches the
  device secret.
* **Cookie hygiene.** `HttpOnly` prevents JS reads (mitigating XSS token theft); `SameSite=Lax` limits
  cross-site POSTs. `Secure=false` is deliberate so the console works over plain HTTP on a LAN — terminate
  TLS at a proxy for production and read `X-Forwarded-Proto`.
* **Path-traversal guard.** Static file serving rejects any path that would escape `public/`.

---

## Bugs found & fixed during this step

1. **`userDb.parseIso` double-appended `Z`.** When passed an already-ISO string it appended another
   timezone designator → "Invalid time value" inside `getMessageCountsByBucket`, silently returning no
   history buckets. Fixed by making `parseIso` idempotent (only append a designator if absent) with an
   invalid-input guard.
2. **Reserved keyword `TO`.** `getOutbox`/`getConversation` aliased `to_number AS to`; SQLite treats `TO`
   as reserved → 500 on `/api/outbox`. Fixed by quoting the alias (`AS "to"`, and `AS "from"` in the
   conversation query).
3. **`setCookie(null, true)` returned `null`.** The early `if (!token) return null` fired before the
   cleared-cookie branch, so logout never emitted a clearing cookie. Fixed by checking `cleared` first.
4. **`server.js send()` wiped `Set-Cookie`.** Calling `res.writeHead(status)` discarded headers set via
   `setHeader`, including the session cookie. Fixed by adding an `extraHeaders` param to `send()`.

---

## Testing

* **Unit/integration — `test/webApi.test.js` (10 tests).** Exercises registration, login/logout round-trips,
  session cookies, change-password invalidating sessions, config reveal (asserting the secret differs from
  the login password), per-tenant isolation of `/api/config`, and the analytics endpoints on a fresh tenant.
* **Full suite — `npm test`** runs both `gateway.test.js` and `webApi.test.js` via `node --test`: **22/22
  pass**.
* **End-to-end smoke — `npm run smoke`** still passes (gateway over a real socket).

The console API is covered without a live HTTP server because `handle()` is pure; the e2e layer covers the
socket plumbing and cookie round-trip.

---

## Files changed / added

| Path | Role |
|------|------|
| `src/webApi.js` | Pure console-API handler (`createWebApi`) — register/login/me/logout/change-password/config/devices/history/inbox/outbox/conversations/conversation. |
| `src/accounts.js` | Session store (in-memory, 7-day TTL) + password hashing/verification delegation to `coreDb`. |
| `src/coreDb.js` | Added `createAccount({username,password,sharedSecret})`, `setLoginPassword(username,newPassword)`; `getUserRowForAuth` returns the row with `password_hash`. |
| `src/server.js` | Serves static `public/` **and** `/api/*`; applies `Set-Cookie` from handler responses. |
| `public/index.html`, `styles.css`, `app.js` | Dependency-free SPA (dashboard, inbox/outbox, conversations, settings). |
| `test/webApi.test.js` | Console-API test suite. |

---

## Verification / next steps

* Confirm the console renders in a browser end-to-end: register → dashboard reveals config → link a device
  → send an SMS through the app → see it appear under Inbox and in the conversation timeline.
* Consider adding rate limiting and CSRF protection for production hardening (currently only the httpOnly
  session cookie is used).
* For multi-instance deployments, back `accounts.js` with Redis/memcached instead of the in-memory map.

---

## Follow-up iteration — console UX hardening

After Stage 15 shipped, operator feedback surfaced five concrete problems. All are fixed:

| # | Reported problem | Fix |
|---|------------------|-----|
| 1 | No way back to the home page from login/register. | Added a **← Back to home** link (links to `/`, the public landing page) on the auth shell. |
| 2 | Login showed both *Password* and *Current password*. | Removed the stray "Current password" row; login now asks only for username + password. The change-password field lives solely in Settings. |
| 3 | Registration had no confirm-password. | Added a **Confirm password** field; registration is rejected client-side if it does not match the password. |
| 4 | No email / primary contact number collected. | Registration now collects optional **email** + **primary contact number**. Backend: `Core.db` users table gained an `email` column (with idempotent migration via `ensureColumn`); `createAccount`/`createUser` store it; `/api/register` validates the email shape and passes both through; `/api/me` echoes them. |
| 5 | Dashboard was blank after login — even the *Show Device Connection Details* control was missing. | Rewrote `dashboardView()` to build its cards in order (the old code queried a `.sub` element that did not exist yet, got `null`, and threw before rendering anything). The card now carries a clear **Show device connection details** toggle that reveals server URL / username / shared secret. |

Tests: added two webApi tests covering email/phone persistence + malformed-email rejection (24/24 unit
tests pass); the console e2e (`scripts/e2e-console.js`, 13 checks) still passes end to end.
