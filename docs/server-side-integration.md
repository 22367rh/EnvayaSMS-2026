# Server-Side Integration

This page documents the **server API** that EnvayaSMS speaks, so you can build a
backend that talks to the app. The reference PHP library is `server/php/EnvayaSMS.php`;
example gateways live in `server/php/example/`.

---

## 1. Two APIs, one contract

The app can talk to a server over **HTTP** (polling) and/or **AMQP** (real-time).
Both deliver the same *event model*; only the transport differs:

- **HTTP**: the app polls `server_url` with `action=outgoing`; the server replies
  with events. The app also POSTs inbound/status data to the same URL.
- **AMQP**: the app consumes a queue directly; messages are JSON events identical
  to the HTTP response body.

---

## 2. Actions (app → server)

The `action` parameter/field selects what the app is doing. Mapped in both the Java
client (`App.*` constants) and PHP (`EnvayaSMS::ACTION_*`):

| Action | Sent when | Server's job |
|--------|-----------|--------------|
| `incoming` | An inbound SMS/call was forwarded. | Acknowledge; optionally reply via a later `send`. |
| `forward_sent` | A user-sent SMS is forwarded. | Same as above. |
| `outgoing` (poll) | App asks "any messages for me?" | Respond with events (`send`, `log`, …). |
| `send_status` | An outgoing message was sent/failed/cancelled. | Record delivery status. |
| `device_status` | Battery/send-limit/power changes. | Observe device health. |
| `amqp_started` | Real-time connection established. | (Optionally) clean up stale connections. |
| `test` | Manual "Test" from the UI. | Acknowledge connectivity. |

---

## 3. The response / event model

A poll response is a JSON object:

```json
{ "events": [ { "event": "send", "messages": [ ... ] }, ... ] }
```

| Event | Purpose |
|-------|---------|
| `send` | Deliver one or more outgoing messages. Fields: `id`, `type`, `to`, `message`, `priority`. |
| `cancel` | Cancel a previously sent message by server `id`. |
| `cancel_all` | Cancel all outstanding messages. |
| `log` | Push a log line into the app's log. |
| `settings` | Remote-configure the app (`settings` = map of key → value). |

The PHP classes mirror this: `EnvayaSMS_Event_Send`, `_Cancel`, `_CancelAll`,
`_Log`, `_Settings`.

---

## 4. Authentication — request signature

Every request is signed to authenticate the shared secret. The PHP side mirrors the
Java `getSignature()`:

```php
// EnvayaSMS_ActionRequest::compute_signature()
sort($data by key);
$string = $url . "," . implode(",", "$k=$v" ...);
$signature = base64(sha1($string . "," . $password));
// sent as header: X-Request-Signature: <signature>
```

The server validates with `$request->is_validated($PASSWORD)`. On failure it returns
HTTP 403 and an error response. **The `password` in the app settings must match
`$PASSWORD` in your `config.php`.**

---

## 5. Example gateway

`server/php/example/www/gateway_amqp.php` is a complete reference server:

```php
$request = EnvayaSMS::get_request();
header("Content-Type: {$request->get_response_type()}");
if (!$request->is_validated($PASSWORD)) { /* 403 + error */ }
$action = $request->get_action();
switch ($action->type) {
    case ACTION_INCOMING:      // log it, acknowledge
    ...
    case ACTION_OUTGOING:      // nothing via poll; use AMQP instead
    case ACTION_AMQP_STARTED:  // log connection / clean up stale ones
    case ACTION_SEND_STATUS:   // log delivery status
    case ACTION_DEVICE_STATUS: // log device health
    case ACTION_TEST:          // acknowledge test
}
```

Other example files:

| File | Role |
|------|------|
| `www/gateway.php` | HTTP-only gateway (poll-based). |
| `www/gateway_amqp.php` | AMQP real-time gateway. |
| `send_sms.php` | CLI to queue an outgoing SMS via the filesystem. |
| `send_sms_amqp.php` | CLI to queue an outgoing SMS for the AMQP path. |
| `config.php` | `$PASSWORD`, directories, etc. |

The example uses RabbitMQ PHP submodules (`php-amqplib`) and a small HTTP server
(`httpserver`) checked in as git submodules under `server/php/example/`.

---

## 6. Building your own server (checklist)

1. Accept POSTs at a URL; set the response `Content-Type` to
   `application/json` (recommended) or `text/xml`.
2. Verify `X-Request-Signature` against your shared secret.
3. Read `action`; for `incoming`/`forward_sent`, process and `render_response()`.
4. For `outgoing` polls, return events (`send` to push messages).
5. Acknowledge `send_status` / `device_status` / `amqp_started` / `test`.
6. (Optional) expose an AMQP queue the app consumes for instant delivery.

See [Server Communication](server-communication.md) for the client-side details this
mirrors, and [Real-time AMQP Connection](amqp-connection.md) for the push transport.
