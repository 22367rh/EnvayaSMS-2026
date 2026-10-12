# EnvayaSMS Gateway — Node.js implementation

A drop-in replacement for `server/php` that runs on **Node 22.5+** with **zero runtime dependencies**.
It is a multi-tenant HTTP gateway: one server instance serves the whole EnvayaSMS platform, and each
user's data is isolated in its own SQLite database file.

This implementation speaks the **exact same wire protocol** as the original PHP server — request
signatures, JSON/XML responses, action names, and field names are byte-compatible, so **no change to
the Android app is required**.

---

## Table of contents

- [Architecture & multi-tenancy](#architecture--multi-tenancy)
- [Signature scheme (authentication)](#signature-schemeauthentication)
- [Data model](#data-model)
- [Endpoints & actions](#endpoints--actions)
- [Web admin console](#web-admin-console)
- [Quick start](#quick-start)
- [Configuring the Android app](#configuring-the-android-app)
- [Configuration reference](#configuration-reference)
- [Manual testing without the phone](#manual-testing-without-the-phone)
- [Testing](#testing)
- [Notes, limitations & migration from PHP](#notes-limitations--migration-from-php)

---

## Architecture & multi-tenancy

The server keeps **two classes of storage**:

| Storage | File(s) | Contents |
|---------|---------|----------|
| **Core database** (`Core.db`) | one shared file | tenant identities: `username`, the **encrypted** signing secret, phone number, and profile. |
| **Per-tenant databases** (`<user>.db`) | one SQLite file per user | all messaging & device data for that user only — device registry, incoming/outgoing message queues, send-status log, AMQP session registry. |

```
Core.db                          XYZ.db            ABC.db
┌───────────────┐   tenant #1    ┌───────────────┐  ┌───────────────┐
│ users         │                │ device_state  │  │ device_state  │
│  • XYZ        │  ───────────►  │ incoming_msgs │  │ incoming_msgs │
│  • ABC        │   isolation    │ outgoing_msgs │  │ outgoing_msgs │
└───────────────┘   (no cross-   send_status_log │  │ send_status_log │
                     tenant can   gateways        │  └───────────────┘
                     see another) └───────────────┘
```

**Why the signing secret lives in `Core.db`, not `<user>.db`.** To verify a request's signature the
server must know the user's plaintext password, but it only learns the username *after* parsing the
request. If the per-tenant DB were opened first to look up the secret, probing arbitrary usernames
would reveal which tenants exist (a database-open error for unknown users vs. an auth error for known
ones). Storing the **encrypted** secret in `Core.db` lets the server authenticate *any* tenant with a
constant-time-ish lookup and return the same `"Invalid password"` response regardless — no user
enumeration. The plaintext is only ever materialized briefly to compute the SHA1 signature, then
discarded.

### Username routing (path-based, zero client changes)

The username is carried in the **request path**, e.g.:

```
POST http://gateway.example/XYZ/gateway
```

A request must look exactly like `/<username>/gateway`; anything else (missing segment, extra
segments, or a traversal attempt) returns **HTTP 403**. Because the Android app signs the *entire*
URL — including this path — the client simply uses `http://<host>:<port>/<user>/gateway` as its Server
URL. The username is excluded from the signed POST body; it only selects which tenant's database handles
the request, so no protocol change is required on the app side.

---

## Signature scheme (authentication)

Every authenticated request carries an `X-Request-Signature` header computed by the client as:

```
signature = Base64( SHA1( url + "," + sortedParams + "," + password ) )
```

where:

* `url` — the full request URL **including the path** (e.g. `http://host/XYZ/gateway`). The server
  reconstructs this from the incoming `Host` header and request path, so it must match what the client
  signed. There is no query string to append.
* `sortedParams` — every POST body parameter as `name=value`, with parameters sorted **ascending by name**
  (matching PHP's `ksort`). They are joined with `,`.
* `password` — the app's plaintext `password` setting for that tenant, appended after a trailing comma.

Example: signing `{action:"incoming", from:"1555"}` with password `rosebud` over
`http://h/XYZ/gateway` produces the input string
`http://h/XYZ/gateway,action=incoming,from=1555,rosebud`.

The server recomputes this value from the request and compares it to the header. A mismatch returns
**HTTP 403** with `{"error":{"message":"Invalid password"}}` — the same body the PHP server returned.

---

## Data model

### Core.db — `users`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | auto-increment |
| `username` | TEXT UNIQUE | tenant identifier (also the `<user>.db` filename stem) |
| `password_enc` | BLOB | AES-256-GCM ciphertext of the shared secret, sealed with a key derived from `GATEWAY_MASTER_KEY` |
| `phone_number` | TEXT | profile field |
| `created_at` | INTEGER | epoch-ms creation time |
| `active` | INTEGER | soft-delete flag (1 = active) |

### `<user>.db` — per-tenant tables

* **`device_state`** — one row per device: `phone_id`, `phone_token`, `phone_number`, `device_status`, `network`, `last_seen`.
* **`incoming_messages`** — messages the app reported (`action=incoming`): `sender`, `to`, `message_type`, `body`, `mms_parts` (JSON), `timestamp`, `received_at`.
* **`outgoing_messages`** — queued outbound messages polled via `action=outgoing`: `to_number`, `message`, `type`, `priority`, `status`, `server_id`, `created_at`.
* **`send_status_log`** — per-attempt delivery status reported by the app (`action=send_status`).
* **`gateways`** — active AMQP consumer sessions (`consumer_tag`, `started_at`).

---

## Endpoints & actions

Each tenant exposes a single endpoint at `/<user>/gateway`. The action is selected by the `action` POST parameter.

| Action | Direction | Purpose |
|--------|-----------|---------|
| `incoming` | app → server | report an inbound SMS/MMS (SMS form-encoded; MMS multipart with binary parts). |
| `forward_sent` | app → server | forward a previously sent message to another user. |
| `outgoing` | server → app | poll for queued outbound messages (returns `{events:[{event:"send",messages:[...]}]}`). |
| `send_status` | app → server | report delivery status of a queued message (`status`/`id`/`error`). |
| `device_status` | app → server | report battery/power/network telemetry. |
| `test` | app → server | connectivity check (returns empty events). |
| `amqp_started` | app → server | register an AMQP consumer session (`consumer_tag`). |

Requests with **no** `action` parameter are handled by a base handler that only validates the client
version from the User-Agent header (matching the PHP `Request` class behavior).

### Responses

* Version ≥ 28 (the current app, versionCode 30): JSON — `{ "events": [ ... ] }` on success or
  `{ "error": { "message": "..." } }` on failure.
* Older clients: XML (`<response>...</response>`).

---

## Web admin console

On top of the gateway API there is a tiny **zero-dependency single-page app** (vanilla JS + CSS, no
framework) served from `public/`. It provides account registration/login, a dashboard that reveals the
configuration a device needs to link to your gateway, and read-only analytics: battery history,
message sent/received counts, an inbox/outbox, and per-number conversation timelines.

```bash
npm start                       # serves /api/* AND http://localhost:8080/ (the console)
```

Two routes are served from `public/`:

* **`/`** — a public, unauthenticated **landing page** describing how the gateway works and how to link
  devices. No login required; it links through to the console.
* **`/console`** — the SPA shell (login → dashboard). Unauthenticated users are shown the login form.

Open <http://localhost:8080/> in a browser, click **Open console**, register an account, and log in to see
the **Dashboard** with the device-linking configuration:

| Field | Meaning |
|-------|---------|
| `server_url` | `/<username>/gateway` — paste verbatim into the app's *Server URL*. The username is part of the path, so it is also what signs each request. |
| `shared_secret` | The **device** signing key. Deliberately different from your login password. |

> **The login password and the device shared secret are never the same value.** Registration generates a
> random 24-char hex secret for devices; you can change your *login* password any time from Settings
> without affecting the device secret.

Registration collects an optional **email** and **primary contact number** (stored on the tenant row in
Core.db, returned by `/api/me`), plus a **confirm-password** field to catch typos. The login view asks only
for username + password, and both auth views keep a **← Back to home** link so operators are never trapped
off the public landing page.

### API surface (all JSON, session via httpOnly cookie named `session`)

| Method & path | Auth | Purpose |
|---------------|------|---------|
| `POST /api/register` | – | Create an account `{username,password}`. Sets the session cookie. |
| `POST /api/login` | – | Sign in; sets the session cookie. |
| `GET  /api/me` | ✔ | Current user profile (or 401). |
| `POST /api/logout` | ✔ | Destroys the session and clears the cookie. |
| `POST /api/change-password` | ✔ | Change only the login password (`currentPassword`,`newPassword`). Invalidates all sessions. |
| `GET  /api/config` | ✔ | `{server_url, username, shared_secret}` for linking devices. |
| `GET  /api/devices` | ✔ | Device registry (with last battery/network). |
| `GET  /api/history` | ✔ | `{battery:[...], buckets:[...]}` — add `?range=24h|7d|30d|all` and optional `?device=<phone_id>`. Hourly buckets for spans ≤ 24 h, daily otherwise. |
| `GET  /api/inbox` | ✔ | Incoming messages (`?sender=&limit=`). |
| `GET  /api/outbox` | ✔ | Outgoing messages (`?to=&status=&limit=`). |
| `GET  /api/conversations` | ✔ | Peer list with last-message summary. Click a peer → `/api/conversation?phone=<number>` for the date-ordered timeline across all devices. |
| `GET  /api/aliases`       | ✔ | `{aliases:[{phone,alias}]}` — user-defined phone→name aliases (tenant-scoped). |
| `POST /api/aliases`       | ✔ | Body `{phone, alias}` sets the alias; an empty/whitespace alias removes it. Returns the updated list. |

Sessions live in an in-memory map (7-day TTL) and are destroyed on logout, password change, or when a
password is changed elsewhere. Secrets are encrypted at rest with `GATEWAY_MASTER_KEY` (see below).

### Static assets & security notes

* `public/index.html`, `public/styles.css`, `public/app.js` are served from the same origin; `/`
  maps to `index.html` and other paths serve files from `public/`. A path-traversal guard rejects any
  request that would escape `public/`.
* The session cookie is `HttpOnly`, `SameSite=Lax`, non-`Secure` (intentionally, so the console works
  over plain HTTP on a LAN). For production behind TLS, set it secure by terminating TLS at a proxy and
  reading the `X-Forwarded-Proto` header.
* The dashboard is an admin/ops tool; it has **no** rate limiting or CSRF protection beyond the
  httpOnly session cookie — treat it as internal.

---

## Quick start

```bash
cd server/node

# 1. (optional) set a strong master key for encrypting secrets at rest
export GATEWAY_MASTER_KEY="change-me-64-characters-or-longer"

# 2. register two tenants (each gets its own <user>.db)
node scripts/register-user.js alice rosebud   15550000001
node scripts/register-user.js bob   s3cret    15550000002

# 3. start the gateway
npm start                       # or: node bin/start.js

# 4. enqueue an outbound message for a tenant (replaces php example/send_sms.php)
node scripts/send-message.js alice "15558675309" "Hello from Node" sms 5

# 5. verify the whole stack over a real socket (in-memory temp DBs)
npm run smoke
```

On first request to a tenant, `Core.db` and `<user>.db` are created automatically with the schema
above. Runtime data lives under `data/` (git-ignored).

---

## Configuring the Android app

In the EnvayaSMS settings, set:

* **Server URL:** `http://<host>:<port>/<username>/gateway` — the username sits in the path and is part
  of the signed request, so there is no separate tenant setting to append.
* **Password:** the plaintext shared secret for that user (the same value used when registering).

The app signs requests with this password, so it must match what was stored at registration time.

---

## Configuration reference

All configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP listen port. |
| `HOST` | `0.0.0.0` | HTTP bind address. |
| `CORE_DB` | `./data/Core.db` | Path to the shared Core database. |
| `DB_DIR` | `./data/dbs` | Directory for per-tenant `<user>.db` files (created on demand). |
| `MEDIA_DIR` | `./data/media` | Base directory for stored MMS binary parts (one subfolder per user). |
| `GATEWAY_MASTER_KEY` | *(none)* | Master key used to encrypt the shared secret at rest. If unset, secrets are stored in **plaintext** with a startup warning — do not use in production. |

The server validates usernames against `/^[A-Za-z0-9._-]+$/`; anything else (including path traversal
like `../../etc`) is rejected before any database access.

---

## Manual testing without the phone

`scripts/sign-request.js` builds a signed request exactly like the app and prints a ready-to-run
`curl` command:

```bash
node scripts/sign-request.js \
  --url "http://localhost:8080/alice/gateway" \
  --password rosebud \
  --field version=30 --field action=incoming \
  --field from=15551230000 --field message_type=sms \
  --field message="hello over http"
```

The output includes the computed `X-Request-Signature` and a full `curl` invocation. Use it to exercise
any action against a running server without the phone app.

---

## Testing

```bash
npm test            # unit + integration tests: auth, every action, tenant isolation, at-rest encryption
npm run smoke       # gateway end-to-end over a real socket with independently-signed requests
npm run e2e-console # web-dashboard end-to-end over a real socket (full cookie round-trip)
```

The integration suites run each file in its own process against throwaway temp databases:

* `test/gateway.test.js` — signature verification (pinned to an independent reference), per-action
  behavior, **tenant isolation between two users**, rejection of wrong passwords / missing tenants /
  path traversal, and encrypted-at-rest secrets.
* `test/webApi.test.js` — account registration/login/logout, session cookies, password changes, the
  device-configuration reveal (and that the secret differs from the login password), per-tenant
  isolation of config, and the analytics endpoints on a fresh tenant.
* `scripts/e2e-console.js` — boots a live server and drives the whole dashboard flow over HTTP
  (register → login → config reveal with the new `/<user>/gateway` scheme, per-tenant isolation,
  password-change session invalidation, logout).

---

## Notes, limitations & migration from PHP

* **Zero dependencies.** The server is built on Node's `http` module and the experimental `node:sqlite`
  binding — no Express, no native build step, no `npm install`. Requires **Node ≥ 22.5** (for
  `node:sqlite`).
* **Outbound delivery is poll-based.** Unlike a message broker, this server does not push to the app;
  it stores queued messages in `outgoing_messages` and hands them out on the next `action=outgoing`.
  Messages remain queued until reported as sent (matching the PHP example's file-queue model).
* **AMQP is not implemented.** The `amqp_started` action is accepted and recorded but there is no broker
  connection. Incoming messages are delivered to tenants via `outgoing_messages` polling instead.
* **MMS parts** (`action=incoming`, multipart) have their binary fields written under the tenant's media
  subfolder best-effort; a failure to persist a part does not fail the request. Only text fields take
  part in the signature, exactly as the app signs them.
* **Backwards compatible.** Same signatures, same JSON/XML shapes, same action names and field names —
  this is a drop-in replacement for `server/php` with no client changes.
