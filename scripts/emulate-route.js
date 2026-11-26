// Local testing only: drives an emulated H02 GPS device along real roads between the Yatra halts
// into a local MargaTrack ingest port. Usage: node scripts/emulate-route.js [startDay]
// env: RATH_IMEI, INGEST_HOST=localhost, INGEST_PORT=9000, STEP_S=2, STEP_M=1500
require('dotenv').config();
const net = require('node:net');
const seed = require('../seed');
const { distM } = require('../db');

const IMEI = process.env.RATH_IMEI || '860000000002026';
const STEP_S = +process.env.STEP_S || 2;
const start = Math.max(1, +process.argv[2] || 1);
const stops = seed.filter((s) => s.day >= start);

const nmea = (c, lat) => { const a = Math.abs(c), d = Math.floor(a); return `${(d * 100 + (a - d) * 60).toFixed(4).padStart(lat ? 7 : 8, '0')},${c < 0 ? (lat ? 'S' : 'W') : (lat ? 'N' : 'E')}`; };
function frame(lat, lon, kn, course) {
  const t = new Date(), p = (n) => String(n).padStart(2, '0');
  return `*HQ,${IMEI},V1,${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())},A,${nmea(lat, true)},${nmea(lon, false)},${kn.toFixed(2)},${String(Math.round(course)).padStart(3, '0')},${p(t.getUTCDate())}${p(t.getUTCMonth() + 1)}${String(t.getUTCFullYear()).slice(2)},FBF7BBFF,222,10,11032,27783#`;
}
const bearing = (a, b) => (Math.atan2(b.lng - a.lng, b.lat - a.lat) * 180 / Math.PI + 360) % 360;

// Real road geometry per leg from the public OSRM demo router (same as tracaar_clone/emulate).
async function road(a, b) {
  const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`);
  const d = await r.json();
  if (d.code !== 'Ok') throw new Error(`OSRM ${d.code}`);
  return d.routes[0].geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
}
// one fix every STEP_M metres along the road
function resample(line, stepM) {
  const out = [line[0]];
  let carry = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], d = distM(a, b);
    let t = stepM - carry;
    while (t <= d) { out.push({ lat: a.lat + (b.lat - a.lat) * t / d, lng: a.lng + (b.lng - a.lng) * t / d }); t += stepM; }
    carry = (carry + d) % stepM;
  }
  return out;
}
const STEP_M = +process.env.STEP_M || 1500;

(async () => {
  const sock = net.connect(+process.env.INGEST_PORT || 9000, process.env.INGEST_HOST || 'localhost');
  sock.on('error', (e) => { console.error('ingest:', e.message); process.exit(1); });
  await new Promise((r) => sock.once('connect', r));
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    const pts = resample(await road(a, b), STEP_M);
    console.log(`→ Day ${b.day} ${b.halt}: ${pts.length} fixes along road`);
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k], n = pts[k + 1] || b;
      sock.write(frame(p.lat, p.lng, 40 / 1.852, bearing(p, n)));
      await new Promise((r) => setTimeout(r, STEP_S * 1000));
    }
  }
  const last = stops.at(-1);
  sock.write(frame(last.lat, last.lng, 0, 0));
  console.log('arrived'); sock.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
