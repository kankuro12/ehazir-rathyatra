require('dotenv').config();
const path = require('node:path');
const express = require('express');
const { WebSocket, WebSocketServer } = require('ws');
const { open, savePosition } = require('./db');
const { createAuth } = require('./auth');
const { createAlerts } = require('./alerts');

const FIELDS = ['day', 'date', 'departure', 'via', 'lunch', 'arrival', 'events', 'halt', 'lat', 'lng', 'major'];

function cleanStop(b) {
  const s = {};
  for (const f of FIELDS) s[f] = b?.[f] ?? (f === 'major' ? 0 : '');
  s.day = Number(s.day); s.lat = Number(s.lat); s.lng = Number(s.lng); s.major = s.major ? 1 : 0;
  if (!Number.isInteger(s.day) || s.day < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(s.date) || !String(s.halt).trim()
    || !(Math.abs(s.lat) <= 90) || !(Math.abs(s.lng) <= 180)) return null;
  for (const f of ['departure', 'via', 'lunch', 'arrival', 'events', 'halt']) s[f] = String(s[f]).slice(0, 500);
  return s;
}

function createApp(db, { env = process.env, alerts } = {}) {
  const app = express();
  const auth = createAuth(db, env);
  app.set('trust proxy', 'loopback'); // behind nginx on the same host: real client IP for rate limiting
  app.disable('x-powered-by');
  app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY' }); next(); });
  app.use(express.json({ limit: '20kb' }));

  // ---- admin pages: served only with a valid session ----
  const noStore = (res) => res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
  app.get('/admin', (req, res) => {
    noStore(res);
    if (!auth.session(req)) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'private', 'admin.html'));
  });
  app.get('/login', (req, res) => { noStore(res); res.sendFile(path.join(__dirname, 'private', 'login.html')); });
  app.post('/api/login', auth.login);
  app.post('/api/logout', auth.logout);

  app.use(express.static(path.join(__dirname, 'public')));

  // ---- public ----
  app.get('/api/config', (req, res) => res.json({ mapsKey: env.GOOGLE_MAPS_KEY || '', vapidKey: alerts?.publicKey || '' }));
  app.get('/api/stops', (req, res) => res.json(db.prepare('SELECT * FROM stops ORDER BY day, id').all()));
  app.get('/api/live', (req, res) => res.json(db.prepare('SELECT ts,lat,lng,speed FROM positions ORDER BY id DESC LIMIT 1').get() || null));
  app.get('/api/trail', (req, res) => res.json(db.prepare('SELECT lat,lng FROM positions ORDER BY id').all()));
  app.get('/api/notices', (req, res) => res.json(alerts ? alerts.active() : []));
  const subHits = new Map();
  app.post('/api/push/subscribe', (req, res) => {
    const n = (subHits.get(req.ip) || 0) + 1; subHits.set(req.ip, n);
    if (n > 20) return res.status(429).json({ error: 'too many requests' });
    res.status(alerts?.subscribe(req.body) ? 201 : 400).end();
  });
  setInterval(() => subHits.clear(), 10 * 60 * 1000).unref();

  // ---- admin API (session cookie + X-CSRF) ----
  const A = auth.requireAdmin;
  app.get('/api/admin/me', A, (req, res) => res.json({ username: req.admin.username, csrf: req.admin.csrf }));

  app.post('/api/admin/stops', A, (req, res) => {
    const s = cleanStop(req.body); if (!s) return res.status(400).json({ error: 'invalid stop' });
    const r = db.prepare(`INSERT INTO stops (${FIELDS}) VALUES (${FIELDS.map(() => '?')})`).run(...FIELDS.map((f) => s[f]));
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });
  app.put('/api/admin/stops/:id', A, (req, res) => {
    const s = cleanStop(req.body); if (!s) return res.status(400).json({ error: 'invalid stop' });
    const r = db.prepare(`UPDATE stops SET ${FIELDS.map((f) => `${f}=?`)} WHERE id=?`).run(...FIELDS.map((f) => s[f]), Number(req.params.id));
    res.status(r.changes ? 204 : 404).end();
  });
  app.delete('/api/admin/stops/:id', A, (req, res) => { db.prepare('DELETE FROM stops WHERE id=?').run(Number(req.params.id)); res.status(204).end(); });

  if (alerts) {
    const F = alerts.FIELDS;
    app.get('/api/admin/alerts', A, (req, res) => res.json(db.prepare('SELECT * FROM alerts ORDER BY id DESC').all()));
    const save = (id, a) => {
      if (id) db.prepare(`UPDATE alerts SET ${F.map((f) => `${f}=?`)}, fired_at=NULL, last_inside=0 WHERE id=?`).run(...F.map((f) => a[f]), id);
      else id = Number(db.prepare(`INSERT INTO alerts (${F}) VALUES (${F.map(() => '?')})`).run(...F.map((f) => a[f])).lastInsertRowid);
      const row = db.prepare('SELECT * FROM alerts WHERE id=?').get(id);
      if (row.enabled && row.trigger === 'now') alerts.fire(row); // messages go out (and push) as soon as saved
      return id;
    };
    app.post('/api/admin/alerts', A, (req, res) => {
      const a = alerts.clean(req.body); if (!a) return res.status(400).json({ error: 'invalid alert' });
      res.status(201).json({ id: save(null, a) });
    });
    app.put('/api/admin/alerts/:id', A, (req, res) => {
      const id = Number(req.params.id);
      if (!db.prepare('SELECT 1 FROM alerts WHERE id=?').get(id)) return res.status(404).end();
      const a = alerts.clean(req.body); if (!a) return res.status(400).json({ error: 'invalid alert' });
      save(id, a); res.status(204).end();
    });
    app.post('/api/admin/alerts/:id/fire', A, (req, res) => {
      const row = db.prepare('SELECT * FROM alerts WHERE id=?').get(Number(req.params.id));
      if (!row) return res.status(404).end();
      alerts.fire(row); res.status(204).end();
    });
    app.delete('/api/admin/alerts/:id', A, (req, res) => { db.prepare('DELETE FROM alerts WHERE id=?').run(Number(req.params.id)); res.status(204).end(); });
    app.get('/api/admin/stats', A, (req, res) => res.json({ subscribers: db.prepare('SELECT count(*) n FROM push_subs').get().n }));
  }
  return app;
}

