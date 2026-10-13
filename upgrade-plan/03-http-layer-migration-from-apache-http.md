# Step 3 — Migrate the HTTP Layer Off `org.apache.http.*`

**Objective.** Replace the Apache HttpClient stack (`org.apache.http.*`), which was
**completely removed from the Android platform in Android 6.0 (API 23)** and therefore
does not exist on Android 13, with a modern HTTP client (**OkHttp**) while preserving
the exact wire protocol, request parameters, signing header, and JSON/XML event handling.

---

## Current state

`org.apache.http.*` is used across many files:

| File | Usage |
|------|-------|
| `App.java` | `getHttpClient()` builds a `DefaultHttpClient` with `SchemeRegistry`, `PlainSocketFactory`, `SSLSocketFactory`, `ThreadSafeClientConnManager`; `getDefaultHttpParams()` uses `BasicHttpParams`/`HttpConnectionParams`. |
| `task/BaseHttpTask.java` | `AsyncTask<..., HttpResponse>`, `HttpPost`, `MultipartEntity`, `UrlEncodedFormEntity`, `FormBodyPart`, `StringBody`, reading `HttpResponse` status/content-type. |
| `task/HttpTask.java` | `makeHttpPost()`, signature header, response dispatch on content-type. |
| `task/PollerTask.java`, `task/ForwarderTask.java` | Subclasses of the above. |
| `IncomingMms.java` | Builds multipart form parts for MMS uploads (via `FormBodyPart`). |
| `JsonUtils.java`, `XmlUtils.java` | Parse responses (indirectly tied to the client). |
| `receiver/DeviceStatusReceiver.java`, `ui/LogView.java` | Minor Apache usage. |

On API 33 these classes simply do not exist → **compile failure**. This is the single
most urgent migration because it blocks compilation entirely.

---

## Target state

- All HTTP goes through a single OkHttp `OkHttpClient` instance owned by `App`.
- Request building (params, multipart, signature header) moves into small helper classes
  that produce OkHttp `Request`/`RequestBody` objects — no Apache types anywhere.
- The **response-processing callbacks** (`handleResponseJSON`, `handleResponseXML`,
  error handling, content-type dispatch) are preserved unchanged in logic.
- TLS: use OkHttp's bundled `Platform.get().tlsPlatform()` / `X509TrustManager` instead of
  the removed Apache `SSLSocketFactory.BROWSER_COMPATIBLE_HOSTNAME_VERIFIER`. Keep hostname
  verification secure (the browser-compatible verifier was insecure and is gone).
- `AsyncTask` removal is handled in Step 4; this step focuses only on swapping the transport.

---

## Incremental actions

1. Add OkHttp dependency (Step 1) and remove the old `httpmime-4.1.2.jar` from `libs/`.
2. Create an `OkHttpTransport` helper in `App`:
   - Build a shared `OkHttpClient` with connection/socket timeouts (`HTTP_CONNECTION_TIMEOUT = 10s`, `HTTP_SOCKET_TIMEOUT = 60s`).
   - Provide `sslSocketFactory`/`hostnameVerifier` for the HTTPS scheme using modern Android TLS.
3. Rewrite `BaseHttpTask`:
   - Change the async base class return type from `HttpResponse` to OkHttp `Response` (or a small DTO).
   - `makeHttpPost()` → build an OkHttp `Request.Builder()` with form params (`FormBody`) or multipart (`MultipartBuilder`) mirroring the current `MultipartEntity` logic.
   - Add the `X-Request-Signature` header exactly as before (signature computation in `HttpTask.getSignature()` is unchanged).
4. Migrate response handling:
   - Read the body via `response.body().string()` / `byteStream()`, then run the existing content-type dispatch (`application/json` → `JsonUtils`; `text/xml` → `XmlUtils`).
   - Preserve status-code semantics (200 vs 4xx/5xx vs network exception).
5. Port `IncomingMms` multipart construction to OkHttp `MultipartBuilder.addPart(...)`, keeping the `mms_parts` JSON metadata and part ordering identical.
6. Remove all remaining `import org.apache.http.*` statements (App, JsonUtils, XmlUtils, DeviceStatusReceiver, LogView) once their usages are replaced or confirmed unused.

---

## Acceptance criteria

- [ ] Zero references to `org.apache.http` remain in the source tree.
- [ ] A poll (`action=outgoing`) and an inbound forward (`action=incoming`) both succeed against a real/stub server, producing byte-identical params + signature header to the old implementation (verify with a packet capture / proxy).
- [ ] HTTPS requests validate correctly against a public CA; self-signed servers still work if configured via a custom trust store.

---

## Dependencies / risks

- **Must precede** Steps 4–8 (they build on the transport).
- The signature algorithm (`Base64(SHA-1(url + "," + sortedParams + "," + password)))`) and param ordering are part of the server contract — do **not** change them. Add a regression test that pins the signature output.
- OkHttp's `RequestBody` streams from content providers; for MMS binary parts read via `MmsPart.getData()` this is fine (in-memory), but be mindful of large attachments.
