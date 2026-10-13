# Real-time AMQP Connection

When `amqp_enabled` is set, EnvayaSMS opens a **persistent connection to a
RabbitMQ server** and consumes a queue directly. This gives near-instant delivery
of outgoing messages without waiting for the next HTTP poll.

This feature was added in v3.0 (the "real-time AMQP connections" commit) as an
alternative to polling. See also [Server Communication](server-communication.md)
for the shared event model and [Persistence & Reliability](persistence-and-reliability.md).

---

## 1. Configuration

All settings are read from `SharedPreferences` via defensive accessors in `App`:

| Setting key | Meaning |
|-------------|---------|
| `amqp_enabled` | Master switch for the real-time connection. |
| `amqp_host` / `amqp_port` | RabbitMQ host and port. |
| `amqp_ssl` | Use an SSL/TLS connection. |
| `amqp_vhost` | AMQP virtual host. |
| `amqp_user` / `amqp_password` | Credentials. |
| `amqp_queue` | Queue to consume from. |
| `amqp_heartbeat` | Heartbeat interval (default 300s) for liveness detection. |

If any required value is missing, the app logs *"Real-time connection not
configured"* and does nothing.

---

## 2. Component map

| Class | Role |
|-------|------|
| `AmqpConsumer` | Owns the connection, channel, consume thread, retries, wifi lock. |
| `service/AmqpConsumerService` | `IntentService` that runs `startBlocking()` / `stopBlocking()`. |
| `service/AmqpHeartbeatService` | Keeps the heartbeat alarm alive (CPU-wake keepalive). |
| `receiver/StartAmqpConsumer` | Alarm target used to delay-retry a failed start. |

The connection lifecycle is driven by `App`:
- `EnabledChangedService` calls `amqpConsumer.startAsync()` on enable, `stopAsync()` on disable.
- `onConnectivityChanged()` calls `startDelayed(5000)` after reconnect, and `stopAsync()` when offline.

---

## 3. Starting the connection (async, non-blocking)

`startAsync()` → `startStopAsync(true)` → starts an `AmqpConsumerService`:

```java
Intent intent = new Intent(app, AmqpConsumerService.class);
intent.putExtra("start", true);
app.startService(intent);   // runs AmqpConsumerService.onHandleIntent → consumer.startBlocking()
```

`startBlocking()` reads settings and calls `tryStart(...)`. If it fails it schedules
a delayed retry (`RETRY_ERROR_DELAY = 60s`). On success the connection is armed and
the consume loop begins.

### Why a service, not a raw thread?

`AmqpConsumer.startStopAsync` must **not** hold locks that the main thread also
needs (there's an explicit comment about this in the code). Offloading to an
`IntentService` sidesteps deadlocks: the consume work runs on its own thread and
talks back only through `app.log(...)` / event processing.

---

## 4. Establishing the connection — `tryStart()`

```java
ConnectionFactory f = new ConnectionFactory();
f.setHost(host); f.setPort(port); f.setVirtualHost(vhost);
f.setUsername(username); f.setPassword(password);
f.setHeartbeatExecutor(new HeartbeatExecutor());   // custom executor w/ keepalive alarm
if (ssl) { SSLContext c = SSLContext.getInstance("TLS"); ...; f.useSslProtocol(c); }

connection = f.newConnection();
channel = connection.createChannel();
channel.queueDeclare(queue, true, false, false, null);  // durable
channel.basicQos(1);                                    // prefetch = 1 (fair dispatch)
QueueingConsumer consumer = new QueueingConsumer(channel);
channel.basicConsume(queue, false, consumer);

consumeThread = new ConsumeThread(consumer);
consumeThread.start();

// tell the server we're live
new HttpTask(app, action=amqp_started, consumer_tag=...).execute();
```

Battery considerations (per the code comments): the heartbeat wakes the CPU for a
few seconds every interval; between heartbeats the phone stays in deep sleep and is
woken only when the server sends a packet.

A **WifiLock** (`WIFI_MODE_FULL_HIGH_PERF`) is acquired while connected to keep the
radio alive.

---

## 5. The consume loop — `ConsumeThread`

```java
while (true) {
    Delivery delivery = consumer.nextDelivery();   // blocks until a message arrives
    if (terminated) break;
    channel.basicAck(delivery.getDeliveryTag(), false);   // ack after processing
    processMessage(delivery);          // new String(body) → JSONObject → JsonUtils.processEvent
    if (terminated) break;
}
```

- **`basicQos(1)` + manual ack** = fair dispatch: the server won't overwhelm us.
- Messages are processed by reusing the exact same `JsonUtils.processEvent(...)`
  path as HTTP polling, so a `"send"` delivery creates an outgoing message exactly
  like a poll would.

If the connection drops (`ShutdownSignalException` or any error), the thread logs
*"Real-time connection interrupted"*, stops itself, and schedules a delayed retry
(`RETRY_ERROR_DELAY` if it failed fast, otherwise `RETRY_DELAY = 5s`).

---

## 6. Heartbeat keepalive

Because Android can reap background alarms, `HeartbeatExecutor` (a
`ScheduledThreadPoolExecutor`) also arms an `AmqpHeartbeatService` alarm so the
connection is periodically nudged even when idle. The comment notes this keeps the
AMQP session alive across OS power management.

---

## 7. Stopping — `stopBlocking()`

Releases the WifiLock, cancels the heartbeat alarm, terminates the consume thread,
closes the channel and connection (with a bounded timeout), and nulls references.
`startAsync()`/`stopAsync()` are how connectivity changes toggle the connection.

---

## 8. AMQP vs. polling — which is used?

- If `amqp_enabled` **and** fully configured → real-time consume loop runs; no
  periodic poll needed for delivery (though a poll may still run for settings sync).
- Otherwise → the app falls back to HTTP polling every `outgoing_interval` seconds
  (`OutgoingMessagePoller` alarm) as described in [Server Communication](server-communication.md).

The two are mutually exclusive *delivery* mechanisms but share the same event model,
so a server can support both and clients pick based on configuration.

---

Next: [Persistence & Reliability](persistence-and-reliability.md), or jump to the
[Class Reference](class-reference.md).
