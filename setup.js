// Interactive setup: writes .env (owner-only permissions) and optionally creates the first admin.
// Usage: node setup.js        — re-run any time; current values are kept when you press Enter.
// Admin passwords are never written to .env: they go to the database as scrypt hashes.
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { ask, askPassword, closeAsk } = require('./scripts/ask');

const ENV = path.join(__dirname, '.env');
const isUrl = (v, localHttp) => { try { const u = new URL(v); return u.protocol === 'https:' || (localHttp && u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname)); } catch { return false; } };

const FIELDS = [
  { k: 'PORT', d: '3100', help: 'HTTP port (nginx proxies to it)', ok: (v) => /^\d+$/.test(v) && +v > 0 && +v < 65536 },
  { k: 'MARGATRACK_URL', d: 'https://margatrack.com', help: 'MargaTrack base URL (http only for localhost)', ok: (v) => isUrl(v, true) },
  { k: 'MARGATRACK_API_KEY', secret: true, help: 'MargaTrack integration key (fk_...)', ok: (v) => /^fk_[0-9a-f]{20,}$/.test(v) },
  { k: 'MARGATRACK_CLIENT_ID', help: 'Client id the integration key is bound to', ok: (v) => /^[\w.-]{1,100}$/.test(v) },
  { k: 'MARGATRACK_VEHICLE_ID', help: 'MargaTrack vehicle id of the Rath GPS device', ok: (v) => /^\d+$/.test(v) },
  { k: 'GOOGLE_MAPS_KEY', help: 'Google Maps JS key (restrict it to your domain in Google Cloud)', ok: (v) => /^[\w-]{20,}$/.test(v) },
  { k: 'COOKIE_SECURE', d: '1', help: '1 = admin cookie only over HTTPS (production). 0 only for local http testing', ok: (v) => v === '0' || v === '1' },
  { k: 'VAPID_SUBJECT', d: 'https://margatrack.com', help: 'Contact for push services (https URL or mailto:)', ok: (v) => isUrl(v) || /^mailto:[^\s@]+@[^\s@]+$/.test(v) },
  { k: 'DB_FILE', d: 'rathyatra.db', help: 'SQLite database file', ok: (v) => /^[\w./\\:-]+\.db$/.test(v) },
];
const DROP = ['ADMIN_PASSWORD', 'ADMIN_TOKEN']; // credentials never belong in .env
const mask = (v) => (v ? `${v.slice(0, 4)}…${v.slice(-3)}` : '');

(async () => {
  if (!process.stdin.isTTY) { console.error('run setup in an interactive terminal'); process.exit(1); }
  const cur = fs.existsSync(ENV) ? dotenv.parse(fs.readFileSync(ENV)) : {};
  console.log(`\nRath Yatra setup — ${fs.existsSync(ENV) ? 'updating' : 'creating'} .env (press Enter to keep the value in [brackets])\n`);
  const out = {};
  for (const f of FIELDS) {
    const have = cur[f.k] ?? f.d ?? '';
    for (;;) {
      console.log(`  ${f.help}`);
      const shown = f.secret ? mask(have) : have;
      const v = (await ask(`  ${f.k}${shown ? ` [${shown}]` : ''}: `, { hidden: !!f.secret })) || have;
      if (/[\r\n"'`$\\]/.test(v)) { console.log('  ✗ value must not contain quotes, $, \\ or newlines\n'); continue; }
      if (!v && !f.ok('')) { console.log('  ✗ required\n'); continue; }
      if (v && !f.ok(v)) { console.log('  ✗ invalid value\n'); continue; }
      out[f.k] = v; console.log(''); break;
    }
  }
  // keep other existing keys (e.g. local emulator settings), drop credentials
  for (const [k, v] of Object.entries(cur)) if (!(k in out) && !DROP.includes(k)) out[k] = v;
  if (out.COOKIE_SECURE === '0') console.log('  ⚠ COOKIE_SECURE=0: use only for local testing, never in production\n');

  const body = `# written by setup.js on ${new Date().toISOString()} — do not commit\n` + Object.entries(out).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  const tmp = `${ENV}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, ENV);
  try { fs.chmodSync(ENV, 0o600); } catch {} // owner read/write only (no-op on Windows)
  console.log(`✓ wrote ${ENV}${DROP.some((k) => k in cur) ? ' (removed old ADMIN_* credential lines)' : ''}\n`);

  // first admin
  process.env.DB_FILE = out.DB_FILE;
  const { open } = require('./db');
  const { saveAdmin, VALID } = require('./scripts/admin-user');
  const db = open(path.resolve(__dirname, out.DB_FILE));
  const admins = db.prepare('SELECT username FROM admins ORDER BY id').all().map((a) => a.username);
  console.log(admins.length ? `Admins: ${admins.join(', ')}` : 'No admin account yet.');
  const want = (await ask(admins.length ? 'Create or reset an admin now? [y/N]: ' : 'Create the first admin now? [Y/n]: ')).toLowerCase();
  if (admins.length ? want === 'y' : want !== 'n') {
    let user;
    do user = (await ask('  Username (a-z 0-9 . _ -): ')).toLowerCase(); while (!VALID.test(user));
    saveAdmin(db, user, await askPassword('  Password'));
    console.log(`✓ admin "${user}" saved (password stored as a hash in the database only)`);
  }
  console.log('\nDone. Start with: npm start\n');
  closeAsk();
})().catch((e) => { console.error(e.message); process.exit(1); });
