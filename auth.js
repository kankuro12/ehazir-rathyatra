// Admin auth: scrypt password hashes, server-side sessions in SQLite, CSRF token per session, login rate limit.
const crypto = require('node:crypto');

const SESSION_MS = 12 * 3600 * 1000;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}
// same work for unknown users, so response time doesn't reveal which usernames exist
const DUMMY = hashPassword(crypto.randomBytes(8).toString('hex'));

const cookie = (req, name) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];

function createAuth(db, env = process.env) {
  const hits = new Map();
  const limited = (ip) => {
    const now = Date.now(), list = (hits.get(ip) || []).filter((t) => now - t < 5 * 60 * 1000);
    list.push(now); hits.set(ip, list);
    return list.length > 10;
  };
  const secure = env.COOKIE_SECURE !== '0'; // set COOKIE_SECURE=0 only for local http testing

  function login(req, res) {
    if (limited(req.ip)) return res.status(429).json({ error: 'too many attempts, wait 5 minutes' });
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > 256) return res.status(400).json({ error: 'username and password required' });
    const a = db.prepare('SELECT id, pass FROM admins WHERE username=?').get(username.trim().toLowerCase());
    if (!checkPassword(password, a ? a.pass : DUMMY) || !a) return res.status(401).json({ error: 'invalid username or password' });
    db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    const token = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions (hash, admin_id, csrf, expires) VALUES (?,?,?,?)').run(sha(token), a.id, csrf, Date.now() + SESSION_MS);
    res.set('Set-Cookie', `sid=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`);
    res.json({ ok: true });
  }
  function session(req) {
    const t = cookie(req, 'sid');
    if (!t || !/^[0-9a-f]{64}$/.test(t)) return null;
    const s = db.prepare('SELECT s.hash, s.csrf, s.expires, a.username FROM sessions s JOIN admins a ON a.id=s.admin_id WHERE s.hash=?').get(sha(t));
    return s && s.expires > Date.now() ? s : null;
  }
  function logout(req, res) {
    const s = session(req);
    if (s) db.prepare('DELETE FROM sessions WHERE hash=?').run(s.hash);
    res.set('Set-Cookie', `sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
    res.json({ ok: true });
  }
  // API guard: valid session; changes also need the session's CSRF token in X-CSRF
  function requireAdmin(req, res, next) {
    const s = session(req);
    if (!s) return res.status(401).json({ error: 'login required' });
    if (req.method !== 'GET') {
      const h = Buffer.from(req.get('x-csrf') || ''), want = Buffer.from(s.csrf);
      if (h.length !== want.length || !crypto.timingSafeEqual(h, want)) return res.status(403).json({ error: 'bad csrf token' });
    }
    req.admin = s; next();
  }
  return { login, logout, session, requireAdmin };
}

module.exports = { createAuth, hashPassword, checkPassword };
