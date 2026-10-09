'use strict';

/*
 * Access to the shared "Core" database (Core.db). This holds ONLY account/identity data:
 * one row per tenant with its login credential (the shared secret, encrypted at rest) and profile.
 *
 * Messaging/device data for a tenant lives in a SEPARATE <user>.db file — see userDb.js. Keeping the
 * two apart is what gives each tenant isolation while letting one server serve many tenants.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const config = require('./config');
const { encryptSecret } = require('./crypto');

let db = null;

function ensureDirs() {
    for (const dir of [path.dirname(config.coreDbPath), config.dbDir, config.mediaDir]) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/** Open (creating if needed) and migrate the Core database. Safe to call multiple times. */
function getDb() {
    if (db) return db;
    ensureDirs();
    db = new DatabaseSync(config.coreDbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT NOT NULL UNIQUE,
            password_enc  TEXT NOT NULL,          -- AES-GCM(encrypted shared secret) or plaintext if no master key
            phone_number  TEXT DEFAULT '',
            created_at    TEXT NOT NULL DEFAULT (datetime('now')),
            active        INTEGER NOT NULL DEFAULT 1
        );
    `);
    return db;
}

/** Insert a new user. Throws if the username already exists. */
function createUser(username, passwordPlaintext, phoneNumber) {
    const users = getDb().prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (users) {
        throw Object.assign(new Error(`User "${username}" already exists`), { code: 'USER_EXISTS' });
    }
    const info = getDb()
        .prepare('INSERT INTO users (username, password_enc, phone_number) VALUES (?, ?, ?)')
        .run(username, encryptSecret(passwordPlaintext), phoneNumber || '');
    return getUserById(info.lastInsertRowid);
}

function getUserById(id) {
    const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
    return redact(row);
}

/** Look up a user by username. Returns the row WITH the encrypted secret (for signature verification). */
function getUserByUsername(username) {
    const row = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
    return row || null;
}

/** List tenants without exposing the stored secret material. */
function listUsers() {
    const rows = getDb().prepare('SELECT * FROM users ORDER BY username ASC').all();
    return (rows || []).map(redact);
}

/** Delete a tenant's identity row. Does NOT remove the per-tenant DB file — caller handles that. */
function deleteUser(username) {
    return getDb().prepare('DELETE FROM users WHERE username = ?').run(username).changes;
}

// Strip the secret column before returning rows to callers / API responses.
function redact(row) {
    if (!row) return row;
    const { password_enc: _pw, ...rest } = row;
    void _pw;
    return rest;
}

module.exports = {
    getDb,
    createUser,
    getUserById,
    getUserByUsername,
    listUsers,
    deleteUser
};
