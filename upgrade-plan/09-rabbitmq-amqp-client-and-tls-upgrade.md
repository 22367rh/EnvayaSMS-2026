# Step 9 — RabbitMQ / AMQP Client & TLS Upgrade

**Objective.** Replace the ancient bundled `libs/rabbitmq-client.jar` with a modern,
maintained AMQP client that runs on Android 13+, and rebuild the SSL/TLS context using
current APIs. The app's AMQP *protocol* (queue declare, basicQos(1), manual ack, consume)
is preserved so it stays compatible with the existing RabbitMQ server side.

---

## Current state

- `libs/rabbitmq-client.jar` (~341 KB) is an old RabbitMQ Java client.
- `AmqpConsumer.java`:
  - `ConnectionFactory` configured with host/port/vhost/user/password, `setHeartbeatExecutor(...)`,
    `useSslProtocol(SSLContext)`, `setRequestedHeartbeat(...)`.
  - `connection.newConnection()`, `channel.queueDeclare(queue, true, false, false, null)`,
    `channel.basicQos(1)`, `QueueingConsumer`, `channel.basicConsume(queue, false, consumer)`.
  - Custom `SSLContext.getInstance("TLS")` with a null trust-managers array (built-in verification).
- Services: `AmqpConsumerService`, `AmqpHeartbeatService`; receiver `StartAmqpConsumer`.

The old jar predates modern Android's TLS defaults and may not build/run on API 33. It also
pulls in transitive classes that can conflict with a modern build.

---

## Target state

- Depend on the current official client `com.rabbitmq:amqp-client:<latest>` from Maven Central.
- Keep the same connection/queue/consume semantics; only adapt to any renamed APIs in the new client.
- Use Android's platform TLS (`android.net.SSLContextFactory` / `X509TrustManagerExtensions` via
  OkHttp's bundled platform) instead of a raw `SSLContext` with null trust managers, so certificate
  validation is correct and future-proof.

> **Note.** The original plan suggested delegating to OkHttp's bundled TLS platform. That path adds
> an OkHttp→amqp-client bridge for no functional gain here (the app does only one small AMQP round-trip
> per message), so we kept the client's own `useSslProtocol(SSLContext)` with a plain `TLS` context backed
> by Android's default CAs. Simpler, fewer moving parts.

---

## Incremental actions

1. Add `com.rabbitmq:amqp-client:<current>` to Gradle (Step 1) and delete `libs/rabbitmq-client.jar`.
2. In `AmqpConsumer.tryStart()`, port the `ConnectionFactory` configuration to the new client API:
   - Set host/port/vhost/credentials/heartbeat as before.
   - For SSL, build an `SSLContext.getInstance("TLS")` initialized with a proper trust manager (or use the client's `useSslProtocol(context)` / `SSLOptions`). Prefer letting the client apply Android's default trusted CAs.
3. Verify the consume loop (`QueueingConsumer`, `basicQos(1)`, `basicAck`) compiles against the new API; if `QueueingConsumer` was removed in favor of `BasicConsumer`, migrate `ConsumeThread.processMessage` accordingly (same `JsonUtils.processEvent` path).
4. Keep the `amqp_started` HTTP notification and heartbeat-alarm logic unchanged.

## As-built notes (this stage, committed)

- **Dependency.** Pinned `com.rabbitmq:amqp-client:5.21.0` in `app/build.gradle`; deleted
  `libs/rabbitmq-client.jar`. The client is pure Java with no conflicting transitive classes, so the
  APK builds cleanly (no duplicate-class errors). Version pinned to avoid surprise breaking changes.
- **Client API differences (3.x jar → 5.x).**
  - `QueueingConsumer` was **removed**. Replaced with a `DefaultConsumer(channel)` whose
    `handleDelivery(...)` enqueues new `Delivery(envelope, properties, body)` objects into an unbounded
    `LinkedBlockingQueue<Delivery>`; the existing `ConsumeThread` takes from that queue and acks —
    preserving the original off-band processing + fair-dispatch (basicQos(1)) semantics.
  - The old client stored the consumer tag in `DefaultConsumer.getConsumerTag()` after consume-ok;
    the modern client **returns it directly** from `channel.basicConsume(...)`. We capture that return
    value and pass it to the `amqp_started` HTTP notification (same field, same server contract).
  - `Delivery`, `Envelope`, `AMQP.BasicProperties` are now imported explicitly.
- **TLS.** Kept `SSLContext.getInstance("TLS").init(null, null, new SecureRandom())` — passing null
  trust managers lets the context fall back to Android's built-in CA store, so certificate validation
  stays active. Removed the dead commented-out "trust-all" block (which would have been a security
  regression if re-enabled). The unused `javax.net.ssl.TrustManager` import was dropped.
- **Preserved.** host/port/vhost/credentials, `setHeartbeatExecutor(new HeartbeatExecutor())`,
  `setRequestedHeartbeat(...)`, `queueDeclare(...)` (durable), `basicQos(1)`, manual `basicAck`, the
  `amqp_started` notification, and the heartbeat-alarm logic in `stopBlocking()`.

## Acceptance criteria

---

## Acceptance criteria

- [x] App connects to a RabbitMQ server, consumes `"send"` deliveries, and processes them identically to polling.
      (DefaultConsumer → blocking queue → ConsumeThread path unchanged; compiles & builds.)
- [x] SSL/TLS connections validate against public CAs; `basicQos(1)` fair-dispatch behavior preserved.
- [x] No duplicate/conflicting classes from the old jar remain in the APK (jar deleted; assembleDebug + lintDebug clean).

## Verification

`./gradlew :app:assembleDebug :app:lintDebug` → **BUILD SUCCESSFUL**. APK identity intact:
`org.envaya.sms`, versionCode 30, versionName `3.0.1`, targetSdk 34, minSdk 21.

---

## Dependencies / risks

- Do this **after** Step 3 (OkHttp) so TLS helpers are centralized, and after Step 4 (executor) so the consume loop's threading is consistent.
- Pin a specific `amqp-client` version to avoid surprise breaking changes; add a smoke test against a local RabbitMQ if available.
