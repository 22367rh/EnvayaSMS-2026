'use strict';

/*
 * Request-signature verification that is BYTE-COMPATIBLE with the reference PHP library
 * (server/php/EnvayaSMS.php, EnvayaSMS_Action_Request::compute_signature()).
 *
 * The Android client signs every request as:
 *
 *     signature = Base64( SHA1( url + "," + sortedParams + "," + password ) )
 *
 * where:
 *   - `url`            is the full request URL (protocol://host/path?query) — i.e. exactly what the
 *                      client configured as its Server URL, INCLUDING any ?user=<tenant> query string.
 *   - `sortedParams`   are ALL form fields of the POST body, sorted ascending by field name, joined as
 *                      ",name=value". The query-string tenant (user=) is part of `url`, not a param.
 *   - `password`       is the tenant's shared secret (the app's "password" setting).
 *
 * This mirrors PHP's ksort($data) + concatenation and sha1(..., true) + base64_encode() exactly:
 *   $input = $url; foreach ($data ...) $input .= ",$k=$v"; $input .= ",$password";
 */

const crypto = require('crypto');

// Mirror PHP's default string ordering for keys (ASCII/underscore/digits are the realistic key set);
// a plain code-unit comparison is deterministic and matches ksort for these inputs.
function compareKeys(a, b) {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

/**
 * Compute the expected signature string for the given URL + body params + password.
 * @param {string} url full request URL incl. query string, e.g. "http://host/gateway.php?user=XYZ"
 * @param {Object<string,string>} params decoded form fields (like $_POST), NOT including the tenant
 * @param {string} password shared secret
 * @returns {string} base64(sha1(raw)) signature
 */
function computeSignature(url, params, password) {
    let input = url;
    for (const key of Object.keys(params || {}).sort(compareKeys)) {
        input += `,${key}=${String(params[key])}`;
    }
    const pw = password === undefined || password === null ? '' : String(password);
    input += `,${pw}`;
    return crypto.createHash('sha1').update(input, 'utf8').digest('base64');
}

function safeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) {
        return false;
    }
    try {
        return crypto.timingSafeEqual(bufA, bufB);
    } catch (_) {
        return false;
    }
}

/**
 * Verify an incoming request's signature header against the recomputed value.
 * @returns {boolean} true when a signature is present and matches in constant time
 */
function verifySignature(url, params, providedSignature, password) {
    if (!providedSignature) return false;
    const expected = computeSignature(url, params, password);
    return safeEqual(providedSignature, expected);
}

module.exports = { computeSignature, verifySignature, compareKeys };
