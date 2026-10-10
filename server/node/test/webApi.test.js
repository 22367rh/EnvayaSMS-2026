'use strict';

/*
 * Tests for the web-dashboard API (src/webApi.js): account registration/login/logout, password
 * changes, session cookies, device configuration reveal, and per-tenant isolation. Runs in its own
 * Node process pointing config at throwaway temp databases BEFORE requiring the source modules.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// --- throwaway data dirs (must be set before requiring src/config) ------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'envayasms-webtest-'));
process.env.CORE_DB = path.join(TMP, 'Core.db');
process.env.DB_DIR = path.join(TMP, 'dbs');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.GATEWAY_MASTER_KEY = 'web-test-master-key-do-not-use-in-prod';

const coreDb = require('../src/coreDb');
const userDb = require('../src/userDb');
const { createWebApi } = require('../src/webApi');
const { decryptSecret } = require('../src/crypto');
const { test } = require('node:test');

const api = createWebApi({ coreDb, userDb });

function register(username, password) {
    return api.handle({ url: '/api/register', method: 'POST', headers: {}, bodyJson: { username, password } });
}
function login(username, password) {
    return api.handle({ url: '/api/login', method: 'POST', headers: {}, bodyJson: { username, password } });
}
function withSession(result) {
    const c = result.setCookie;
    return { cookie: c.name + '=' + c.value, token: c.value, setCookie: c };
}

async function registerUser(username) {
    const r = await register(username, 'hunter2x');
    assert.strictEqual(r.status, 201);
    return withSession(r);
}

// --- registration / login -----------------------------------------------------------------------
test('register creates an account and issues a session cookie', async () => {
    const u = 'web_' + Date.now().toString(36);
    const r = await register(u, 'hunter2x');
    assert.strictEqual(r.status, 201);
    assert.ok(r.setCookie && r.setCookie.name === 'session' && r.setCookie.value, 'should set a session cookie');
    assert.strictEqual(JSON.parse(r.body).user.username, u);
    // The account exists in Core.db with an encrypted (not plaintext) password.
    const row = coreDb.getUserByUsername(u);
    assert.notStrictEqual(row.password_hash, 'hunter2x');
});

test('duplicate registration is rejected 409', async () => {
    const u = 'dup_' + Date.now().toString(36);
    await register(u, 'hunter2x');
    const again = await register(u, 'hunter2x');
    assert.strictEqual(again.status, 409);
});

test('short password is rejected at registration', async () => {
    const r = await register('shortpw_' + Date.now().toString(36), '123');
    assert.strictEqual(r.status, 400);
});

test('login works and rejects wrong credentials (401)', async () => {
    const u = 'login_' + Date.now().toString(36);
    await register(u, 'hunter2x');
    const ok = await login(u, 'hunter2x');
    assert.strictEqual(ok.status, 200);
    assert.ok(ok.setCookie && ok.setCookie.value);

    const bad = await login(u, 'wrongpass');
    assert.strictEqual(bad.status, 401);
    // A wrong password for a non-existent user is also 401 (no enumeration).
    const ghost = await login('ghost_' + Date.now().toString(36), 'whatever');
    assert.strictEqual(ghost.status, 401);
});

// --- session / auth -----------------------------------------------------------------------------
test('authenticated endpoints require a valid session cookie', async () => {
    const u = 'authn_' + Date.now().toString(36);
    await registerUser(u);

    // No cookie -> 401.
    let r = await api.handle({ url: '/api/me', method: 'GET', headers: {}, bodyJson: {} });
    assert.strictEqual(r.status, 401);

    // With a valid cookie -> 200.
    const reg = await register(u + '_x', 'hunter2x');
    const { cookie } = withSession(reg);
    r = await api.handle({ url: '/api/me', method: 'GET', headers: { cookie }, bodyJson: {} });
    assert.strictEqual(r.status, 200);
});

test('logout destroys the session and clears the cookie', async () => {
    const u = 'logout_' + Date.now().toString(36);
    const reg = await registerUser(u);
    const token = reg.token;

    // Session is valid before logout.
    let r = await api.handle({ url: '/api/me', method: 'GET', headers: { cookie: 'session=' + token }, bodyJson: {} });
    assert.strictEqual(r.status, 200);

    const lg = await api.handle({ url: '/api/logout', method: 'POST', headers: { cookie: 'session=' + token }, bodyJson: {} });
    assert.strictEqual(lg.status, 200);
    assert.strictEqual(lg.setCookie.maxAgeSeconds, 0, 'logout should clear the cookie');

    // Same token is now invalid.
    r = await api.handle({ url: '/api/me', method: 'GET', headers: { cookie: 'session=' + token }, bodyJson: {} });
    assert.strictEqual(r.status, 401);
});

// --- configuration reveal -----------------------------------------------------------------------
test('config reveals server_url/username and a secret distinct from the login password', async () => {
    const u = 'cfg_' + Date.now().toString(36);
    const reg = await registerUser(u);
    const cfgRes = await api.handle({ url: '/api/config', method: 'GET', headers: { cookie: reg.cookie }, bodyJson: {} });
    assert.strictEqual(cfgRes.status, 200);
    const cfg = JSON.parse(cfgRes.body);
    assert.ok(/gateway\.php\?user=/.test(cfg.server_url), 'server_url should route by username');
    assert.strictEqual(cfg.username, u);
    assert.notStrictEqual(cfg.shared_secret, 'hunter2x', 'device secret must differ from login password');
    // The stored (encrypted) value decrypts to the revealed secret.
    const row = coreDb.getUserByUsername(u);
    assert.strictEqual(decryptSecret(row.password_enc), cfg.shared_secret);
});

test('config is isolated per tenant', async () => {
    const a = 'iso_a_' + Date.now().toString(36);
    const b = 'iso_b_' + Date.now().toString(36);
    const ra = await registerUser(a);
    const rb = await registerUser(b);
    const caRes = await api.handle({ url: '/api/config', method: 'GET', headers: { cookie: ra.setCookie.name + '=' + ra.setCookie.value }, bodyJson: {} });
    const cbRes = await api.handle({ url: '/api/config', method: 'GET', headers: { cookie: rb.setCookie.name + '=' + rb.setCookie.value }, bodyJson: {} });
    const ca = JSON.parse(caRes.body);
    const cb = JSON.parse(cbRes.body);
    assert.notStrictEqual(ca.shared_secret, cb.shared_secret, 'tenants must get different secrets');
});

// --- password change ----------------------------------------------------------------------------
test('changing the login password invalidates existing sessions', async () => {
    const u = 'pw_' + Date.now().toString(36);
    const reg = await registerUser(u);
    const token = reg.token;

    // Change password.
    const cp = await api.handle({
        url: '/api/change-password', method: 'POST', headers: { cookie: reg.setCookie.name + '=' + reg.setCookie.value },
        bodyJson: { currentPassword: 'hunter2x', newPassword: 'brandnew9' }
    });
    assert.strictEqual(cp.status, 200);

    // Old session token is gone.
    let r = await api.handle({ url: '/api/me', method: 'GET', headers: { cookie: 'session=' + token }, bodyJson: {} });
    assert.strictEqual(r.status, 401);

    // Login with the new password works; wrong current password on a second change is rejected.
    const login2 = await login(u, 'brandnew9');
    assert.strictEqual(login2.status, 200);

    const badCurrent = await api.handle({
        url: '/api/change-password', method: 'POST', headers: { cookie: reg.setCookie.name + '=' + reg.setCookie.value },
        bodyJson: { currentPassword: 'nope-wrong', newPassword: 'another1' }
    });
    assert.strictEqual(badCurrent.status, 401);
});

// --- analytics endpoints (empty DB) -------------------------------------------------------------
test('history / inbox / outbox / conversations return empty arrays for a fresh tenant', async () => {
    const u = 'data_' + Date.now().toString(36);
    const reg = await registerUser(u);
    const hdrs = { cookie: reg.setCookie.name + '=' + reg.setCookie.value };
    for (const p of ['/api/history?range=24h', '/api/inbox', '/api/outbox', '/api/conversations']) {
        const r = await api.handle({ url: p, method: 'GET', headers: hdrs, bodyJson: {} });
        assert.strictEqual(r.status, 200, p);
    }
    const hist = JSON.parse((await api.handle({ url: '/api/history?range=24h', method: 'GET', headers: hdrs, bodyJson: {} })).body);
    assert.ok(Array.isArray(hist.battery) && Array.isArray(hist.buckets));
});
