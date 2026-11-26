const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { WebSocket, WebSocketServer } = require('ws');
const { open } = require('../db');
const { hashPassword } = require('../auth');
const { createAlerts } = require('../alerts');
const { createApp, connectMargaTrack, attachLive } = require('../server');

const listen = (srv) => new Promise((r) => srv.listen(0, () => r(srv)));
const until = async (fn) => { for (let i = 0; i < 100; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timeout'); };
const env = { COOKIE_SECURE: '0' };

async function setup() {
  const db = open(':memory:');
  db.prepare('INSERT INTO admins (username, pass) VALUES (?,?)').run('ops', hashPassword('correct horse battery'));
  const fired = [], pushed = [];
  const alerts = createAlerts(db, { env, onFire: (a) => fired.push(a), sendPush: async (sub, payload) => { pushed.push(JSON.parse(payload)); } });
  const server = await listen(http.createServer(createApp(db, { env, alerts })));
  return { db, alerts, fired, pushed, server, base: `http://localhost:${server.address().port}` };
}
async function login(base, password = 'correct horse battery') {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ops', password }) });
  if (!r.ok) return { status: r.status };
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const me = await fetch(base + '/api/admin/me', { headers: { cookie } }).then((x) => x.json());
  return { status: r.status, cookie, csrf: me.csrf, setCookie: r.headers.get('set-cookie') };
}

test('admin auth: login, httpOnly cookie, csrf, logout, protected page', async () => {
  const { server, base } = await setup();
  assert.strictEqual((await login(base, 'wrong password!!')).status, 401);
  const s = await login(base);
  assert.match(s.setCookie, /HttpOnly/); assert.match(s.setCookie, /SameSite=Strict/);

  const stops = await fetch(base + '/api/stops').then((r) => r.json());
  assert.strictEqual(stops.length, 41);
  const put = (h) => fetch(base + `/api/admin/stops/${stops[0].id}`, { method: 'PUT', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify({ ...stops[0], lat: 27.6 }) });
  assert.strictEqual((await put({})).status, 401);
  assert.strictEqual((await put({ cookie: s.cookie })).status, 403); // no csrf
  assert.strictEqual((await put({ cookie: s.cookie, 'x-csrf': 'x'.repeat(48) })).status, 403);
  assert.strictEqual((await put({ cookie: s.cookie, 'x-csrf': s.csrf })).status, 204);

  assert.strictEqual((await fetch(base + '/admin', { redirect: 'manual' })).status, 302);
  assert.strictEqual((await fetch(base + '/admin', { headers: { cookie: s.cookie } })).status, 200);
  assert.strictEqual((await fetch(base + '/admin.html')).status, 404); // private page never served statically

  await fetch(base + '/api/logout', { method: 'POST', headers: { cookie: s.cookie } });
  assert.strictEqual((await fetch(base + '/api/admin/me', { headers: { cookie: s.cookie } })).status, 401);
  server.close();
});

test('login is rate limited', async () => {
  const { server, base } = await setup();
  let last;
  for (let i = 0; i < 11; i++) last = await login(base, 'nope nope nope');
  assert.strictEqual(last.status, 429);
  server.close();
});

test('alerts: validation, message sends on save, place fires on entry per repeat rule, time fires when due, push', async () => {
  const { db, alerts, fired, pushed, server, base } = await setup();
  const s = await login(base);
  const post = (b) => fetch(base + '/api/admin/alerts', { method: 'POST', headers: { 'content-type': 'application/json', cookie: s.cookie, 'x-csrf': s.csrf }, body: JSON.stringify(b) });

  assert.strictEqual((await post({ title: 'x', trigger: 'place', lat: 27, lng: 83, radius_m: 10 })).status, 400); // radius too small
  assert.strictEqual((await post({ title: 'x', trigger: 'now', image: 'javascript:alert(1)' })).status, 400);

  const keys = { p256dh: 'p', auth: 'a' };
  assert.strictEqual(alerts.subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys }), true);
  for (const bad of ['http://fcm.googleapis.com/x', 'https://push.example/1', 'https://10.0.0.5/admin', 'https://fcm.googleapis.com.evil.com/x',
    'https://evil.com/fcm.googleapis.com', 'https://fcm.googleapis.com:8443/x', 'https://u:p@fcm.googleapis.com/x'])
    assert.strictEqual(alerts.subscribe({ endpoint: bad, keys }), false, bad);
  assert.strictEqual((await post({ title: 'Welcome', trigger: 'now', show_as: 'card', push: true })).status, 201);
  assert.strictEqual(fired.at(-1).title, 'Welcome');
  await until(() => pushed.length === 1);

  // place: 2 km around Butwal, once per day
  await post({ title: 'Rath reaching Butwal', trigger: 'place', lat: 27.7006, lng: 83.4483, radius_m: 2000, repeat: 'daily', push: true });
  const n = fired.length;
  alerts.onFix({ lat: 27.5, lng: 83.45 });            // outside
  assert.strictEqual(fired.length, n);
  alerts.onFix({ lat: 27.701, lng: 83.449 });          // enters
  assert.strictEqual(fired.at(-1).title, 'Rath reaching Butwal');
  alerts.onFix({ lat: 27.702, lng: 83.449 });          // still inside: no repeat
  alerts.onFix({ lat: 27.5, lng: 83.45 }); alerts.onFix({ lat: 27.701, lng: 83.449 }); // leaves + re-enters same day
  assert.strictEqual(fired.length, n + 1);
  await until(() => pushed.length === 2);

  // time: due in the past -> fires on tick, once
  await post({ title: 'Bhajan 6 PM', trigger: 'time', at: new Date(Date.now() - 1000).toISOString() });
  alerts.tick(); alerts.tick();
  assert.strictEqual(fired.filter((a) => a.title === 'Bhajan 6 PM').length, 1);

  const notices = await fetch(base + '/api/notices').then((r) => r.json());
  assert.deepStrictEqual(notices.map((a) => a.title).sort(), ['Bhajan 6 PM', 'Rath reaching Butwal', 'Welcome']);
  assert.ok(!('lat' in notices[0]), 'public notices do not leak alert areas');
  server.close(); db.close();
});

