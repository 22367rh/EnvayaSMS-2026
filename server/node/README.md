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

### Username routing (zero client changes)

The username is carried in the **URL query string**, e.g.:

```
POST http://gateway.example/gateway.php?user=XYZ
```

Because the Android app signs the *entire* URL (query string included), appending `?user=XYZ` to the
configured server URL requires **no code change** and no protocol change. The `user` parameter is
excluded from the signed POST body — it only selects which tenant's database handles the request.

---

## Signature scheme (authentication)

Every authenticated request carries an `X-Request-Signature` header computed by the client as:

```
signature = Base64( SHA1( url + "," + sortedParams + "," + password ) )
```

where:

* `url` — the full request URL **including** the query string (e.g. `http://host/gateway.php?user=XYZ`).
  The server reconstructs this from the incoming `Host` header and request path, so it must match what
  the client signed.
* `sortedParams` — every POST body parameter as `name=value`, with parameters sorted **ascending by name**
  (matching PHP's `ksort`). They are joined with `,`.
* `password` — the app's plaintext `password` setting for that tenant, appended after a trailing comma.

Example: signing `{action:"incoming", from:"1555"}` with password `rosebud` over
`http://h/g.php?user=XYZ` produces the input string
`http://h/g.php?user=XYZ,action=incoming,from=1555,rosebud`.

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

All traffic is a single endpoint: `/gateway.php`. The action is selected by the `action` POST parameter.

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

* **Server URL:** `http://<host>:<port>/gateway.php?user=<username>` — note the `?user=` suffix selects
  the tenant. The username is *not* a separate setting; it is part of the signed URL.
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
  --url "http://localhost:8080/gateway.php?user=alice" \
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
npm test        # integration tests: auth, every action, tenant isolation, at-rest encryption
npm run smoke   # end-to-end over a real socket with independently-signed requests
```

The integration suite (`test/gateway.test.js`) runs in its own process against throwaway temp
databases and covers: signature verification (pinned to an independent reference), per-action behavior,
**tenant isolation between two users**, rejection of wrong passwords / missing tenants / path traversal,
and encrypted-at-rest secrets.

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
