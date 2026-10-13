'use strict';

/*
 * Per-tenant ("XYZ.db") storage: one SQLite file per tenant holding ONLY that tenant's messaging and
 * device data. No cross-tenant reads are possible because each request is routed to exactly one user's
 * database, opened by its validated username.
 *
 * Tables:
 *   device_state      latest reported state for the tenant's device(s) (battery/power/network/seen)
 *   incoming_messages forwarded incoming SMS/MMS records (from action=incoming / forward_sent)
 *   outgoing_messages server-side outgoing queue returned by poll (action=outgoing)
 *   send_status_log   audit of send_status reports keyed by the server message id
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const config = require('./config');

const migrations = `
CREATE TABLE IF NOT EXISTS device_state (
    rowid        INTEGER PRIMARY KEY CHECK (rowid = 1),
    phone_id     TEXT DEFAULT '',
    phone_token  TEXT DEFAULT '',
    device_status TEXT DEFAULT '',
    last_battery   INT DEFAULT -1,
    last_power     INT DEFAULT -1,
    last_network   TEXT DEFAULT '',
    last_seen      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS incoming_messages (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    sender           TEXT DEFAULT '',
    recipient        TEXT DEFAULT '',
    body             TEXT DEFAULT '',
    message_type     TEXT DEFAULT 'sms',
    parts_json       TEXT DEFAULT '',
    source_timestamp TEXT DEFAULT '',
    received_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outgoing_messages (
    id         TEXT PRIMARY KEY,          -- server-assigned id echoed back by the app in send_status
    to_number  TEXT NOT NULL,
    body       TEXT DEFAULT '',
    message_type TEXT DEFAULT 'sms',
    priority   INT DEFAULT 0,
    status     TEXT DEFAULT 'queued',     -- queued|sent|failed|cancelled
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS send_status_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   TEXT NOT NULL,
    status      TEXT DEFAULT '',
    error       TEXT DEFAULT '',
    received_at TEXT DEFAULT (datetime('now'))
);

-- Per-request gateway activity for this tenant: one row per request the app sent (incoming, device_status,
-- test, etc.). Persisted so it shows on the web dashboard, not just the server console.
-- The authenticated column records whether the signature verified; only authenticated requests reach
-- persistence in practice.
CREATE TABLE IF NOT EXISTS gateway_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    action       TEXT DEFAULT '',          -- message type / action, e.g. incoming, device_status, test
    authenticated INT DEFAULT 1,           -- 1 = signature verified, 0 = failed auth
    phone_id     TEXT DEFAULT '',
    from_number  TEXT DEFAULT '',          -- sender for incoming (context only)
    battery      INT DEFAULT -1,
    network      TEXT DEFAULT '',
    received_at  TEXT DEFAULT (datetime('now'))
);

-- User-defined phone-number aliases so conversations show "Mom" instead of a raw number.
CREATE TABLE IF NOT EXISTS aliases (
    phone  TEXT PRIMARY KEY,
    alias  TEXT DEFAULT ''
);

-- Appended telemetry samples used to draw battery-over-time. One row per device per UTC minute is the
-- maximum (deduped on phone_id + sample_minute) so history stays bounded without dropping data.
CREATE TABLE IF NOT EXISTS device_samples (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_id      TEXT NOT NULL,
    last_battery  INT DEFAULT -1,
    last_power    INT DEFAULT -1,
    last_network  TEXT DEFAULT '',
    sample_minute TEXT NOT NULL,   -- 'YYYY-MM-DDTHH:MM' (UTC) used for the UNIQUE dedup key
    seen_at       TEXT NOT NULL,   -- full-precision ISO timestamp of the sample
    UNIQUE (phone_id, sample_minute)
);
`;

const dbCache = new Map(); // username -> DatabaseSync

/** Open (creating + migrating if needed) a tenant's database and cache the handle. */
function openUserDb(username) {
    if (dbCache.has(username)) {
        return dbCache.get(username);
    }
    fs.mkdirSync(path.dirname(config.userDbPath(username)), { recursive: true });
    const database = new DatabaseSync(config.userDbPath(username));
    database.exec('PRAGMA journal_mode = WAL;');
    database.exec(migrations);
    dbCache.set(username, database);
    return database;
}

function closeUserDb(username) {
    const database = dbCache.get(username);
    if (database) {
        database.close();
        dbCache.delete(username);
    }
}

