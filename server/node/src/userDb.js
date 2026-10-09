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
    insertIncoming,
    enqueueOutgoing,
    getOutgoingById,
    claimQueuedOutgoing,
    recordSendStatus,
    stats
};
