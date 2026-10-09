'use strict';

/*
 * Register a new tenant (like creating an account on the platform). Stores the login credential and
 * profile in Core.db and creates/initializes the separate <user>.db that will hold its messaging data.
 *
 *   node scripts/register-user.js <username> <password> [phone_number]
 */

const coreDb = require('../src/coreDb');
const userDb = require('../src/userDb');
const config = require('../src/config');

function main() {
    const [, , username, password, phoneNumber] = process.argv.slice(2);

    if (!username || !password) {
        console.error('Usage: node scripts/register-user.js <username> <password> [phone_number]');
        process.exit(1);
    }
    if (!config.isValidUsername(username)) {
        console.error('Invalid username. Allowed characters: letters, digits, . _ -');
        process.exit(1);
    }

    try {
        const user = coreDb.createUser(username, password, phoneNumber || '');
        userDb.openUserDb(username); // create + migrate the per-tenant DB immediately
        console.log(`Registered tenant "${username}" (id=${user.id}).`);
        console.log(`  Core db:   ${config.coreDbPath}`);
        console.log(`  Tenant db: ${config.userDbPath(username)}`);
    } catch (err) {
        if (err.code === 'USER_EXISTS') {
            console.error(err.message);
            process.exit(1);
        }
        throw err;
    }
}

main();
