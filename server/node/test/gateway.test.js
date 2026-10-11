'use strict';

/*
 * Integration tests for the multi-tenant gateway. Runs in its own Node process, so it points config at
 * throwaway temp databases (and a fixed master key) BEFORE requiring the source modules. Exercises the
 * real Core.db + per-user SQLite files end to end: auth/signature routing, every action, tenant
 * isolation, and rejection of bad credentials / tenants.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

// --- throwaway data dirs (must be set before requiring src/config) -------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'envayasms-test-'));
process.env.CORE_DB = path.join(TMP, 'Core.db');
process.env.DB_DIR = path.join(TMP, 'dbs');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.GATEWAY_MASTER_KEY = 'test-master-key-do-not-use-in-prod';

const config = require('../src/config');
const coreDb = require('../src/coreDb');
const userDb = require('../src/userDb');
const signature = require('../src/signature');
const { createHandler } = require('../src/gateway');

// --- independent reference implementation of the signature (does NOT reuse src/signature) ---------
function referenceSignature(url, params, password) {
    // Mirrors PHP exactly: $input = $url; foreach $data $input .= ",$k=$v"; $input .= ",<password>";
    let input = url;
    for (const key of Object.keys(params).sort()) {
        input += `,${key}=${String(params[key])}`;
    }
    const pw = password === undefined || password === null ? '' : String(password);
    input += `,${pw}`;
    return crypto.createHash('sha1').update(input, 'utf8').digest('base64');
}

const handler = createHandler();

function doRequest({ url, params, password }) {
    const fullUrl = `http://localhost${url}`;
    const sig = signature.computeSignature(fullUrl, params, password);
    const bodyPairs = Object.keys(params).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`).join('&');
    const headers = {
        'content-type': 'application/x-www-form-urlencoded',
        host: 'localhost',
        'x-request-signature': sig
    };
    // Normalize the (optional) status field exactly as server.js does.
    return handler.handleRequest({ url, method: 'POST', headers, rawBody: bodyPairs }).then((res) => ({
        status: res.status || 200,
        contentType: res.contentType,
        body: res.body
    }));
}

function jsonOf(result) {
    return JSON.parse(result.body);
}

// --- signature algorithm is pinned against an independent implementation --------------------------
assert.strictEqual(
    signature.computeSignature('http://h/g.php?user=x', { b: '2', a: '1' }, 'pw'),
    referenceSignature('http://h/g.php?user=x', { b: '2', a: '1' }, 'pw')
);

// --- pre-register two tenants -------------------------------------------------------------------
coreDb.createUser('XYZ', 'rosebud', '15550000001');
coreDb.createUser('ABC', 'otherpass', '15550000002');

const { test } = require('node:test');

test('signature: known-answer vector matches the documented algorithm', () => {
    // Base64(sha1("url,a=1,b=2,pw")) computed independently.
    const url = 'http://h/g.php?user=x';
    const expected = referenceSignature(url, { a: '1', b: '2' }, 'pw');
    assert.strictEqual(signature.computeSignature(url, { a: '1', b: '2' }, 'pw'), expected);
});

test('test action returns empty events for a valid tenant', async () => {
    const res = await doRequest({ url: '/XYZ/gateway', params: { version: '30', action: 'test' }, password: 'rosebud' });
    assert.strictEqual(res.status, 200);
    assert.match(res.contentType, /application\/json/);
    assert.deepStrictEqual(jsonOf(res).events, []);
});

test('incoming SMS is stored in the tenant DB and returns a response', async () => {
    const params = {
        version: '30', action: 'incoming', phone_number: '15550000001',
        from: '15551230000', message_type: 'sms', message: 'Hello XYZ', timestamp: '1800000000000'
    };
    const res = await doRequest({ url: '/XYZ/gateway', params, password: 'rosebud' });
    assert.strictEqual(res.status, 200);
    const db = userDb.openUserDb('XYZ');
    const rows = db.prepare('SELECT * FROM incoming_messages WHERE sender = ?').all('15551230000');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].body, 'Hello XYZ');
    assert.strictEqual(rows[0].message_type, 'sms');
});

test('poll (outgoing) returns queued messages as a send event', async () => {
    const db = userDb.openUserDb('XYZ');
    userDb.enqueueOutgoing(db, { to: '15559998888', message: 'Server says hi', priority: 5 });
    const res = await doRequest({ url: '/XYZ/gateway', params: { version: '30', action: 'outgoing' }, password: 'rosebud' });
    assert.strictEqual(res.status, 200);
    const events = jsonOf(res).events;
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, 'send');
    assert.strictEqual(events[0].messages[0].to, '15559998888');
    assert.strictEqual(events[0].messages[0].message, 'Server says hi');
    const serverId = events[0].messages[0].id;

    // send_status transitions the message out of queued and is recorded.
    await doRequest({ url: '/XYZ/gateway', params: { version: '30', action: 'send_status', id: serverId, status: 'sent' }, password: 'rosebud' });
    const msg = userDb.getOutgoingById(db, serverId);
    assert.strictEqual(msg.status, 'sent');
    const logRows = db.prepare('SELECT COUNT(*) AS c FROM send_status_log WHERE server_id = ?').get(serverId);
    assert.strictEqual(logRows.c, 1);
});

test('device_status records telemetry', async () => {
    await doRequest({
        url: '/XYZ/gateway',
        params: { version: '30', action: 'device_status', phone_id: 'dev-xyz-1', battery: '87', power: '1', network: 'WIFI' },
        password: 'rosebud'
    });
    const row = userDb.openUserDb('XYZ').prepare('SELECT * FROM device_state WHERE rowid = 1').get();
    assert.strictEqual(row.phone_id, 'dev-xyz-1');
    assert.strictEqual(Number(row.last_battery), 87);
    assert.strictEqual(row.last_network, 'WIFI');
});

test('MMS forward parses text fields and stores binary parts', async () => {
    const boundary = '----envayapart' + Date.now();
    let body =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="action"\r\n\r\nincoming\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="from"\r\n\r\n15551112222\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="message_type"\r\n\r\nmms\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="message"\r\n\r\nMMS body text\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="parts"; filename="part0.txt"\r\n` +
        `Content-Type: text/plain\r\n\r\npart-one-content\r\n` +
        `--${boundary}--\r\n`;

    const fullUrl = 'http://localhost/XYZ/gateway';
    // The binary part must NOT be in the signature params; only the text fields are.
    const sigParams = { action: 'incoming', from: '15551112222', message: 'MMS body text', message_type: 'mms' };
    const headers = {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        host: 'localhost',
        'x-request-signature': signature.computeSignature(fullUrl, sigParams, 'rosebud')
    };
    const res = await handler.handleRequest({ url: '/XYZ/gateway', method: 'POST', headers, rawBody: body });
    assert.strictEqual(res.status || 200, 200);
    const row = userDb.openUserDb('XYZ').prepare("SELECT * FROM incoming_messages WHERE message_type='mms' AND sender='15551112222'").get();
    assert.ok(row, 'MMS row should be stored');
    // Binary part persisted to the tenant media dir.
    const files = fs.readdirSync(config.mediaDirFor('XYZ'));
    assert.ok(files.length >= 1, 'at least one MMS part file should be written');
});

test('tenant isolation: ABC cannot read or write XYZ data', async () => {
    // Enqueue for XYZ only.
    userDb.enqueueOutgoing(userDb.openUserDb('XYZ'), { to: '15550001111', message: 'secret for xyz' });

    // ABC poll returns nothing queued.
    const res = await doRequest({ url: '/ABC/gateway', params: { version: '30', action: 'outgoing' }, password: 'otherpass' });
    assert.deepStrictEqual(jsonOf(res).events, []);

    // ABC's DB has no incoming messages; XYZ's does.
    const abcIncoming = userDb.openUserDb('ABC').prepare('SELECT COUNT(*) c FROM incoming_messages').get().c;
    const xyzIncoming = userDb.openUserDb('XYZ').prepare('SELECT COUNT(*) c FROM incoming_messages').get().c;
    assert.strictEqual(abcIncoming, 0);
    assert.ok(xyzIncoming >= 1);
});

test('wrong password is rejected (403)', async () => {
    const res = await doRequest({ url: '/XYZ/gateway', params: { version: '30', action: 'test' }, password: 'WRONG' });
    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(jsonOf(res), { error: { message: 'Invalid password' } });
});

test('missing/invalid gateway path is rejected (403)', async () => {
    // No <user> segment -> does not match /<user>/gateway.
    const res = await doRequest({ url: '/gateway', params: { version: '30', action: 'test' }, password: 'rosebud' });
    assert.strictEqual(res.status, 403);
});

test('path-traversal tenant name is rejected (403)', async () => {
    // URL parsing normalises "../" so this resolves to /secret/gateway -> tenant "secret", which is not
    // a registered user. The path-based scheme cannot inject path separators into the username.
    const res = await doRequest({ url: '/../secret/gateway', params: { version: '30', action: 'test' }, password: 'rosebud' });
    assert.strictEqual(res.status, 403);
});

test('unknown action returns the documented unsupported-action error', async () => {
    const res = await doRequest({ url: '/XYZ/gateway', params: { version: '30', action: 'nope' }, password: 'rosebud' });
    assert.strictEqual(res.status, 404);
    assert.match(jsonOf(res).error.message, /does not support/);
});

test('shared secret is stored encrypted at rest (master key set)', () => {
    const row = coreDb.getUserByUsername('XYZ');
    assert.notStrictEqual(row.password_enc, 'rosebud', 'stored value must not be plaintext');
    // And it decrypts back to the original secret.
    assert.strictEqual(require('../src/crypto').decryptSecret(row.password_enc), 'rosebud');
});