/** Record the latest device telemetry reported with any request. */
function upsertDeviceState(database, { phoneId, phoneToken, deviceStatus, battery, power, network, seenAt }) {
    database.prepare(
        `INSERT INTO device_state (rowid, phone_id, phone_token, device_status, last_battery, last_power, last_network, last_seen)
         VALUES (1, :phone_id, :phone_token, :device_status, :last_battery, :last_power, :last_network, :last_seen)
         ON CONFLICT(rowid) DO UPDATE SET
            phone_id = excluded.phone_id,
            phone_token = excluded.phone_token,
            device_status = excluded.device_status,
            last_battery = excluded.last_battery,
            last_power = excluded.last_power,
            last_network = excluded.last_network,
            last_seen = excluded.last_seen`
    ).run({
        phone_id: phoneId || '',
        phone_token: phoneToken || '',
        device_status: deviceStatus || '',
        last_battery: battery == null ? -1 : Number(battery),
        last_power: power == null ? -1 : Number(power),
        last_network: network || '',
        last_seen: seenAt || new Date().toISOString()
    });
}

/**
 * Append one battery/telemetry sample for history, deduped to once per device per UTC minute so the
 * samples table stays bounded. Best-effort: never throws.
 */
function recordDeviceSample(database, { phoneId, battery, power, network }) {
    if (!phoneId) return;
    const now = new Date();
    const sampleMinute = now.toISOString().slice(0, 16); // 'YYYY-MM-DDTHH:MM' UTC
    try {
        database.prepare(
            `INSERT OR IGNORE INTO device_samples (phone_id, last_battery, last_power, last_network, sample_minute, seen_at)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).run(phoneId, battery == null ? -1 : Number(battery), power == null ? -1 : Number(power), network || '', sampleMinute, now.toISOString());
    } catch (_) {
        /* dedup / format races are non-fatal */
    }
}

/** Store a forwarded incoming message (SMS or MMS). */
function insertIncoming(database, { sender, recipient, body, messageType, partsJson, sourceTimestamp }) {
    const info = database.prepare(
        `INSERT INTO incoming_messages (sender, recipient, body, message_type, parts_json, source_timestamp)
         VALUES (:sender, :recipient, :body, :messageType, :partsJson, :sourceTimestamp)`
    ).run({
        sender: sender || '',
        recipient: recipient || '',
        body: body || '',
        messageType: messageType || 'sms',
        partsJson: partsJson || '',
        sourceTimestamp: sourceTimestamp || ''
    });
    return Number(info.lastInsertRowid);
}

/** Generate a server-side id for an outgoing message. */
function newOutgoingId() {
    return crypto.randomUUID();
}

/** Queue an outgoing message; returned by the next poll (action=outgoing). */
function enqueueOutgoing(database, { to, message, messageType = 'sms', priority = 0 }) {
    const id = newOutgoingId();
    database.prepare(
        `INSERT INTO outgoing_messages (id, to_number, body, message_type, priority, status)
         VALUES (:id, :to, :body, :messageType, :priority, 'queued')`
    ).run({ id, to, body: message, messageType, priority: Number(priority) || 0 });
    return getOutgoingById(database, id);
}

function getOutgoingById(database, id) {
    return database.prepare('SELECT * FROM outgoing_messages WHERE id = ?').get(id) || null;
}

/** All queued outgoing messages, highest priority first (then oldest), for a poll response. */
function claimQueuedOutgoing(database) {
    return database
        .prepare("SELECT * FROM outgoing_messages WHERE status = 'queued' ORDER BY priority DESC, created_at ASC, id ASC")
        .all();
}

/**
 * Record one gateway event (a request the app sent). `authenticated` is 1 for a signature-verified
 * request and 0 otherwise. Best-effort: never throws, so activity logging can't break request handling.
 */
function recordGatewayEvent(database, { action, authenticated = 1, phoneId, fromNumber, battery, network }) {
    database.prepare(
        `INSERT INTO gateway_events (action, authenticated, phone_id, from_number, battery, network)
         VALUES (:action, :authenticated, :phone_id, :from_number, :battery, :network)`
    ).run({
        action: action || '',
        authenticated: authenticated ? 1 : 0,
        phone_id: phoneId || '',
        from_number: fromNumber || '',
        battery: battery == null ? -1 : Number(battery),
        network: network || ''
    });
}

/** Recent gateway events for this tenant, newest first. `limit` is clamped to 2000. */
function getGatewayEvents(database, limit = 200) {
    const n = Math.min(parseInt(limit, 10) || 200, 2000);
    return database
        .prepare('SELECT action, authenticated, phone_id, from_number, battery, network, received_at FROM gateway_events ORDER BY id DESC LIMIT ?')
        .all(n) || [];
}

/** Record a send_status report and transition the message out of 'queued'. */
function recordSendStatus(database, serverId, status, error) {
    database.prepare('INSERT INTO send_status_log (server_id, status, error) VALUES (?, ?, ?)')
        .run(serverId, status || '', error || '');
    // Only transition queued -> reported so a message that is never reported keeps being retried on poll.
    const info = database
        .prepare("UPDATE outgoing_messages SET status = ? WHERE id = ? AND status = 'queued'")
        .run(status || '', serverId);
    return info.changes;
}

// --- history / analytics queries ---------------------------------------------------------------

/** Distinct devices that have reported telemetry (phone_id non-empty), most-recent first. */
function listDevices(database) {
    return database
        .prepare("SELECT phone_id, phone_token, device_status, last_battery, last_power, last_network, last_seen FROM device_state WHERE phone_id <> '' ORDER BY last_seen DESC")
        .all() || [];
}

/** All phone-number aliases for this tenant: [{phone, alias}]. Alias may be empty (no alias set). */
function getAliases(database) {
    return database.prepare('SELECT phone, alias FROM aliases').all() || [];
}

/** Set or clear an alias for a phone number. Empty/whitespace alias removes the mapping. */
function upsertAlias(database, { phone, alias }) {
    const p = String(phone == null ? '' : phone).trim();
    if (!p) return;
    const a = (alias == null ? '' : alias).trim();
    if (!a) {
        database.prepare('DELETE FROM aliases WHERE phone = ?').run(p);
        return;
    }
    database.prepare(
        'INSERT INTO aliases (phone, alias) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET alias = excluded.alias'
    ).run(p, a);
}

/** Battery samples for one device within [fromIso, toIso] as {t: isoLabel, level}. */
function getBatterySeries(database, phoneId, fromIso, toIso) {
    if (!phoneId) return [];
    const rows = database
        .prepare('SELECT last_battery AS level, seen_at AS t FROM device_samples WHERE phone_id = ? AND seen_at >= ? AND seen_at <= ? ORDER BY seen_at ASC')
        .all(phoneId, fromIso, toIso);
    return (rows || []).map((r) => ({ t: r.t, level: Number(r.level) == null ? -1 : Number(r.level) }));
}

/**
 * Sent/received message counts bucketed by hour or day within [fromIso, toIso].
 * `bucketKind` is 'hour' or 'day'. Returns { buckets: [{key,label,sent,received}] } with zero-filled
 * gaps walked across the window (clamped so pathological ranges cannot explode memory).
 */
function getMessageCountsByBucket(database, fromIso, toIso, bucketKind) {
    const sentRows = database.prepare('SELECT created_at FROM outgoing_messages WHERE created_at >= ? AND created_at <= ?').all(fromIso, toIso) || [];
    const incRows = database.prepare('SELECT received_at FROM incoming_messages WHERE received_at >= ? AND received_at <= ?').all(fromIso, toIso) || [];

    const hourMs = 3600_000;
    const dayMs = 86_400_000;
    const stepMs = bucketKind === 'hour' ? hourMs : dayMs;

    // Tally raw counts by integer bucket key.
    const sentBy = new Map();
    for (const r of sentRows) {
        const k = Math.floor(Date.parse(parseIso(r.created_at)) / stepMs);
        sentBy.set(k, (sentBy.get(k) || 0) + 1);
    }
    const recvBy = new Map();
    for (const r of incRows) {
        const k = Math.floor(Date.parse(parseIso(r.received_at)) / stepMs);
        recvBy.set(k, (recvBy.get(k) || 0) + 1);
    }

    // Walk the window emitting a label per bucket, filling gaps with zeros.
    const buckets = [];
    let cursor = Math.floor(Date.parse(parseIso(fromIso)) / stepMs) * stepMs;
    const end = Date.parse(parseIso(toIso));
    const MAX_BUCKETS = 400; // guard against absurd ranges (e.g. "all")
    while (cursor <= end && buckets.length < MAX_BUCKETS) {
        const key = Math.floor(cursor / stepMs);
        const label = bucketLabel(key, bucketKind);
        buckets.push({ key, label, sent: sentBy.get(key) || 0, received: recvBy.get(key) || 0 });
        cursor += stepMs;
    }
    return { buckets };
}

/** Inbox messages (all devices), newest first. Optional exact `sender` filter. */
function getInbox(database, { sender = '', limit = 500 } = {}) {
    if (sender) {
        return database.prepare('SELECT id, sender, body, message_type AS type, received_at FROM incoming_messages WHERE sender = ? ORDER BY received_at DESC, id DESC LIMIT ?').all(sender, limit) || [];
    }
    return database.prepare('SELECT id, sender, body, message_type AS type, received_at FROM incoming_messages ORDER BY received_at DESC, id DESC LIMIT ?').all(limit) || [];
}

/** Outbox messages (all devices), newest first. Optional `to` / `status` filters. */
function getOutbox(database, { to = '', status = '', limit = 500 } = {}) {
    if (to && status) {
        return database.prepare('SELECT id, to_number AS "to", body, status, message_type AS type, created_at FROM outgoing_messages WHERE to_number = ? AND status = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(to, status, limit) || [];
    }
    if (to) {
        return database.prepare('SELECT id, to_number AS "to", body, status, message_type AS type, created_at FROM outgoing_messages WHERE to_number = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(to, limit) || [];
    }
    if (status) {
        return database.prepare('SELECT id, to_number AS "to", body, status, message_type AS type, created_at FROM outgoing_messages WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(status, limit) || [];
    }
    return database.prepare('SELECT id, to_number AS "to", body, status, message_type AS type, created_at FROM outgoing_messages ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) || [];
}

/** Distinct conversation partners across all devices with last-activity summary. */
function getConversations(database) {
    const incoming = database.prepare('SELECT sender AS phone, received_at AS ts FROM incoming_messages').all() || [];
    const outgoing = database.prepare('SELECT to_number AS phone, created_at AS ts FROM outgoing_messages').all() || [];

    const map = new Map();
    for (const r of incoming) addPhone(map, r.phone, r.ts, 'received');
    for (const r of outgoing) addPhone(map, r.phone, r.ts, 'sent');

    return Array.from(map.values())
        .map((c) => ({ phone: c.phone, last_body: c.last_body, last_ts: c.last_ts, direction: c.direction, count: c.count }))
        .sort((a, b) => String(b.last_ts).localeCompare(String(a.last_ts)));
}

/** All messages in one conversation (both directions), ascending by time. */
function getConversation(database, phone, ownNumber) {
    const sent = database.prepare('SELECT to_number AS "to", body, message_type AS type, created_at AS ts FROM outgoing_messages WHERE to_number = ? ORDER BY created_at ASC, id ASC').all(phone) || [];
    const received = database.prepare('SELECT sender AS "from", body, message_type AS type, received_at AS ts FROM incoming_messages WHERE sender = ? ORDER BY received_at ASC, id ASC').all(phone) || [];

    const outMsgs = sent.map((m) => ({ direction: 'sent', from: ownNumber || '', to: m.to, body: m.body, type: m.type, ts: m.ts }));
    const inMsgs = received.map((m) => ({ direction: 'received', from: m.from, to: ownNumber || '', body: m.body, type: m.type, ts: m.ts }));
    return outMsgs.concat(inMsgs).sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || (a.id || 0) - (b.id || 0));
}

// --- small helpers ------------------------------------------------------------------------------

function addPhone(map, phone, ts, direction) {
    if (!phone) return;
    const cur = map.get(phone) || { phone, count: 0, last_ts: '', last_body: '', direction: direction === 'sent' ? 'received' : 'sent' };
    // Prefer the more recent message's direction as the conversation's dominant direction.
    if (String(ts) >= String(cur.last_ts)) {
        cur.last_ts = ts;
        cur.direction = direction;
    }
    cur.count += 1;
    map.set(phone, cur);
}

// datetime('now') yields 'YYYY-MM-DD HH:MM:SS' (UTC); parse it as UTC.
function parseIso(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return new Date(0).toISOString();
    let t = s.replace(' ', 'T');
    // Idempotent: only append a timezone designator when the value lacks one, so it is safe to call
    // on both stored datetimes ('YYYY-MM-DD HH:MM:SS') and already-ISO strings ('...Z').
    if (!/[zZ+\-]\d{2}:?\d{2}$/.test(t)) {
        t += 'Z';
    }
    const d = new Date(t);
    return isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

function bucketLabel(key, kind) {
    const d = new Date(key * (kind === 'hour' ? 3600 : 86400) * 1000);
    if (kind === 'hour') return d.toISOString().slice(11, 16); // HH:MM
    return d.toISOString().slice(0, 10);                        // YYYY-MM-DD
}

/** Convenience: row counts in each table (for admin/observability). */
function stats(database) {
    const q = (sql) => database.prepare(sql).get();
    return {
        devices: q("SELECT COUNT(*) AS c FROM device_state").c,
        incoming: q('SELECT COUNT(*) AS c FROM incoming_messages').c,
        outgoing: q('SELECT COUNT(*) AS c FROM outgoing_messages').c,
        statusLog: q('SELECT COUNT(*) AS c FROM send_status_log').c
    };
}

module.exports = {
    openUserDb,
    closeUserDb,
    upsertDeviceState,
    recordDeviceSample,
    insertIncoming,
    enqueueOutgoing,
    getOutgoingById,
    claimQueuedOutgoing,
    recordSendStatus,
    listDevices,
    getBatterySeries,
    getMessageCountsByBucket,
    getInbox,
    getOutbox,
    getConversations,
    getConversation,
    recordGatewayEvent,
    getGatewayEvents,
    getAliases,
    upsertAlias,
    stats
};
