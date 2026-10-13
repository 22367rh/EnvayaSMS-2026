'use strict';

/*
 * End-to-end test for the web dashboard, driven over real HTTP against a live server instance.
 * Exercises the full cookie round-trip and the /<user>/gateway configuration scheme.
 *
 *   node scripts/e2e-console.js
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Throwaway data dirs BEFORE requiring any src module (config reads these at load time).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'envayasms-e2e-console-'));
process.env.CORE_DB = path.join(TMP, 'Core.db');
process.env.DB_DIR = path.join(TMP, 'dbs');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.GATEWAY_MASTER_KEY = 'e2e-master-key';

const { createServer } = require('../src/server');

let passed = 0;
function ok(name, cond) {
    if (cond) { passed++; /* console.log('  \u2713', name); */ }
    else { throw new AssertionError(name); }
}
class AssertionError extends Error {}

// Minimal cookie jar: fetch does not persist cookies between requests.
function makeJar() {
    let cookie = null;
    return {
        header: () => cookie,
        adopt(res) { const h = res.headers.get('set-cookie'); if (!h) return; const m = /session=([^;]+)/.exec(h); cookie = m ? 'session=' + m[1] : null; },
        clear() { cookie = null; }
    };
}

async function jfetch(base, jar, method, p, body) {
    const headers = {};
    if (jar.header()) headers.cookie = jar.header();
    let init = { method, headers };
    if (body !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await fetch(base + p, init);
    jar.adopt(res);
    let json = null;
    try { json = await res.json(); } catch (_) {}
    return { status: res.status, body: json };
}

(async () => {
    const server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    try {
        // Unauthenticated access is rejected (this used to crash the SPA landing page).
        let r = await jfetch(base, makeJar(), 'GET', '/api/me');
        ok('unauth /api/me -> 401', r.status === 401);

        const user = 'e2e_' + Date.now().toString(36);
        r = await jfetch(base, makeJar(), 'POST', '/api/register', { username: user, password: 'hunter2x' });
        ok('register -> 201', r.status === 201 && r.body.user.username === user);

        // Duplicate registration is rejected.
        r = await jfetch(base, makeJar(), 'POST', '/api/register', { username: user, password: 'hunter2x' });
        ok('duplicate register -> 409', r.status === 409);

        // Login then read identity.
        const jar = makeJar();
        await jfetch(base, jar, 'POST', '/api/login', { username: user, password: 'hunter2x' });
        r = await jfetch(base, jar, 'GET', '/api/me');
        ok('login -> /api/me 200 with correct user', r.status === 200 && r.body.user.username === user);

        // Wrong password is rejected (no user enumeration).
        const badJar = makeJar();
        await jfetch(base, badJar, 'POST', '/api/login', { username: user, password: 'WRONG' });
        ok('wrong password -> 401', badJar.header() === null);

        // Config reveals the new path-based server_url and a distinct device secret.
        r = await jfetch(base, jar, 'GET', '/api/config');
        assert.ok(new RegExp('/' + user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/gateway$').test(r.body.server_url), 'server_url=' + r.body.server_url);
        ok('config server_url is /<user>/gateway', new RegExp('^' + base + '/' + user + '/gateway$').test(r.body.server_url));
        ok('shared_secret differs from login password', !!r.body.shared_secret && r.body.shared_secret !== 'hunter2x');

        // Devices empty until a device reports in.
        r = await jfetch(base, jar, 'GET', '/api/devices');
        ok('devices -> [] initially', Array.isArray(r.body.devices) && r.body.devices.length === 0);

        // Per-tenant isolation: a second user gets their own server_url.
        const other = 'e2e_' + (Date.now() + 1) + Math.random().toString(36).slice(2);
        await jfetch(base, makeJar(), 'POST', '/api/register', { username: other, password: 'hunter2x' });
        const jar2 = makeJar();
        await jfetch(base, jar2, 'POST', '/api/login', { username: other, password: 'hunter2x' });
        r = await jfetch(base, jar2, 'GET', '/api/config');
        ok('config is per-user (isolated server_url)', new RegExp('/' + other + '/gateway$').test(r.body.server_url));

        // Changing the login password invalidates existing sessions.
        r = await jfetch(base, jar, 'POST', '/api/change-password', { currentPassword: 'hunter2x', newPassword: 'brandnew9' });
        ok('change-password -> 200', r.status === 200);
        r = await jfetch(base, jar, 'GET', '/api/me'); // old session must be gone
        ok('old session invalidated after password change (401)', r.status === 401);

        // Re-login with the new password works.
        const jar3 = makeJar();
        await jfetch(base, jar3, 'POST', '/api/login', { username: user, password: 'brandnew9' });
        r = await jfetch(base, jar3, 'GET', '/api/me');
        ok('login with new password -> 200', r.status === 200);

        // Logout clears the cookie.
        await jfetch(base, jar3, 'POST', '/api/logout');
        r = await jfetch(base, makeJar(), 'GET', '/api/me');
        ok('after logout /api/me -> 401', r.status === 401);

        console.log(`E2E CONSOLE: ${passed} checks passed`);
    } catch (err) {
        console.error('\n' + err.message);
        process.exitCode = 1;
    } finally {
        server.close();
        try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
        catch (_) { /* best-effort cleanup; Windows may hold DB handles briefly */ }
    }
})();
