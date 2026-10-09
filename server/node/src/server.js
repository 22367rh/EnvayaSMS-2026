'use strict';

/*
 * Thin HTTP layer that adapts Node's http.Server to the pure gateway handler in ./gateway.js.
 * It buffers the request body (up to a cap for MMS parts), calls handleRequest(), and writes back the
 * status/content-type/body the handler returns.
 */

const http = require('http');

const { createHandler } = require('./gateway');

function send(res, status, contentType, body) {
    res.writeHead(status, { 'Content-Type': contentType || 'text/plain' });
    res.end(body == null ? '' : String(body));
}

function createServer(deps) {
    const handler = (deps && deps.handler) || createHandler();
    const MAX_BODY = 64 * 1024 * 1024; // 64 MB cap to bound memory for large MMS payloads

    return http.createServer(async (req, res) => {
        try {
            if (req.method !== 'POST' && req.method !== 'GET') {
                send(res, 405, 'text/plain', 'Method Not Allowed');
                return;
            }

            const chunks = [];
            let size = 0;
            await new Promise((resolve, reject) => {
                req.on('data', (chunk) => {
                    size += chunk.length;
                    if (size > MAX_BODY) {
                        req.destroy();
                        const err = Object.assign(new Error('Payload too large'), { statusCode: 413 });
                        reject(err);
                        return;
                    }
                    chunks.push(chunk);
                });
                req.on('end', resolve);
                req.on('error', reject);
            });

            const rawBody = Buffer.concat(chunks).toString('utf8');
            const result = await handler.handleRequest({
                url: req.url,
                method: req.method,
                headers: req.headers,
                rawBody
            });

            send(res, result.status || 200, result.contentType, result.body);
        } catch (err) {
            const status = err && err.statusCode ? err.statusCode : 500;
            send(res, status, 'text/plain', 'Internal Server Error');
            // eslint-disable-next-line no-console
            console.error('[gateway] request error:', err);
        }
    });
}

module.exports = { createServer };
