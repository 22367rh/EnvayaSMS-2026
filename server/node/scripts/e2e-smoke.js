'use strict';

/*
 * End-to-end smoke test: boots createServer() on an ephemeral port and talks to it over a REAL socket
 * using requests signed by an INDEPENDENT implementation (this file does NOT require src/signature). It
 * proves the whole stack wires up — HTTP body buffering, header extraction, signature verification,
 * tenant routing, and persistence — not just the pure handler.
 *
 *   node scripts/e2e-smoke.js
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Throwaway data dirs + a fixed master key so the run is hermetic.
process.env.GATEWAY_MASTER_KEY = process.env.GATEWAY_MASTER_KEY || 'smoke-key';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'envayasms-smoke-'));
process.env.CORE_DB = process.env.CORE_DB || path.join(TMP, 'Core.db');
process.env.DB_DIR = process.env.DB_DIR || path.join(TMP, 'dbs');
process.env.MEDIA_DIR = process.env.MEDIA_DIR || path.join(TMP, 'media');

const base = process.cwd();
const config = require(path.join(base, 'src/config'));
const coreDb = require(path.join(base, 'src/coreDb'));
const userDb = require(path.join(base, 'src/userDb'));
const { createServer } = require(path.join(base, 'src/server'));

// Independent re-implementation of the documented signature (url + sortedParams + password).
function refSignature(url, params, password) {
    let input = url;
    for (const key of Object.keys(params).sort()) {
        input += `,${key}=${params[key]}`;
    }
    input += `,${password}`;
    return crypto.createHash('sha1').update(input, 'utf8').digest('base64');
}

function post(port, urlPath, params, password) {
    const full = `http://127.0.0.1:${port}${urlPath}`;
    const bodyPairs = Object.keys(params)
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`).join('&');
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port, path: urlPath, method: 'POST' }, // Node sets Host: 127.0.0.1:<port>
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'], body: data }));
            }
        );
        req.on('error', reject);
        req.setHeader('content-type', 'application/x-www-form-urlencoded');
        req.setHeader('x-request-signature', refSignature(full, params, password));
        req.write(bodyPairs);
        req.end();
    });
}

let failures = 0;
function check(label, cond) {
    console.log(`  ${cond ? 'OK  ' : 'FAIL'} - ${label}`);
    if (!cond) failures++;
}

(async () => {
    coreDb.createUser('XYZ', 'rosebud', '15550000001');
    userDb.openUserDb('XYZ');

    const server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    console.log(`server listening on 127.0.0.1:${port}`);

    let r = await post(port, '/XYZ/gateway', { version: '30', action: 'test' }, 'rosebud');
    check('test -> empty events', r.status === 200 && JSON.parse(r.body).events.length === 0);

    userDb.enqueueOutgoing(userDb.openUserDb('XYZ'), { to: '15559998888', message: 'hi over http' });
    r = await post(port, '/XYZ/gateway', { version: '30', action: 'outgoing' }, 'rosebud');
    const ev = JSON.parse(r.body).events;
    check('poll -> queued send event', ev.length === 1 && ev[0].event === 'send' && ev[0].messages[0].to === '15559998888');

    r = await post(port, '/XYZ/gateway', { version: '30', action: 'incoming', from: '15551230000', message_type: 'sms', message: 'hello in' }, 'rosebud');
    check('incoming -> 200 (stored)', r.status === 200);

    r = await post(port, '/XYZ/gateway', { version: '30', action: 'test' }, 'WRONGPASSWORD');
    check('wrong password -> 403 Invalid password', r.status === 403 && /Invalid password/.test(r.body));

    server.close();
    console.log(failures ? 'E2E SMOKE FAILED' : 'E2E SMOKE OK');
    process.exit(failures ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
