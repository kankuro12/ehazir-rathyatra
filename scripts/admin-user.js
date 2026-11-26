// Create an admin or reset their password. Usage: node scripts/admin-user.js <username>
// The password is typed at a hidden prompt and stored only as a scrypt hash in the database —
// never in .env, never as a command-line argument.
require('dotenv').config({ quiet: true });
const { open } = require('../db');
const { hashPassword } = require('../auth');
const { askPassword, closeAsk } = require('./ask');

const VALID = /^[a-z0-9._-]{3,64}$/;

function saveAdmin(db, user, pw) {
  db.prepare('INSERT INTO admins (username, pass) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET pass=excluded.pass').run(user, hashPassword(pw));
  // a password change signs out every existing session of that admin
  db.prepare('DELETE FROM sessions WHERE admin_id=(SELECT id FROM admins WHERE username=?)').run(user);
}

if (require.main === module) {
  const user = String(process.argv[2] || '').trim().toLowerCase();
  if (!VALID.test(user)) { console.error('usage: node scripts/admin-user.js <username>  (3-64 chars: a-z 0-9 . _ -)'); process.exit(1); }
  if (!process.stdin.isTTY) { console.error('run this in an interactive terminal (password is typed at a hidden prompt)'); process.exit(1); }
  askPassword().then((pw) => { saveAdmin(open(), user, pw); console.log(`admin "${user}" saved`); closeAsk(); });
}

module.exports = { saveAdmin, VALID };
