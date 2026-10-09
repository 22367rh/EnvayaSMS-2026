'use strict';

/*
 * Queue an outgoing message for a tenant (the Node equivalent of php example/send_sms.php). The message
 * is returned the next time the app polls with action=outgoing.
 *
 *   node scripts/send-message.js <username> <to> "<message>" [type] [priority]
 */

const coreDb = require('../src/coreDb');
const userDb = require('../src/userDb');

function main() {
    const [, , username, to, message, type = 'sms', priority = '0'] = process.argv.slice(2);

    if (!username || !to) {
        console.error('Usage: node scripts/send-message.js <username> <to> "<message>" [type] [priority]');
        process.exit(1);
    }
    if (!coreDb.getUserByUsername(username)) {
        console.error(`User "${username}" not found. Register it first with register-user.js.`);
        process.exit(1);
    }

    const db = userDb.openUserDb(username);
    const msg = userDb.enqueueOutgoing(db, { to, message: message || '', messageType: type, priority });
    console.log(`Queued outgoing message ${msg.id} for ${username} -> ${to}`);
}

main();
