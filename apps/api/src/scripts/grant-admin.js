import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readConfig } from '../config.js';
import { closeDatabase, migrateDatabase, openDatabase } from '../database.js';
import { audit } from '../ids.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('Usage: npm run admin:grant -- user@example.com');
  process.exit(2);
}
const db = openDatabase(readConfig().databasePath);
migrateDatabase(db);
try {
  const user = db.prepare('SELECT id,email FROM users WHERE email=? COLLATE NOCASE AND disabled_at IS NULL').get(email);
  if (!user) throw new Error('No active account with that email exists. Create the account first.');
  const terminal = createInterface({ input: stdin, output: stdout });
  const answer = await terminal.question(`Type GRANT ADMIN ${user.email} to continue: `);
  terminal.close();
  if (answer !== `GRANT ADMIN ${user.email}`) throw new Error('Confirmation did not match; no role was changed.');
  db.prepare(`INSERT OR IGNORE INTO user_roles(user_id,role) VALUES (?,'admin')`).run(user.id);
  audit(db, user.id, 'admin.granted_by_cli', 'user', user.id, { email: user.email });
  console.log(`Administrator role assigned to ${user.email}. This command is local-only; no public admin registration exists.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { closeDatabase(db); }
