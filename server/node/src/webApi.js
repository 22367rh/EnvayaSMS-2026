'use strict';

/*
 * Web-dashboard API - a PURE handler (like gateway.js) so it can be unit-tested without a socket.
 *
 * It manages website accounts (login/register/change-password), sessions, the device configuration
 * payload, and read-only analytics/inbox/outbox/conversation queries against each tenant's own DB.
 *
 * handleRequest({ url, method, headers, bodyJson }) returns { status, body, setCookie } where
 *   - status  : HTTP status code (default 200)
 *   - body    : JSON string to send
 *   - setCookie: null | { name, value, maxAgeSeconds, path, httpOnly, sameSite, secure }
 * The HTTP layer in server.js is responsible for turning setCookie into a Set-Cookie header.
 */

const crypto = require('crypto');

const config = require('./config');
const accounts = require('./accounts');
const { decryptSecret } = require('./crypto');

const COOKIE_NAME = 'session';
const SESSION_MAX_AGE_SECONDS = Math.round(accounts.SESSION_TTL_MS / 1000);
const MIN_PASSWORD_LENGTH = 6;

function createWebApi(deps) {
    const core = (deps && deps.coreDb) || require('./coreDb');
    const ud = (deps && deps.userDb) || require('./userDb');

    // --- helpers -----------------------------------------------------------------------------

    function originFrom(headers) {
        if (deps && deps.publicUrl) return deps.publicUrl;
        var proto = headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
        var host = headers['x-forwarded-host'] || headers.host || 'localhost';
        return proto + '://' + host;
    }

    function readToken(cookieHeader) {
        if (!cookieHeader) return null;
        var m = /(?:^|;\s*)session=([^;]+)/.exec(cookieHeader);
        return m ? decodeURIComponent(m[1]) : null;
    }

    function currentUser(headers) {
        var token = readToken(headers.cookie || headers.Cookie);
        return { token: token, username: token ? accounts.loadSession(token) : null };
    }

    function setCookie(token, cleared) {
        if (cleared) {
            return { name: COOKIE_NAME, value: '', maxAgeSeconds: 0, path: '/', httpOnly: true, sameSite: 'Lax', secure: false };
        }
        if (!token) return null;
        return { name: COOKIE_NAME, value: token, maxAgeSeconds: SESSION_MAX_AGE_SECONDS, path: '/', httpOnly: true, sameSite: 'Lax', secure: false };
    }

    function ok(status, payload) {
        return { status: status || 200, body: JSON.stringify(payload) };
    }

    function fail(status, message) {
        return { status: status, body: JSON.stringify({ error: message || 'Request failed' }) };
    }

    function userPayload(row) {
        if (!row) return null;
        return { id: row.id, username: row.username, phone_number: row.phone_number || '', email: row.email || '', created_at: row.created_at || '' };
    }

    // --- routes ------------------------------------------------------------------------------

    function handleRegister(body) {
        var username = (body && body.username) || '';
        var password = body ? String(body.password || '') : '';
        if (!config.isValidUsername(username)) return fail(400, 'Invalid username.');
        if (password.length < MIN_PASSWORD_LENGTH) return fail(400, 'Password must be at least ' + MIN_PASSWORD_LENGTH + ' characters.');

        // Optional primary contact details. Email is validated only when provided; either may be empty.
        var email = body && body.email ? String(body.email).trim() : '';
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, 'Invalid email address.');
        var phoneNumber = body && body.phone_number ? String(body.phone_number).trim() : '';

        // The device shared secret is generated independently and is always different from the login password.
        var sharedSecret = crypto.randomBytes(12).toString('hex');
        try {
            core.createAccount({ username: username, password: password, sharedSecret: sharedSecret, email: email, phoneNumber: phoneNumber });
        } catch (err) {
            if (err.code === 'USER_EXISTS') return fail(409, 'That username is already taken.');
            throw err;
        }
        var token = accounts.issueSession(username);
        var user = core.getUserByUsername(username);
        return Object.assign(ok(201, { ok: true, user: userPayload(user) }), { setCookie: setCookie(token) });
    }

    function handleLogin(body) {
        var username = (body && body.username) || '';
        var password = body ? String(body.password || '') : '';
        if (!username || !password) return fail(400, 'Username and password are required.');
        var row = core.getUserRowForAuth(username);
        // Constant-time-ish: treat a missing user the same as a wrong password to avoid enumeration.
        var okLogin = !!row && typeof row.password_hash === 'string' && accounts.verifyPassword(password, row.password_hash);
        if (!okLogin) return fail(401, 'Invalid username or password.');
        var token = accounts.issueSession(username);
        var user = core.getUserByUsername(username);
        return Object.assign(ok(200, { ok: true, user: userPayload(user) }), { setCookie: setCookie(token) });
    }

    function handleLogout(headers) {
        var tok = currentUser(headers).token;
        if (tok) accounts.destroySession(tok);
        return Object.assign(ok(200, { ok: true }), { setCookie: setCookie(null, true) });
    }

    function requireUser(headers) {
        var username = currentUser(headers).username;
        if (!username) throw new AuthError(401, 'Not logged in.');
        return username;
    }

    function handleMe(headers) {
        var username = requireUser(headers);
        var row = core.getUserByUsername(username);
        return ok(200, { user: userPayload(row) });
    }

    function handleChangePassword(headers, body) {
        var username = requireUser(headers);
        var current = body ? String(body.currentPassword || '') : '';
        var next = body ? String(body.newPassword || '') : '';
        if (next.length < MIN_PASSWORD_LENGTH) return fail(400, 'Password must be at least ' + MIN_PASSWORD_LENGTH + ' characters.');
        var row = core.getUserRowForAuth(username);
        if (!row || !accounts.verifyPassword(current, row.password_hash)) return fail(401, 'Current password is incorrect.');
        core.setLoginPassword(username, next);
        accounts.clearSessionsForUser(username); // force re-login everywhere with the new password
        return ok(200, { ok: true });
    }

    function handleConfig(headers) {
        var username = requireUser(headers);
        var row = core.getUserByUsername(username);
        if (!row) throw new AuthError(404, 'Unknown user.');
        var sharedSecret = decryptSecret(row.password_enc);
        var serverUrl = originFrom(headers) + '/' + username + '/gateway';
        return ok(200, {
            server_url: serverUrl,
            username: username,
            shared_secret: sharedSecret,
            signature_note: 'This is the secret your devices use to sign requests. Keep it private.'
        });
    }

    function handleDevices(headers) {
        var username = requireUser(headers);
        var db = ud.openUserDb(username);
        return ok(200, { devices: ud.listDevices(db) });
    }

    function historyRange(rangePreset, explicitFrom, explicitTo) {
        var now = new Date();
        var from, to;
        if (explicitFrom || explicitTo) {
            from = explicitFrom ? new Date(explicitFrom) : new Date(now.getTime() - 7 * 86400000);
            to = explicitTo ? new Date(explicitTo) : now;
        } else {
            var days = { '24h': 1, '7d': 7, '30d': 30 }[rangePreset] || 7;
            from = new Date(now.getTime() - days * 86400000);
            to = now;
        }
        if (from > to) { var _t = from; from = to; to = _t; }
        var spanMs = to.getTime() - from.getTime();
        return {
            fromIso: from.toISOString(),
            toIso: to.toISOString(),
            bucketKind: spanMs <= 24 * 3600 * 1000 ? 'hour' : 'day'
        };
    }

    function handleHistory(headers, searchParams) {
        var username = requireUser(headers);
        var db = ud.openUserDb(username);
        var rangePreset = searchParams.get('range') || '7d';
        var device = searchParams.get('device') || '';
        var explicitFrom = searchParams.get('from');
        var explicitTo = searchParams.get('to');
        var rng = historyRange(rangePreset, explicitFrom, explicitTo);
        return ok(200, {
            device: device,
            range: { from: rng.fromIso, to: rng.toIso, bucketKind: rng.bucketKind },
            battery: ud.getBatterySeries(db, device, rng.fromIso, rng.toIso),
            buckets: ud.getMessageCountsByBucket(db, rng.fromIso, rng.toIso, rng.bucketKind).buckets
        });
    }

    function handleInbox(headers, searchParams) {
        var username = requireUser(headers);
        var db = ud.openUserDb(username);
        var sender = searchParams.get('sender') || '';
        var limit = Math.min(parseInt(searchParams.get('limit') || '500', 10) || 500, 2000);
        return ok(200, { messages: ud.getInbox(db, { sender: sender, limit: limit }) });
    }

    function handleOutbox(headers, searchParams) {
        var username = requireUser(headers);
        var db = ud.openUserDb(username);
        var to = searchParams.get('to') || '';
        var status = searchParams.get('status') || '';
        var limit = Math.min(parseInt(searchParams.get('limit') || '500', 10) || 500, 2000);
        return ok(200, { messages: ud.getOutbox(db, { to: to, status: status, limit: limit }) });
    }

    function handleConversations(headers) {
        var username = requireUser(headers);
        var db = ud.openUserDb(username);
        return ok(200, { conversations: ud.getConversations(db) });
    }

    function handleConversation(headers, searchParams) {
        var username = requireUser(headers);
        var phone = searchParams.get('phone') || '';
        if (!phone) return fail(400, 'Missing ?phone= parameter.');
        var db = ud.openUserDb(username);
        var ownNumber = (core.getUserByUsername(username).phone_number) || '';
        return ok(200, { phone: phone, messages: ud.getConversation(db, phone, ownNumber) });
    }

    function handleGetAliases(headers) {
        var username = requireUser(headers);
        var db = ud.openUserDb(username);
        return ok(200, { aliases: ud.getAliases(db) });
    }

    function handleUpsertAlias(headers, body) {
        var username = requireUser(headers);
        var phone = (body && String(body.phone || '').trim());
        if (!phone) return fail(400, 'Missing phone number.');
        var alias = body ? String(body.alias || '') : '';
        var db = ud.openUserDb(username);
        ud.upsertAlias(db, { phone: phone, alias: alias });
        return ok(200, { aliases: ud.getAliases(db) });
    }

    // --- dispatch ----------------------------------------------------------------------------

    function AuthError(status, message) {
        this.name = 'AuthError';
        this.statusCode = status;
        this.message = message || 'Forbidden';
    }
    AuthError.prototype = Object.create(Error.prototype);

    async function handle(req) {
        var url = req.url, method = req.method, headers = req.headers || {}, bodyJson = req.bodyJson;
        var parsedUrl = new URL(url, 'http://localhost');
        var path = parsedUrl.pathname;
        var searchParams = parsedUrl.searchParams;
        var body = bodyJson && typeof bodyJson === 'object' ? bodyJson : {};

        try {
            if (path === '/api/register' && method === 'POST') return handleRegister(body);
            if (path === '/api/login' && method === 'POST') return handleLogin(body);
            if (path === '/api/logout' && method === 'POST') return handleLogout(headers);
            if (path === '/api/me' && method === 'GET') return handleMe(headers);
            if (path === '/api/change-password' && method === 'POST') return handleChangePassword(headers, body);
            if (path === '/api/config' && method === 'GET') return handleConfig(headers);
            if (path === '/api/devices' && method === 'GET') return handleDevices(headers);
            if (path === '/api/history' && method === 'GET') return handleHistory(headers, searchParams);
            if (path === '/api/inbox' && method === 'GET') return handleInbox(headers, searchParams);
            if (path === '/api/outbox' && method === 'GET') return handleOutbox(headers, searchParams);
            if (path === '/api/conversations' && method === 'GET') return handleConversations(headers);
            if (path === '/api/conversation' && method === 'GET') return handleConversation(headers, searchParams);
            if (path === '/api/aliases' && method === 'GET') return handleGetAliases(headers);
            if (path === '/api/aliases' && method === 'POST') return handleUpsertAlias(headers, body);

            return fail(404, 'Not found.');
        } catch (err) {
            if (err instanceof AuthError) return fail(err.statusCode, err.message);
            // eslint-disable-next-line no-console
            console.error('[webapi] error:', err);
            return fail(500, 'Internal server error.');
        }
    }

    return { handle: handle };
}

module.exports = { createWebApi };
