const { DatabaseSync } = require('node:sqlite');
const seed = require('./seed');

function open(file = process.env.DB_FILE || 'rathyatra.db') {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS stops (
      id INTEGER PRIMARY KEY, day INTEGER NOT NULL, date TEXT NOT NULL,
      departure TEXT, via TEXT, lunch TEXT, arrival TEXT, events TEXT,
      halt TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, major INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY, ts TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, speed REAL);
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    -- one table for messages and alerts: trigger 'now' (show in window), 'time' (fire at), 'place' (fire on entering circle)
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT DEFAULT '', image TEXT DEFAULT '',
      show_as TEXT NOT NULL DEFAULT 'popup', trigger TEXT NOT NULL DEFAULT 'now', at TEXT,
      lat REAL, lng REAL, radius_m INTEGER, repeat TEXT NOT NULL DEFAULT 'once', push INTEGER DEFAULT 0,
      active_from TEXT, active_until TEXT, enabled INTEGER DEFAULT 1,
      fired_at TEXT, last_inside INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, sub TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    PRAGMA foreign_keys = ON;`);
  if (db.prepare('SELECT count(*) n FROM stops').get().n === 0) {
    const ins = db.prepare(`INSERT INTO stops (day,date,departure,via,lunch,arrival,events,halt,lat,lng,major)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const s of seed) ins.run(s.day, s.date, s.departure, s.via, s.lunch, s.arrival, s.events, s.halt, s.lat, s.lng, s.major ? 1 : 0);
  }
  return db;
}

const R = 6371000, rad = (d) => (d * Math.PI) / 180;
function distM(a, b) {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Keeps the trail small: only store a fix if the Rath moved >30 m since the last stored one.
function savePosition(db, p) {
  const last = db.prepare('SELECT lat,lng FROM positions ORDER BY id DESC LIMIT 1').get();
  if (last && distM(last, p) < 30) {
    db.prepare('UPDATE positions SET ts=?, speed=? WHERE id=(SELECT max(id) FROM positions)').run(p.ts, p.speed);
    return false;
  }
  db.prepare('INSERT INTO positions (ts,lat,lng,speed) VALUES (?,?,?,?)').run(p.ts, p.lat, p.lng, p.speed);
  return true;
}

module.exports = { open, savePosition, distM };
