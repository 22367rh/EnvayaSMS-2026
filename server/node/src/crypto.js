'use strict';

/*
 * Encrypts/decrypts each tenant's shared secret (the app "password" used to sign requests) at rest.
 *
 * When GATEWAY_MASTER_KEY is set, secrets are stored as iv:authTag:ciphertext using AES-256-GCM with a
 * key derived from the master key via scrypt. When it is NOT set, values are stored in plaintext (a
 * startup warning is emitted) so the server still works out of the box — but production deployments
 * MUST set GATEWAY_MASTER_KEY.
 */

const crypto = require('crypto');
const config = require('./config');

function deriveKey(masterKey) {
    return crypto.scryptSync(String(masterKey), 'envayasms/secret:v1', 32);
}

let cachedKey = null;
function getKey() {
    if (!cachedKey && config.masterKey) {
        cachedKey = deriveKey(config.masterKey);
    }
    return cachedKey;
}

/**
 * Store a shared secret. Returns an encrypted string when a master key is configured, otherwise the
 * plaintext (with the plaintext-at-rest warning already logged at startup).
 */
function encryptSecret(plaintext) {
    const key = getKey();
    if (!key) {
        return plaintext == null ? '' : String(plaintext);
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * Recover a plaintext shared secret from a value previously returned by encryptSecret().
 * Returns null if the value could not be decrypted (wrong key / corrupted).
 */
function decryptSecret(encoded) {
    const key = getKey();
    if (!key || encoded == null || encoded === '') {
        return encoded == null ? '' : String(encoded);
    }
    const parts = String(encoded).split(':');
    if (parts.length !== 3) {
        return null;
    }
    const [ivHex, tagHex, encHex] = parts;
    try {
        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            key,
            Buffer.from(ivHex, 'hex')
        );
        decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
        const dec = Buffer.concat([
            decipher.update(Buffer.from(encHex, 'hex')),
            decipher.final()
        ]);
        return dec.toString('utf8');
    } catch (_) {
        return null;
    }
}

module.exports = { encryptSecret, decryptSecret };
