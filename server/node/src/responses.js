'use strict';

/*
 * Response rendering that is wire-compatible with server/php/EnvayaSMS.php.
 *
 * Clients with version >= 28 speak JSON ({events:[...]} / {error:{message}}); older clients expect
 * the XML shapes (<response><messages>...</messages></response> and <response><error>..</error></response>).
 * The modern Android build (versionCode 30) always uses JSON, but both paths are implemented so the
 * gateway remains a true drop-in replacement.
 */

// Mirror PHP htmlspecialchars($val, ENT_COMPAT, 'UTF-8'): escape & < > " (not single quotes).
function xmlEscape(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function supportsJson(version) {
    return Number(version) >= 28;
}

/** Build a JSON response object. */
function jsonResponse(events) {
    return `{"events":${JSON.stringify(events || [])}}`;
}

/** Build the legacy XML <response> body carrying events (send/cancel/log/settings). */
function xmlResponse(events) {
    let out = "<?xml version='1.0' encoding='UTF-8'?>\n<response>";
    for (const event of events || []) {
        out += '<messages>';
        if (event && event.event === 'send' && Array.isArray(event.messages)) {
            for (const message of event.messages) {
                const type = message.type || 'sms';
                const id = message.id != null ? ` id="${xmlEscape(message.id)}"` : '';
                const to = message.to != null ? ` to="${xmlEscape(message.to)}"` : '';
                const priority = message.priority != null ? ` priority="${xmlEscape(message.priority)}"` : '';
                out += `<${type}${id}${to}${priority}>${xmlEscape(message.message || '')}</${type}>`;
            }
        }
        out += '</messages>';
    }
    return `${out}</response>`;
}

/** Render a success response (events) in the format matching the client's version. */
function renderResponse(events, version) {
    if (!supportsJson(version)) {
        return { contentType: 'text/xml', body: xmlResponse(events) };
    }
    return { contentType: 'application/json', body: jsonResponse(events) };
}

/** Render an error response in the format matching the client's version. */
function renderError(message, version) {
    if (!supportsJson(version)) {
        return {
            contentType: 'text/xml',
            body: `<?xml version='1.0' encoding='UTF-8'?>\n<response><error>${xmlEscape(message)}</error></response>`
        };
    }
    return { contentType: 'application/json', body: `{"error":{"message":${JSON.stringify(String(message || ''))}}}` };
}

module.exports = { xmlEscape, supportsJson, renderResponse, renderError };
