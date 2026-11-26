// Local testing only: on a local MargaTrack (default http://localhost:3000) registers a "Rath (test)" vehicle
// in the demo tenant and an integration key, then writes rathyatra/.env.
// Usage: node scripts/local-setup.js <path-to-tracaar_clone/.env> [googleMapsKey]
const fs = require('node:fs');
const path = require('node:path');
const mt = require('dotenv').parse(fs.readFileSync(process.argv[2]));
const API = process.env.MT_URL || 'http://localhost:3000';
const IMEI = process.env.RATH_IMEI || '860000000002026';

(async () => {
  if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(API)) throw new Error('local MargaTrack only');
  const j = async (r) => { if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); return r.status === 204 ? null : r.json(); };
  const { token } = await j(await fetch(`${API}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: mt.SIM_EMAIL, password: mt.SIM_PASSWORD }) }));
  const h = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  let v = (await j(await fetch(`${API}/api/vehicles`, { headers: h }))).find((x) => x.imei === IMEI);
  if (!v) v = await j(await fetch(`${API}/api/vehicles`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'Rath (test)', imei: IMEI, plate: 'RATH 2026' }) }));
  const clientId = `rath-local-${Date.now()}`;
  const { key } = await j(await fetch(`${API}/api/integration/keys`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'Rath Yatra local', clientId }) }));
  const env = [
    'PORT=3100', `MARGATRACK_URL=${API}`, `MARGATRACK_API_KEY=${key}`, `MARGATRACK_CLIENT_ID=${clientId}`,
    `MARGATRACK_VEHICLE_ID=${v.id}`, `GOOGLE_MAPS_KEY=${process.argv[3] || ''}`, `ADMIN_TOKEN=${require('node:crypto').randomBytes(18).toString('hex')}`,
    'DB_FILE=rathyatra-local.db', `RATH_IMEI=${IMEI}`, '',
  ].join('\n');
  fs.writeFileSync(path.join(__dirname, '..', '.env'), env);
  console.log(`vehicle ${v.id} (${IMEI}) + integration key ready; wrote .env`);
})().catch((e) => { console.error(e.message); process.exit(1); });
