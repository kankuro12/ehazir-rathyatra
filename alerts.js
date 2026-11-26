// Alert engine: fires 'time' alerts when due and 'place' alerts when the Rath enters their circle.
// A fired alert is broadcast to open pages (via onFire) and, if push=1, sent as Web Push to subscribed phones.
const webpush = require('web-push');
const { distM } = require('./db');

const FIELDS = ['title', 'body', 'image', 'show_as', 'trigger', 'at', 'lat', 'lng', 'radius_m', 'repeat', 'push', 'active_from', 'active_until', 'enabled'];
const POPUP_DEFAULT_MS = 2 * 3600 * 1000; // a fired popup with no end time stays visible to new viewers for 2 h

// Subscriptions may only point at the browsers' real push services, so the server can never be
// made to POST to an arbitrary or internal https address (SSRF).
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/];
function isPushService(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.port && !u.username && !u.password && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch { return false; }
}

const iso = (v) => (v ? new Date(v).toISOString() : null);
const npDate = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kathmandu' });

function clean(b) {
  const a = {};
  for (const f of FIELDS) a[f] = b?.[f] ?? null;
  a.title = String(a.title || '').trim().slice(0, 140);
  a.body = String(a.body || '').slice(0, 2000);
  a.image = String(a.image || '').trim();
  if (a.image && !/^https:\/\/[^\s"'<>]+$/.test(a.image)) return null; // https links only
  if (!['popup', 'card', 'both'].includes(a.show_as)) a.show_as = 'popup';
  if (!['now', 'time', 'place'].includes(a.trigger)) return null;
  if (!['once', 'daily', 'every'].includes(a.repeat)) a.repeat = 'once';
  a.push = a.push ? 1 : 0; a.enabled = a.enabled === false || a.enabled === 0 ? 0 : 1;
  for (const f of ['at', 'active_from', 'active_until']) { if (a[f] && isNaN(new Date(a[f]))) return null; a[f] = iso(a[f]); }
  if (!a.title) return null;
  if (a.trigger === 'time' && !a.at) return null;
  if (a.trigger === 'place') {
    a.lat = Number(a.lat); a.lng = Number(a.lng); a.radius_m = Math.round(Number(a.radius_m));
    if (!(Math.abs(a.lat) <= 90) || !(Math.abs(a.lng) <= 180) || !(a.radius_m >= 50 && a.radius_m <= 50000)) return null;
  } else { a.lat = a.lng = a.radius_m = null; }
  return a;
}

function vapid(db, env) {
  let k = db.prepare("SELECT v FROM settings WHERE k='vapid'").get();
  if (!k) { k = { v: JSON.stringify(webpush.generateVAPIDKeys()) }; db.prepare("INSERT INTO settings (k,v) VALUES ('vapid',?)").run(k.v); }
  const keys = JSON.parse(k.v);
  webpush.setVapidDetails(env.VAPID_SUBJECT || 'https://margatrack.com', keys.publicKey, keys.privateKey);
  return keys.publicKey;
}

function createAlerts(db, { onFire = () => {}, env = process.env, sendPush = webpush.sendNotification } = {}) {
  const publicKey = vapid(db, env);
  const inWindow = (a, now) => (!a.active_from || a.active_from <= now) && (!a.active_until || a.active_until > now);

  async function push(a) {
    const payload = JSON.stringify({ title: a.title, body: a.body.slice(0, 200), url: '/', tag: `alert-${a.id}` });
    for (const { endpoint, sub } of db.prepare('SELECT endpoint, sub FROM push_subs').all()) {
      try { await sendPush(JSON.parse(sub), payload, { TTL: 3600 }); }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE endpoint=?').run(endpoint); }
    }
  }
  function fire(a) {
    const now = new Date().toISOString();
    db.prepare('UPDATE alerts SET fired_at=? WHERE id=?').run(now, a.id);
    const fired = { ...a, fired_at: now };
    onFire(fired);
    if (a.push) push(fired).catch((e) => console.error('push:', e.message));
    return fired;
  }

  // due 'time' alerts (call every ~20 s)
  function tick() {
    const now = new Date().toISOString();
    for (const a of db.prepare("SELECT * FROM alerts WHERE enabled=1 AND trigger='time' AND fired_at IS NULL AND at<=?").all(now)) fire(a);
  }
  // 'place' alerts on each GPS fix: fire on entering (outside -> inside)
  function onFix(p) {
    const now = new Date().toISOString(), today = npDate(now);
    for (const a of db.prepare("SELECT * FROM alerts WHERE enabled=1 AND trigger='place'").all()) {
      const inside = distM(a, p) <= a.radius_m ? 1 : 0;
      if (inside !== a.last_inside) db.prepare('UPDATE alerts SET last_inside=? WHERE id=?').run(inside, a.id);
      if (!inside || a.last_inside || !inWindow(a, now)) continue;
      if (a.repeat === 'once' && a.fired_at) continue;
      if (a.repeat === 'daily' && a.fired_at && npDate(a.fired_at) === today) continue;
      fire(a);
    }
  }
  // what a viewer opening the page now should see
  function active() {
    const now = new Date().toISOString();
    return db.prepare('SELECT id,title,body,image,show_as,trigger,fired_at,active_until FROM alerts WHERE enabled=1 ORDER BY id DESC').all().filter((a) => {
      if (a.trigger === 'now') return inWindow(a, now);
      if (!a.fired_at) return false;
      const until = a.active_until || new Date(+new Date(a.fired_at) + POPUP_DEFAULT_MS).toISOString();
      return until > now;
    });
  }
  function subscribe(sub) {
    if (!sub || typeof sub.endpoint !== 'string' || !isPushService(sub.endpoint) || sub.endpoint.length > 1000
      || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string') return false;
    const s = JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh.slice(0, 200), auth: sub.keys.auth.slice(0, 100) } });
    db.prepare('INSERT INTO push_subs (endpoint, sub, created) VALUES (?,?,?) ON CONFLICT(endpoint) DO UPDATE SET sub=excluded.sub').run(sub.endpoint, s, new Date().toISOString());
    return true;
  }
  return { clean, fire, tick, onFix, active, subscribe, publicKey, FIELDS };
}

module.exports = { createAlerts, clean };
