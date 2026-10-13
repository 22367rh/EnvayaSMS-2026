'use strict';

/*
 * Minimal, dependency-free parsers for the two content-types the app uses:
 *   - application/x-www-form-urlencoded  (SMS forward, poll, status reports, ...)
 *   - multipart/form-data                (MMS forward: text fields + binary partN files)
 *
 * Form values are percent-decoded (+ -> space), matching PHP's $_POST. Multipart field values are
 * raw bytes (not percent-encoded), so they are stored verbatim; file parts (filename present) are
 * separated out because they do NOT participate in the request signature (like PHP $_FILES).
 */

function decodeComponent(value) {
    try {
        return decodeURIComponent(String(value).replace(/\+/g, ' '));
    } catch (_) {
        return String(value);
    }
}

function parseFormUrlEncoded(rawBody) {
    const params = {};
    if (!rawBody) return params;
    for (const pair of String(rawBody).split('&')) {
        if (pair === '') continue;
        const idx = pair.indexOf('=');
        const keyRaw = idx === -1 ? pair : pair.slice(0, idx);
        const valRaw = idx === -1 ? '' : pair.slice(idx + 1);
        params[decodeComponent(keyRaw)] = decodeComponent(valRaw);
    }
    return params;
}

function parseMultipart(rawBody, boundary) {
    const params = {};
    const files = [];
    if (!rawBody || !boundary) return { params, files };
    // Split on the MIME boundary. Each part is delimited by "--<boundary>" and terminated by CRLF.
    for (const part of String(rawBody).split(`--${boundary}`)) {
        if (part.startsWith('--') || !part.includes('Content-Disposition')) continue;
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = part.slice(0, headerEnd);
        let body = part.slice(headerEnd + 4);
        if (body.endsWith('\r\n')) body = body.slice(0, -2);

        const nameMatch = /name="([^"]*)"/.exec(headers);
        const fileMatch = /filename="([^"]*)"/.exec(headers);
        const name = nameMatch ? nameMatch[1] : null;
        if (!name) continue;

        if (fileMatch && fileMatch[1] !== '') {
            files.push({ name, filename: fileMatch[1], body });
        } else {
            params[name] = body;
        }
    }
    return { params, files };
}

module.exports = { parseFormUrlEncoded, parseMultipart, decodeComponent };
