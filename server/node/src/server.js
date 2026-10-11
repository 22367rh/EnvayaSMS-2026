'use strict';

/*
 * HTTP layer that adapts Node's http.Server to the two pure handlers:
 *   - /api/* and static assets under public/  -> web dashboard (webApi.js + static files)
 *   - everything else (e.g. gateway.php)        -> multi-tenant gateway (gateway.js)
 *
 * The dashboard API returns JSON and may ask the server to set an httpOnly session cookie via the
 * `setCookie` field of its result; that is turned into a Set-Cookie header here.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { createHandler } = require('./gateway');
const { createWebApi } = require('./webApi');
const config = require('./config');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 64 * 1024 * 1024; // 64 MB cap to bound memory for MMS payloads

var CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8'
};

function send(res, status, contentType, body, extraHeaders) {
    var headers = Object.assign({ 'Content-Type': contentType || 'text/plain' }, extraHeaders || {});
    res.writeHead(status, headers);
    res.end(body == null ? '' : String(body));
}

function sendError(res, status, message) {
    send(res, status, 'text/plain', message || 'Error');
}

function contentTypeFor(filePath) {
    return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/** Serve a file from public/, guarding against path traversal. Returns true if it sent something. */
function serveStatic(res, urlPath) {
    var rel = urlPath === '/' ? '/index.html' : urlPath.replace(/\/+$/, '');
    var safeBase = PUBLIC_DIR.split(path.sep).join('/');
    var filePath = path.normalize(path.join(PUBLIC_DIR, rel)).split(path.sep).join('/');
    if (filePath !== safeBase && filePath.indexOf(safeBase + '/') !== 0) {
        sendError(res, 403, 'Forbidden');
        return true;
    }
    fs.readFile(filePath, function (err, data) {
        if (err) {
            // Bare SPA route with no extension (e.g. /console) -> fall back to <route>.html.
            if (!/\.[a-zA-Z0-9]+$/.test(filePath)) {
                filePath = filePath + '.html';
                return fs.readFile(filePath, function (err2, data2) {
                    if (err2) { sendError(res, 404, 'Not found'); return; }
                    finishStatic(res, filePath, data2);
                });
            }
            sendError(res, 404, 'Not found');
            return;
        }
        finishStatic(res, filePath, data);
    });
    return true;
}

function finishStatic(res, file, data) {
    var cache = 'public, max-age=3600';
    if (file.indexOf('/index.html') !== -1) cache = 'no-cache';
    res.writeHead(200, { 'Content-Type': contentTypeFor(file), 'Cache-Control': cache });
    res.end(data);
}

// True when a GET for this path can be served from disk — either the exact file or a <path>.html SPA shell.
function staticAssetExists(pn) {
    if (fs.existsSync(path.join(PUBLIC_DIR, pn))) return true;
    return !/\.[a-zA-Z0-9]+$/.test(pn) && fs.existsSync(path.join(PUBLIC_DIR, pn + '.html'));
}

function readBody(req) {
    return new Promise(function (resolve, reject) {
        var chunks = [];
        var size = 0;
        req.on('data', function (chunk) {
            size += chunk.length;
            if (size > MAX_BODY) {
                var err = Object.assign(new Error('Payload too large'), { statusCode: 413 });
                req.destroy();
                reject(err);
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', function () { resolve(Buffer.concat(chunks)); });
        req.on('error', reject);
    });
}

function createServer(deps) {
    var gateway = (deps && deps.handler) || createHandler();
    var webApi = (deps && deps.webApi) || createWebApi({ publicUrl: deps && deps.publicUrl });

    return http.createServer(async function (req, res) {
        try {
            if (req.method !== 'POST' && req.method !== 'GET') {
                sendError(res, 405, 'Method Not Allowed');
                return;
            }

            var url = req.url;

            // No favicon on an internal ops console — answer 204 so browsers stop requesting it.
            if (url === '/favicon.ico') { send(res, 204, 'image/x-icon', ''); return; }

            var parsedUrl = new URL(url, 'http://localhost');
            var pathname = parsedUrl.pathname;

            // 1. Dashboard API (JSON in / JSON out, with session cookie).
            if (pathname.indexOf('/api/') === 0) {
                var rawBody = await readBody(req);
                var text = rawBody.toString('utf8');
                var bodyJson = null;
                if (text) {
                    try { bodyJson = JSON.parse(text); } catch (_) { bodyJson = null; }
                }
                var result = await webApi.handle({ url: url, method: req.method, headers: req.headers, bodyJson: bodyJson });
                var extraHeaders = null;
                if (result && result.setCookie) {
                    var c = result.setCookie;
                    var parts = c.name + '=' + encodeURIComponent(c.value);
                    parts += '; Path=' + (c.path || '/');
                    parts += '; HttpOnly';
                    parts += '; SameSite=' + (c.sameSite || 'Lax');
                    if (c.maxAgeSeconds != null) parts += '; Max-Age=' + c.maxAgeSeconds;
                    if (c.secure) parts += '; Secure';
                    extraHeaders = { 'Set-Cookie': parts };
                }
                send(res, result.status || 200, result.contentType || 'application/json', result.body, extraHeaders);
                return;
            }

            // 2. Static dashboard assets.
            if (req.method === 'GET' && (pathname.indexOf('/public/') === 0 || staticAssetExists(pathname))) {
                serveStatic(res, pathname);
                return;
            }

            // 3. Multi-tenant gateway (gateway.php etc.). readBody already returns a single Buffer.
            var rawBody = (await readBody(req)).toString('utf8');
            var result = await gateway.handleRequest({ url: url, method: req.method, headers: req.headers, rawBody: rawBody });
            send(res, result.status || 200, result.contentType, result.body);
        } catch (err) {
            var status = err && err.statusCode ? err.statusCode : 500;
            sendError(res, status, 'Internal Server Error');
            // eslint-disable-next-line no-console
            console.error('[gateway] request error:', err);
        }
    });
}

module.exports = { createServer };
