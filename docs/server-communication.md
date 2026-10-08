# Server Communication (HTTP)

How EnvayaSMS talks to its server over **HTTP**. The app supports two response
formats — **JSON** (modern) and **XML** (legacy) — selected by the server's
`Content-Type`. Both normalize onto the same *event model*.

The real-time AMQP transport is covered in [Real-time AMQP Connection](amqp-connection.md).

---

## 1. Two directions of traffic

```
   APP ──inbound──▶  server        (action=incoming, action=forward_sent)
   APP ◀─outgoing──  server        (poll: action=outgoing → events)
   APP ──status────▶  server        (action=send_status)
   APP ──amqp_started▶ server      (real-time connection up)
   APP ──device_status▶ server     (battery, send-limit, power state)
```

- **Push (app → server)**: happens whenever inbound traffic arrives or an event
  completes. Implemented by `HttpTask` / `ForwarderTask`.
- **Pull (server → app)**: periodic polling via `PollerTask`, or instant via AMQP.

---

## 2. The HTTP client

`App.getHttpClient()` builds a shared, thread-safe Apache `DefaultHttpClient` with
a custom `SchemeRegistry` for http(80) / https(443), connection/socket timeouts
(`HTTP_CONNECTION_TIMEOUT = 10s`, `HTTP_SOCKET_TIMEOUT = 60s`). All requests go
through the abstract `BaseHttpTask` → concrete `HttpTask`.

---

## 3. Common request parameters

Every `HttpTask` (see `HttpTask.doInBackground`) adds:

| Param | Source |
|-------|--------|
| `phone_number` | `app.getPhoneNumber()` |
| `phone_id`, `phone_token` | settings |
| `send_limit` | `app.getOutgoingMessageLimit()` |
| `now` | current epoch ms |
| `settings_version` | for cache-busting / versioning |
| `battery` | current battery % |
| `power` | plugged state |
| `network` | active network type name (MOBILE/WIFI) |
| `log` | recent new log entries (so the server can show app logs) |

---

## 4. Request signing / authentication

To prevent spoofing, each request carries an `X-Request-Signature` header computed
in `HttpTask.getSignature()`:

```
sortedParams = sort(params by name)
value = url + "," + join(", ", "name=value" for each param) + "," + password
signature = Base64(SHA-1(value))
setHeader("X-Request-Signature", signature)
```

The server verifies using the same shared `password`. The PHP library exposes
`EnvayaSMS_ActionRequest::compute_signature(...)` and
`is_validated($password)` to do exactly this. A failed validation returns HTTP 403
plus a rendered error response.

> **Security note:** the signature authenticates the *app* but traffic still rides
> on HTTPS when `server_url` uses `https://`. Prefer HTTPS in production.

---

## 5. The event model (JSON)

A poll/response is a JSON object, typically:

```json
{
  "events": [
    { "event": "send",
      "messages": [
        { "id": "abc123", "type": "sms", "to": "16504449876",
          "message": "Hello!", "priority": 0 }
      ] },
    { "event": "log", "message": "server says hi" },
    { "event": "cancel", "id": "abc123" },
    { "event": "settings", "settings": { "enabled": true } }
  ]
}
```

`JsonUtils.processEvent(event)` dispatches on the `event` field:

| Event | Effect |
|-------|--------|
| `send` | Build one or more `OutgoingMessage`s → `outbox.sendMessage()`. |
| `cancel` | Cancel a single outgoing message by server id. |
| `cancel_all` | Cancel every cancellable outgoing message. |
| `log` | Append to the app log (`app.log`). |
| `settings` | Remote-configure the app (updates settings + re-runs `configuredChanged()`). |

Any unknown event logs `"Unknown event ..."`.

### Message fields (for `send`)

`id` (server id, used for cancel/status), `type` (`sms`/`mms`), `to`, `message`,
and `priority`. `from` is always set to the app's own `phone_number`.

---

## 6. The event model (XML — legacy)

Older servers respond with XML parsed by `XmlUtils.parseResponse(...)` and
`XmlUtils.getMessagesList(...)`. It produces the same `OutgoingMessage`s that are
handed to `outbox.sendMessage()`, so the app side is unchanged; only the wire
format differs. New deployments should use JSON.

---

## 7. Task types

| Class | Role |
|-------|------|
| `HttpTask` | Base: adds common params, computes signature, dispatches on content-type (JSON vs XML). |
| `PollerTask` | `action=outgoing`; calls `app.markPollComplete()` when done so the next poll can start. |
| `ForwarderTask` | Wraps an inbound message; on success → `inbox.messageForwarded`, on failure → `inbox.messageFailed`. |

### Content-type dispatch (`HttpTask.handleResponse`)

```java
if contentType startsWith "application/json": parse JSONObject → handleResponseJSON
else if contentType startsWith "text/xml":   parse Document → handleResponseXML
else: handleUnknownContentType(...)
// after a valid response, if we had a connectivity error, trigger onConnectivityRestored()
```

---

## 8. Failure handling & retries

- Network errors (`UnknownHostException`, timeouts) are caught in
  `handleRequestException`. If the task was created with
  `retryOnConnectivityError = true`, it is queued for later via
  `app.addQueuedTask(copy)` and `app.onConnectivityError()` is signalled.
- On success after a connectivity error, `app.onConnectivityRestored()` drains the
  queue and retries pending messages.
- Forwarding failures route through `Inbox.messageFailed` → escalating alarm-based
  retry (see [Persistence & Reliability](persistence-and-reliability.md)).

---

## 9. Sending status back

When an outgoing message is sent, fails, or is cancelled, `Outbox.notifyMessageStatus`
issues an `action=send_status` request carrying the server id and status string
(`sent` / `failed` / `cancelled`). This is how the server learns delivery outcome.

---

Next: [Real-time AMQP Connection](amqp-connection.md) for the instant-delivery transport.