test('MargaTrack ws -> sqlite -> /live relay', async () => {
  const { db, server, base } = await setup();
  const broadcast = attachLive(server, db);
  let sessionBody;
  const mt = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      sessionBody = JSON.parse(b);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ token: 'tok', expiresIn: 86400 }));
    });
  });
  new WebSocketServer({ server: mt, path: '/ws' }).on('connection', (ws, req) => {
    assert.match(req.url, /token=tok/);
    ws.send(JSON.stringify({ type: 'snapshot', positions: [{ vehicle_id: 1, lat: 1, lon: 1 }, { vehicle_id: 7, lat: 27.5, lon: 83.45, speed_kn: 10, device_time: '2026-12-06T05:00:00Z' }] }));
    setTimeout(() => ws.send(JSON.stringify({ type: 'position', vehicleId: 7, position: { lat: 27.6, lon: 83.5, speedKn: 20, deviceTime: '2026-12-06T05:10:00Z' } })), 100);
  });
  await listen(mt);
  const got = [];
  const viewer = new WebSocket(base.replace('http', 'ws') + '/live');
  viewer.on('message', (d) => got.push(JSON.parse(d)));
  await new Promise((r) => viewer.on('open', r));
  const feed = connectMargaTrack(db, (fix) => broadcast({ type: 'pos', ...fix }), { MARGATRACK_URL: `http://localhost:${mt.address().port}`, MARGATRACK_API_KEY: 'fk_x', MARGATRACK_CLIENT_ID: 'rath', MARGATRACK_VEHICLE_ID: '7' });
  await until(() => got.length >= 2);
  assert.deepStrictEqual(sessionBody.vehicleIds, [7]);
  assert.deepStrictEqual([got[0].type, got[0].lat, got[1].lat, Math.round(got[1].speed)], ['pos', 27.5, 27.6, 37]);
  assert.strictEqual((await fetch(base + '/api/trail').then((r) => r.json())).length, 2);
  feed.stop(); viewer.close(); mt.close(); server.close();
});
