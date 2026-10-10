'use strict';

/*
 * Gateway request handler — the heart of the multi-tenant server.
 *
 * For every request it:
 *   1. Parses the tenant (username) from the URL query string (?user=<tenant>). This is what makes a
 *      single server serve many isolated tenants, and keeping it in the URL also keeps it inside the
 *      signed request so no client change is required.
 *   2. Verifies the X-Request-Signature header against Base64(SHA1(url + sortedParams + secret)).
 *   3. Routes to the tenant's own database for all messaging/device persistence.
 *   4. Returns a JSON (version >= 28) or XML response, byte-compatible with server/php/EnvayaSMS.php.
 *
 * handleRequest() is pure w.r.t. I/O: it takes {url, method, headers, rawBody} and returns
 * {status, contentType, body}, which makes it trivial to unit-test without a live socket.
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const signature = require('./signature');
const responses = require('./responses');
const bodyParser = require('./bodyParser');

function createHandler(deps) {
    const core = (deps && deps.coreDb) || require('./coreDb');
    const ud = (deps && deps.userDb) || require('./userDb');

    function requestProto(reqHeaders, socket) {
        if (reqHeaders['x-forwarded-proto'] === 'https') return 'https';
        if (socket && socket.encrypted) return 'https';
        return 'http';
    }

    function storeMmsParts(tenant, files) {
        // Best-effort persistence of binary MMS parts to disk, mirroring the PHP example's mms_parts/ copy.
        try {
            const dir = config.mediaDirFor(tenant);
            fs.mkdirSync(dir, { recursive: true });
            for (const file of files) {
                const ext = path.extname(file.filename || '').replace(/^\./, '') || 'bin';
                const outName = `${Date.now()}-${Math.random().toString(16).slice(2)}${path.extname(file.filename || '')}`;
                fs.writeFileSync(path.join(dir, outName), Buffer.from(file.body, 'binary'));
            }
        } catch (err) {
            // Never fail a request because part storage failed.
            void err;
        }
    }

    function upsertDeviceTelemetry(database, params) {
        if (!params.phone_id && !params.phone_token) return;
        const nowMs = Number(params.now) || Date.now();
        ud.upsertDeviceState(database, {
            phoneId: params.phone_id,
            phoneToken: params.phone_token,
            deviceStatus: params.status || '',
            battery: params.battery,
            power: params.power,
            network: params.network,
            seenAt: new Date(nowMs).toISOString()
        });
        ud.recordDeviceSample(database, {
            phoneId: params.phone_id,
            battery: params.battery,
            power: params.power,
            network: params.network
        });
    }

    function successResponse(events, version) {
        return responses.renderResponse(events, version);
    }

    function errorResponse(message, version) {
        // Constant message for any authentication failure avoids enumerating valid tenants.
        return Object.assign(responses.renderError('Invalid password', version), { status: 403 });
    }

    function unsupportedAction(version) {
        return Object.assign(
            responses.renderError('The server does not support the requested action.', version),
            { status: 404 }
        );
    }

    // --- per-action handlers -------------------------------------------------------------------

    function handleIncoming(database, params, files, tenant, version) {
        ud.insertIncoming(database, {
            sender: params.from || '',
            recipient: '',
            body: params.message || '',
            messageType: params.message_type || 'sms',
            partsJson: params.mms_parts || '',
            sourceTimestamp: params.timestamp || ''
        });
        if (files && files.length) storeMmsParts(tenant, files);
        // AUTO_REPLY=on echoes the message back as a send event (like the PHP example). Off by default so
        // the platform gateway does not invent behaviour; operators can enable it.
        let events = [];
        if (process.env.AUTO_REPLY === 'on' || process.env.AUTO_REPLY === '1') {
            events = [{ event: 'send', messages: [{ type: params.message_type || 'sms', id: '', to: params.from, message: params.message || '' }] }];
        }
        return successResponse(events, version);
    }

    function handleForwardSent(database, params, version) {
        ud.insertIncoming(database, {
            sender: '',
            recipient: params.to || '',
            body: params.message || '',
            messageType: params.message_type || 'sms',
            partsJson: params.mms_parts || '',
            sourceTimestamp: params.timestamp || ''
        });
        return successResponse([], version);
    }

    function handlePoll(database, version) {
        const rows = ud.claimQueuedOutgoing(database);
        if (!rows.length) return successResponse([], version);
        const messages = rows.map((r) => ({
            type: r.message_type || 'sms',
            id: r.id,
            to: r.to_number,
            priority: r.priority,
            message: r.body
        }));
        return successResponse([{ event: 'send', messages }], version);
    }

    function handleSendStatus(database, params) {
        ud.recordSendStatus(database, params.id || '', params.status || '', params.error || '');
        return successResponse([], 28 /* version irrelevant for empty events */);
    }

    function handleDeviceStatus(database, params) {
        return successResponse([], 28);
    }

    // --- top-level dispatch --------------------------------------------------------------------

    async function handleRequest({ url, method = 'POST', headers = {}, rawBody = '' }) {
        const parsedUrl = new URL(url, 'http://localhost');
        const tenant = parsedUrl.searchParams.get('user');

        // 1. Parse body (form or multipart) into decoded params (+ file parts for multipart).
        const contentType = String(headers['content-type'] || '');
        let params;
        let files = [];
        if (/multipart\/form-data/i.test(contentType)) {
            const boundaryMatch = /boundary="?([^";]+)"?/i.exec(contentType);
            ({ params, files } = bodyParser.parseMultipart(rawBody, boundaryMatch ? boundaryMatch[1] : null));
        } else {
            params = bodyParser.parseFormUrlEncoded(rawBody);
        }

        const version = params.version;
        const headerName = config.signatureHeader.toLowerCase();
        const providedSignature = headers[headerName] || headers['x-request-signature'] || '';

        // 2. Tenant must be present, well-formed, and authenticated before any DB access.
        if (!tenant || !config.isValidUsername(tenant)) {
            return Object.assign(responses.renderError('Missing or invalid ?user= tenant', version), { status: 403 });
        }
        const userRow = core.getUserByUsername(tenant);
        if (!userRow) {
            return errorResponse(null, version);
        }
        const secret = require('./crypto').decryptSecret(userRow.password_enc);

        const proto = requestProto(headers, {});
        const fullUrl = `${proto}://${headers.host || 'localhost'}${url}`;
        if (!signature.verifySignature(fullUrl, params, providedSignature, secret)) {
            return errorResponse(null, version);
        }

        // 3. Tenant-scoped persistence for all messaging/device data.
        const database = ud.openUserDb(tenant);
        upsertDeviceTelemetry(database, params);

        switch (params.action) {
            case 'incoming':
                return handleIncoming(database, params, files, tenant, version);
            case 'forward_sent':
                return handleForwardSent(database, params, version);
            case 'outgoing':
                return handlePoll(database, version);
            case 'send_status':
                return handleSendStatus(database, params, version);
            case 'device_status':
                return handleDeviceStatus(database, params, version);
            case 'test':
                return successResponse([], version);
            case 'amqp_started':
                return successResponse([], version);
            default:
                return unsupportedAction(version);
        }
    }

    return { handleRequest };
}

module.exports = { createHandler };
