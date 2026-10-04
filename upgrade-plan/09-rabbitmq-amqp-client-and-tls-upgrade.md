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

---

## Incremental actions

1. Add `com.rabbitmq:amqp-client:<current>` to Gradle (Step 1) and delete `libs/rabbitmq-client.jar`.
2. In `AmqpConsumer.tryStart()`, port the `ConnectionFactory` configuration to the new client API:
   - Set host/port/vhost/credentials/heartbeat as before.
   - For SSL, build an `SSLContext.getInstance("TLS")` initialized with a proper trust manager (or use the client's `useSslProtocol(context)` / `SSLOptions`). Prefer letting the client apply Android's default trusted CAs.
3. Verify the consume loop (`QueueingConsumer`, `basicQos(1)`, `basicAck`) compiles against the new API; if `QueueingConsumer` was removed in favor of `BasicConsumer`, migrate `ConsumeThread.processMessage` accordingly (same `JsonUtils.processEvent` path).
4. Keep the `amqp_started` HTTP notification and heartbeat-alarm logic unchanged.

---

## Acceptance criteria

- [ ] App connects to a RabbitMQ server, consumes `"send"` deliveries, and processes them identically to polling.
- [ ] SSL/TLS connections validate against public CAs; `basicQos(1)` fair-dispatch behavior preserved.
- [ ] No duplicate/conflicting classes from the old jar remain in the APK.

---

## Dependencies / risks

- Do this **after** Step 3 (OkHttp) so TLS helpers are centralized, and after Step 4 (executor) so the consume loop's threading is consistent.
- Pin a specific `amqp-client` version to avoid surprise breaking changes; add a smoke test against a local RabbitMQ if available.