// Snapshot rows are snake_case, live position frames camelCase (ERP-INTEGRATION.md).
function toFix(p) {
  if (!p || p.lat == null || p.valid === false) return null;
  const kn = p.speedKn ?? p.speed_kn;
  return { ts: p.deviceTime || p.device_time || p.recordedAt || p.recorded_at, lat: +p.lat, lng: +p.lon, speed: kn == null ? null : +kn * 1.852 };
}

// ---- MargaTrack feed: API key -> session token for the Rath only -> wss /ws ----
function connectMargaTrack(db, onFix, env = process.env) {
  const vid = String(env.MARGATRACK_VEHICLE_ID);
  let ws, renew, retry = 1000;
  const handle = (fix) => { if (fix) { savePosition(db, fix); onFix(fix); } };
  async function start() {
    clearTimeout(renew);
    try {
      const r = await fetch(`${env.MARGATRACK_URL}/api/integration/session`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: env.MARGATRACK_API_KEY, erpClientId: env.MARGATRACK_CLIENT_ID, vehicleIds: [+vid], sessionLengthSeconds: 86400 }),
      });
      if (!r.ok) throw new Error(`session ${r.status} ${await r.text()}`);
      const { token, expiresIn } = await r.json();
      const old = ws;
      ws = new WebSocket(`${env.MARGATRACK_URL.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
      ws.on('open', () => { retry = 1000; old?.close(); });
      ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        if (m.type === 'snapshot') handle(toFix(m.positions?.find((p) => String(p.vehicle_id) === vid)));
        else if (m.type === 'position' && String(m.vehicleId) === vid) handle(toFix(m.position));
      });
      ws.on('close', function () { if (this === ws) setTimeout(start, retry = Math.min(retry * 2, 60000)); });
      ws.on('error', (e) => console.error('MargaTrack ws:', e.message));
      renew = setTimeout(start, Math.max(60, expiresIn - 600) * 1000); // fresh token before expiry, no gap
    } catch (e) {
      console.error('MargaTrack:', e.message);
      setTimeout(start, retry = Math.min(retry * 2, 60000));
    }
  }
  start();
  return { stop: () => { clearTimeout(renew); const w = ws; ws = null; w?.close(); } };
}

// ---- browser relay: /live pushes positions ({type:'pos'}) and fired alerts ({type:'alert'}) ----
function attachLive(server, db) {
  const wss = new WebSocketServer({ server, path: '/live', maxPayload: 1024 });
  wss.on('connection', (c) => {
    const last = db.prepare('SELECT ts,lat,lng,speed FROM positions ORDER BY id DESC LIMIT 1').get();
    if (last) c.send(JSON.stringify({ type: 'pos', ...last }));
  });
  return (msg) => { const d = JSON.stringify(msg); for (const c of wss.clients) if (c.readyState === 1) c.send(d); };
}

if (require.main === module) {
  const db = open();
  const port = Number(process.env.PORT) || 3100;
  let broadcast = () => {};
  const alerts = createAlerts(db, { onFire: (a) => broadcast({ type: 'alert', alert: { id: a.id, title: a.title, body: a.body, image: a.image, show_as: a.show_as } }) });
  setInterval(alerts.tick, 20000).unref();
  const server = createApp(db, { alerts }).listen(port, () => console.log(`Rath Yatra tracker on http://localhost:${port}`));
  broadcast = attachLive(server, db);
  if (!db.prepare('SELECT 1 FROM admins').get()) console.warn('no admin yet — run: node scripts/admin-user.js <username>');
  if (process.env.MARGATRACK_URL && process.env.MARGATRACK_API_KEY && process.env.MARGATRACK_VEHICLE_ID) {
    connectMargaTrack(db, (fix) => { broadcast({ type: 'pos', ...fix }); alerts.onFix(fix); });
  } else console.warn('MARGATRACK_URL / MARGATRACK_API_KEY / MARGATRACK_VEHICLE_ID not set — live tracking off');
}

module.exports = { createApp, connectMargaTrack, attachLive, toFix };
