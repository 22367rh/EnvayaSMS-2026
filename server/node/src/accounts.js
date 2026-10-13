'use strict';

/*
 * Website-account authentication helpers — completely separate from the device shared secret.
 *
 *   - Passwords are salted-scrypt hashes (see coreDb.hashPassword / verifyPassword).
 *   - Sessions are opaque random tokens stored in Core.db (`sessions` table) so that changing a
 *     password can invalidate every existing session for that user (force re-login).
 *
 * This module is pure w.r.t. the HTTP layer: it reads/writes Core.db only and returns plain values.
 */

const crypto = require('crypto');
const coreDb = require('./coreDb');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TOKEN_BYTES = 32;

/** Hash a website login password (delegates to coreDb). */
function hashPassword(pw) {
    return coreDb.hashPassword(pw);
}

/** Verify a website login password against a stored scrypt hash. */
function verifyPassword(pw, stored) {
    return coreDb.verifyPassword(pw, stored);
}

/** Create a new session token for a user and persist it. Returns the raw token (caller sets the cookie). */
function issueSession(username) {
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const now = Date.now();
    coreDb.getDb()
        .prepare('INSERT INTO sessions (token, username, created_at, exp_at) VALUES (?, ?, ?, ?)')
        .run(token, username, now, now + SESSION_TTL_MS);
    return token;
}

/** Return the username for a valid, unexpired session token, else null. */
function loadSession(token) {
    if (!token) return null;
    const row = coreDb.getDb()
        .prepare('SELECT username, exp_at FROM sessions WHERE token = ?')
        .get(token);
    if (!row) return null;
    if (Number(row.exp_at) < Date.now()) {
        destroySession(token);
        return null;
    }
    return row.username;
}

/** Destroy a single session token. */
function destroySession(token) {
    coreDb.getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** Destroy every session for a user (used on password change / registration). */
function clearSessionsForUser(username) {
    coreDb.getDb().prepare('DELETE FROM sessions WHERE username = ?').run(username);
}

module.exports = {
    hashPassword,
    verifyPassword,
    issueSession,
    loadSession,
    destroySession,
    clearSessionsForUser,
    SESSION_TTL_MS
};
