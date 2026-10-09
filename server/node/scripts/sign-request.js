'use strict';

/*
 * Build a signed request the same way the Android app does, then print a ready-to-run curl command.
 * Useful for manual end-to-end testing of the gateway without the phone app.
 *
 *   node scripts/sign-request.js --url "http://host/gateway.php?user=XYZ" --password secret \
 *        --field action=incoming --field from=15551230000 --field message="hi there"
 */

const signature = require('../src/signature');

function parseArgs(argv) {
    const args = { url: '', password: '' };
    const fields = [];
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--url') args.url = argv[++i];
        else if (arg === '--password') args.password = argv[++i];
        else if (arg === '--field') fields.push(argv[++i]);
        else if (arg.startsWith('--field=')) fields.push(arg.slice('--field='.length));
    }
    return { url: args.url, password: args.password, fields };
}

function main() {
    const { url, password, fields } = parseArgs(process.argv);

    if (!url || !password) {
        console.error('Usage: sign-request.js --url "<gatewayUrl?user=XYZ>" --password "<secret>" [--field name=value]...');
        process.exit(1);
    }

    const params = {};
    for (const field of fields) {
        const idx = field.indexOf('=');
        const key = idx === -1 ? field : field.slice(0, idx);
        params[key] = idx === -1 ? '' : field.slice(idx + 1);
    }

    const sig = signature.computeSignature(url, params, password);

    let cmd = `curl -sS -X POST "${url}" -H "X-Request-Signature: ${sig}"`;
    for (const key of Object.keys(params).sort()) {
        cmd += ` --data-urlencode "${key}=${params[key]}"`;
    }

    // eslint-disable-next-line no-console
    console.log('# signature = Base64(SHA1(url + sortedParams + password))');
    console.log(sig);
    // eslint-disable-next-line no-console
    console.log(cmd);
}

main();
