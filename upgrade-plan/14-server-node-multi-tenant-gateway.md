# Step 14 — Multi-Tenant Node.js Gateway (`server/node`)

**Objective.** Provide a modern, dependency-free replacement for `server/php`: a multi-tenant HTTP
gateway that speaks the exact EnvayaSMS wire protocol (byte-compatible signatures, JSON/XML responses,
action names and field names) while isolating every user's data in its own SQLite database.

This step is **optional** from the app's perspective — the original PHP server still works unchanged —
but it removes the PHP dependency and gives a single process that can host many collections of devices.

---

## Current state

* `server/php/` contains the reference protocol (`EnvayaSMS.php`) plus example scripts (`gateway.php`,
  `server.php`, `config.php`, `send_sms.php`, `test.html`).
* The PHP server is single-tenant per install; scaling to many tenants means running one PHP process
  (and data directory) per tenant, or complex virtual-hosting logic.

## Target state

A Node.js service (`server/node/`) that:

1. Runs on **Node ≥ 22.5** with **zero runtime dependencies** (uses only the built-in `http` module and
   the experimental `node:sqlite` binding — no Express, no native build step).
2. Serves **many tenants from one process**, each tenant's data in a separate `<user>.db`.
3. Authenticates every request with the same `X-Request-Signature` scheme as the app.
4. Routes by username carried in the URL query string (`?user=XYZ`) — **no client change**.

---

## Architecture

```
                ┌────────────────────────────────────────────┐
   POST /gateway.php?user=XYZ        X-Request-Signature       │  createServer()
   (any action)      header    ───►  │ parse tenant            │
                                      │ verify signature        │
                                      │ dispatch by action      │
                                      └────────────┬────────────┘
                                                    │
                     ┌──────────────────────────────┼──────────────────────────────┐
                     ▼                                  ▼                              ▼
              Core.db (shared)               <user>.db  (per tenant)            <other>.db
              • users.username              • device_state                      • ...
              • users.password_enc          • incoming_messages
                                        • outgoing_messages
                                        • send_status_log / gateways
```

### Why the secret lives in Core.db, not `<user>.db`

To verify a signature the server needs the user's plaintext password, but it only learns the username
*after* parsing the request. Opening the per-tenant DB first to fetch the secret would let an attacker
enumerate tenants (a "DB open failed" error for unknown users vs. an auth error for known ones). Storing
the **encrypted** secret in `Core.db` lets the server authenticate any tenant uniformly and return the
same `"Invalid password"` response — no enumeration. The plaintext is materialized only long enough to
compute SHA1, then discarded.

---

## Files

| Path | Responsibility |
|------|----------------|
| `package.json` | Zero-dependency manifest; Node ≥ 22.5 engines; scripts (`start`, `register`, `send`, `sign`, `smoke`, `test`). |
| `src/config.js` | Env-driven config, username validation, path helpers, experimental-sqlite warning filter. |
| `src/signature.js` | Byte-compatible signature compute/verify (PHP string-accumulator semantics). |
| `src/crypto.js` | AES-256-GCM encrypt/decrypt of the shared secret at rest via a scrypt-derived key from `GATEWAY_MASTER_KEY`. |
| `src/coreDb.js` | Core.db users table: `createUser`, `getUserByUsername`, `listUsers`, `deleteUser`, redaction. |
| `src/userDb.js` | Per-tenant DB openers + migrations; device/incoming/outgoing/send-status accessors. |
| `src/bodyParser.js` | Form-urlencoded + minimal multipart parser (separates text fields from binary parts). |
| `src/responses.js` | JSON and legacy XML renderers with htmlspecialchars-compatible escaping. |
| `src/gateway.js` | Pure handler: parse tenant, verify signature, route by action; returns `{status, contentType, body}` for testability. |
| `src/server.js` | Thin `http.createServer` wrapper that buffers the body and calls the handler. |
| `bin/start.js` | Entrypoint — boots the HTTP server on `PORT`. |
| `scripts/register-user.js` | Register a tenant (creates Core.db row + `<user>.db`). Replaces `send_sms.php`'s account setup. |
| `scripts/send-message.js` | Enqueue an outbound message for a tenant. Replaces `php example/send_sms.php`. |
| `scripts/sign-request.js` | Build a signed request and print a ready-to-run `curl` command (manual testing). |
| `scripts/e2e-smoke.js` | Boots the server on an ephemeral port and exercises it over a real socket with independently-signed requests. |
| `test/gateway.test.js` | Integration tests: auth, every action, tenant isolation, at-rest encryption. |

---

## Data model (see README for full tables)

* **Core.db** — `users(id, username UNIQUE, password_enc, phone_number, created_at, active)`.
* **`<user>.db`** — `device_state`, `incoming_messages`, `outgoing_messages`, `send_status_log`, `gateways`.

Runtime data lives under `data/` (git-ignored): `Core.db`, per-user `<user>.db`, and stored MMS parts.

---

## Actions supported

`incoming`, `forward_sent`, `outgoing` (poll), `send_status`, `device_status`, `test`, `amqp_started`.
Requests with no `action` are handled by a base handler that only validates the client version from the
User-Agent header (matching the PHP `Request` class).

Responses: JSON `{ "events": [...] }` / `{ "error": { "message": "..." } }` for app version ≥ 28; XML
for older clients. Auth failures return HTTP 403 with `{"error":{"message":"Invalid password"}}`;
unknown actions return the documented unsupported-action error.

---

## Incremental actions (already implemented)

1. Scaffold `server/node/` with a zero-dependency `package.json`. ✅
2. Implement config, signature, and crypto modules. ✅
3. Implement Core.db + per-tenant DB accessors and migrations. ✅
4. Implement body parsing (form + multipart), response rendering, and the pure gateway handler. ✅
5. Wire the HTTP server and entrypoint. ✅
6. Add tenant registration, message-enqueue, signed-request, and e2e-smoke scripts. ✅
7. Write integration tests covering auth, every action, isolation, and encryption. ✅

## Acceptance criteria

- [x] `npm test` passes (12/12): signature verification pinned to an independent reference; each action;
      **tenant isolation** between two users; wrong-password / missing-tenant / path-traversal rejection;
      encrypted-at-rest secret round-trips.
- [x] `npm run smoke` passes: full stack verified over a real socket with independently-signed requests.
- [x] Signature output is byte-identical to the documented algorithm (verified by an independent
      implementation in the test suite).
- [x] No `npm install` required; server starts on Node 22.5+ using only built-in modules.

## Dependencies / risks

* **Node ≥ 22.5** is required for `node:sqlite`. On older runtimes, swap `src/userDb.js`'s `node:sqlite`
  calls behind a small adapter — the rest of the code depends on it only through that module.
* **AMQP is not implemented.** Delivery is poll-based (`action=outgoing`); `amqp_started` is recorded but
  there is no broker connection. Incoming messages reach tenants via the outgoing queue, matching the PHP
  example's file-queue model.
* **MMS parts** are written to disk best-effort; a persistence failure does not fail the request, and only
  text fields participate in the signature (exactly as the app signs them).
