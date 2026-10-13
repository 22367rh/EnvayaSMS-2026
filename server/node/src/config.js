'use strict';

/*
 * Central configuration, loaded from environment variables with sane defaults so the
 * server runs out of the box (`node bin/start.js`) while remaining fully configurable
 * for production deployment.
 *
 *   PORT                       TCP port to listen on                 (default: 8002)
 *   HOST                       Interface to bind                      (default: "0.0.0.0")
 *   CORE_DB                    Path to the shared user database       (default: ./data/Core.db)
 *   DB_DIR                     Directory holding per-tenant <user>.db files (default: ./data/dbs)
 *   MEDIA_DIR                  Directory for stored MMS parts         (default: ./data/media)
 *   GATEWAY_MASTER_KEY         Master key used to encrypt the shared secret at rest.
 *                              If unset, secrets are stored in plaintext with a warning.
 *                              (recommended: set this to a long random string)
 */

// Silence only the node:sqlite ExperimentalWarning so logs stay clean; keep every other
// warning visible. Emitted as process.emit('warning', '<message>', 'ExperimentalWarning').
(function silenceSqliteWarning() {
    const originalEmit = process.emit.bind(process);
    process.emit = function (event, ...args) {
        if (event === 'warning') {
            const msg = String(args[0] || '');
            if (/node:sqlite|SQLite/i.test(msg)) {
                return false;
            }
        }
        return originalEmit(event, ...args);
    };
})();

function requireEnv(name, fallback) {
    const value = process.env[name];
    return value === undefined || value === '' ? fallback : value;
}

const CORE_DB = requireEnv('CORE_DB', `${process.cwd()}/data/Core.db`);
const DB_DIR = requireEnv('DB_DIR', `${process.cwd()}/data/dbs`);
const MEDIA_DIR = requireEnv('MEDIA_DIR', `${process.cwd()}/data/media`);
const MASTER_KEY = process.env.GATEWAY_MASTER_KEY || '';

if (!MASTER_KEY) {
    // eslint-disable-next-line no-console
    console.warn(
        '[config] WARNING: GATEWAY_MASTER_KEY is not set. The shared secret will be stored in ' +
            'PLAINTEXT. Set GATEWAY_MASTER_KEY to a long random value to encrypt secrets at rest.'
    );
}

const config = {
    port: parseInt(process.env.PORT || '8002', 10),
    host: process.env.HOST || '0.0.0.0',
    coreDbPath: CORE_DB,
    dbDir: DB_DIR,
    mediaDir: MEDIA_DIR,
    masterKey: MASTER_KEY,
    // Username characters allowed in the gateway URL and on disk. Anything else is rejected to
    // prevent path traversal (e.g. "?user=../../etc") and injection into file paths / SQL.
    usernamePattern: /^[A-Za-z0-9._-]+$/,
    // HTTP header carrying the request signature, matching the Android client.
    signatureHeader: 'X-Request-Signature'
};

/**
 * Validate a requested tenant name. Returns true if it is safe to use as a path segment and DB file.
 */
config.isValidUsername = function (username) {
    return typeof username === 'string' && username.length > 0 && username.length <= 128 &&
        config.usernamePattern.test(username);
};

/** Absolute, normalized filesystem path for a tenant's database file. Never returns outside DB_DIR. */
config.userDbPath = function (username) {
    return require('path').join(config.dbDir, `${username}.db`);
};

/** Absolute, normalized filesystem path for storing a tenant's MMS part files. */
config.mediaDirFor = function (username) {
    return require('path').join(config.mediaDir, username);
};

module.exports = config;
