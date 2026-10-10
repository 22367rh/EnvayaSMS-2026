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

const crypto = require('crypto');

const config = require('./config');
const { encryptSecret } = require('./crypto');

// --- website login password hashing (scrypt, salted) --------------------------------------------
// The website login password is stored ONLY as a salted hash and is deliberately independent of the
// device shared secret (`password_enc`). A user can change it at any time without touching the secret
// their devices use to sign requests.
const SALT_BYTES = 16;
const KEY_BYTES = 32;

function hashPassword(plaintext) {
    const salt = crypto.randomBytes(SALT_BYTES);
    const derived = crypto.scryptSync(String(plaintext), salt, KEY_BYTES);
    return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

function verifyPassword(plaintext, stored) {
    if (typeof stored !== 'string' || !stored.includes('$')) return false;
    const [scheme, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    try {
        const salt = Buffer.from(saltB64, 'base64');
        const derived = crypto.scryptSync(String(plaintext), salt, KEY_BYTES);
        const expected = Buffer.from(hashB64, 'base64');
        if (derived.length !== expected.length) return false;
        return crypto.timingSafeEqual(derived, expected);
    } catch (_) {
        return false;
    }
}

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
            password_hash TEXT NOT NULL DEFAULT '', -- scrypt hash of the WEBSITE login password (distinct from the device secret)
            phone_number  TEXT DEFAULT '',
            created_at    TEXT NOT NULL DEFAULT (datetime('now')),
            active        INTEGER NOT NULL DEFAULT 1
        );
    `);
    // One-time migration for databases created before the website-login split existed.
    ensureColumn(db, 'users', 'password_hash', "TEXT NOT NULL DEFAULT ''");
    db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            token      TEXT PRIMARY KEY,
            username   TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            exp_at     INTEGER NOT NULL
        );
    `);
    return db;
}

// Add a column to an existing table if it is not already present (idempotent migration helper).
function ensureColumn(db, table, col, ddl) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === col)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    }
}

/** Insert a new user. Throws if the username already exists. */
function createUser(username, passwordPlaintext, phoneNumber) {
    const users = getDb().prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (users) {
        throw Object.assign(new Error(`User "${username}" already exists`), { code: 'USER_EXISTS' });
    }
    // A CLI-provisioned tenant needs a usable website login too. Default the login password to the
    // same value (hashed) while the device signing secret is the encrypted copy; they can later be
    // diverged with /api/change-password, which only touches the login credential.
    const info = getDb()
        .prepare('INSERT INTO users (username, password_enc, password_hash, phone_number) VALUES (?, ?, ?, ?)')
        .run(username, encryptSecret(passwordPlaintext), hashPassword(passwordPlaintext), phoneNumber || '');
    return getUserById(info.lastInsertRowid);
}

function getUserById(id) {
    const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
    return redact(row);
}

/** Look up a user by username. Returns the raw row WITH both secret columns (for signature verification). */
function getUserByUsername(username) {
    const row = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
    return row || null;
}

/** Look up a user for WEBSITE auth: returns the raw row including password_hash (+ password_enc). */
function getUserRowForAuth(username) {
    const row = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
    return row || null;
}

/**
 * Create a website account. The login `password` is hashed (never stored); `sharedSecret` is the
 * device signing key and is encrypted at rest. They are intentionally independent values.
 */
function createAccount({ username, password, sharedSecret, phoneNumber }) {
    const users = getDb().prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (users) {
        throw Object.assign(new Error(`User "${username}" already exists`), { code: 'USER_EXISTS' });
    }
    const info = getDb()
        .prepare('INSERT INTO users (username, password_enc, password_hash, phone_number) VALUES (?, ?, ?, ?)')
        .run(username, encryptSecret(sharedSecret), hashPassword(password), phoneNumber || '');
    return getUserById(info.lastInsertRowid);
}

/** Change the website login password. The device shared secret is left untouched. */
function setLoginPassword(username, newPassword) {
    getDb()
        .prepare('UPDATE users SET password_hash = ? WHERE username = ?')
        .run(hashPassword(newPassword), username);
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

// Strip BOTH secret columns (encrypted shared secret + login-password hash) before returning rows to
// callers / API responses. Callers that need a specific secret use an explicit accessor.
function redact(row) {
    if (!row) return row;
    const { password_enc: _pw, password_hash: _hash, ...rest } = row;
    void _pw;
    void _hash;
    return rest;
}

module.exports = {
    getDb,
    ensureColumn,
    createUser,
    createAccount,
    setLoginPassword,
    getUserById,
    getUserByUsername,
    getUserRowForAuth,
    listUsers,
    deleteUser,
    hashPassword,
    verifyPassword
};
