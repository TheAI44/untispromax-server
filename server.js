const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const SCHOOL = 'hh5864';
const HOST = 'hh5864.webuntis.com';

const cache = {};
const CACHE_TTL = 15 * 60 * 1000;

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', ...headers } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data), headers: res.headers }); }
        catch (e) { resolve({ status: res.statusCode, data, headers: res.headers }); }
      });
    }).on('error', reject);
  });
}

function httpsPost(url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const urlObj = new URL(url);
    const isForm = extraHeaders['Content-Type']?.includes('urlencoded');
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': isForm ? 'application/x-www-form-urlencoded' : 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        ...extraHeaders
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data), headers: res.headers }); }
        catch (e) { resolve({ status: res.statusCode, data, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function extractCookies(headers) {
  const setCookie = headers['set-cookie'] || [];
  return setCookie.map(c => c.split(';')[0]).join('; ');
}

function fmtTime(t) {
  const s = String(t).padStart(4, '0');
  return s.slice(0, 2) + ':' + s.slice(2);
}

function getMondayOfWeek(offset = 0) {
  const now = new Date();
  const day = now.getDay() || 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - day + 1 + offset * 7);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function toUntisDate(d) {
  return parseInt(d.toISOString().slice(0, 10).replace(/-/g, ''));
}

async function getSession() {
  const rpcRes = await httpsPost(
    `https://${HOST}/WebUntis/jsonrpc.do?school=${SCHOOL}`,
    { id: '1', method: 'authenticate', params: { user: 'anon', password: 'anon', client: 'untispromax' }, jsonrpc: '2.0' }
  );
  const cookie = extractCookies(rpcRes.headers);
  const sessionId = rpcRes.data?.result?.sessionId;
  if (!sessionId) throw new Error('Login fehlgeschlagen: ' + JSON.stringify(rpcRes.data));
  return { sessionId, cookie };
}

let cached8aId = null;
async function get8aId(session) {
  if (cached8aId) return cached8aId;
  const res = await httpsPost(
    `https://${HOST}/WebUntis/jsonrpc.do?school=${SCHOOL}`,
    { id: '2', method: 'getKlassen', params: {}, jsonrpc: '2.0' },
    { Cookie: session.cookie }
  );
  const klassen = res.data?.result || [];
  const k = klassen.find(c => c.name === '8a');
  if (!k) throw new Error('Klasse 8a nicht gefunden. Gefunden: ' + klassen.map(c => c.name).slice(0,10).join(', '));
  cached8aId = k.id;
  return cached8aId;
}

async function fetchTimetable(offset = 0) {
  const cacheKey = `tt_${offset}`;
  if (cache[cacheKey] && Date.now() - cache[cacheKey].ts < CACHE_TTL) return cache[cacheKey].data;

  const session = await getSession();
  const klassId = await get8aId(session);
  const monday = getMondayOfWeek(offset);
  const friday = new Date(monday);
  friday.setDate(friday.getDate() + 4);

  const res = await httpsPost(
    `https://${HOST}/WebUntis/jsonrpc.do?school=${SCHOOL}`,
    { id: '3', method: 'getTimetable', params: { id: klassId, type: 1, startDate: toUntisDate(monday), endDate: toUntisDate(friday) }, jsonrpc: '2.0' },
    { Cookie: session.cookie }
  );

  await httpsPost(
    `https://${HOST}/WebUntis/jsonrpc.do?school=${SCHOOL}`,
    { id: '4', method: 'logout', params: {}, jsonrpc: '2.0' },
    { Cookie: session.cookie }
  );

  const periods = res.data?.result || [];
  const days = { 0: [], 1: [], 2: [], 3: [], 4: [] };

  for (const p of periods) {
    const ds = String(p.date);
    const d = new Date(`${ds.slice(0,4)}-${ds.slice(4,6)}-${ds.slice(6,8)}`);
    const idx = d.getDay() - 1;
    if (idx < 0 || idx > 4) continue;
    days[idx].push({
      time: `${fmtTime(p.startTime)}–${fmtTime(p.endTime)}`,
      startTime: p.startTime,
      subject: p.su?.[0]?.longname || p.su?.[0]?.name || '–',
      subjectShort: p.su?.[0]?.name || '–',
      teacher: p.te?.map(t => t.name).join(', ') || '–',
      room: p.ro?.map(r => r.name).join(', ') || '–',
      cancelled: p.code === 'cancelled',
      substitution: p.code === 'irregular',
      note: p.lstext || p.substText || '',
    });
  }

  for (const key of Object.keys(days)) days[key].sort((a, b) => a.startTime - b.startTime);

  const result = {
    week: { monday: monday.toISOString().slice(0, 10), friday: friday.toISOString().slice(0, 10) },
    days,
    updatedAt: new Date().toISOString(),
  };

  cache[cacheKey] = { ts: Date.now(), data: result };
  return result;
}

app.get('/health', (req, res) => res.json({ status: 'ok', school: SCHOOL }));

app.get('/timetable', async (req, res) => {
  try {
    const data = await fetchTimetable(parseInt(req.query.offset) || 0);
    res.json(data);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`UntisProMax Server läuft auf Port ${PORT}`));
