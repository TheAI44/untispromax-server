const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const HOST = 'hh5864.webuntis.com';
const SCHOOL = 'hh5864';

const cache = {};
const CACHE_TTL = 15 * 60 * 1000;

// ── Aktuelles Schuljahr berechnen ──────────────────
// Schuljahr beginnt im August/September
// 2025/2026 → Klasse 8a
// 2026/2027 → Klasse 9a
// 2027/2028 → Klasse 10a usw.
const START_YEAR = 2025;   // Schuljahr in dem die Klasse 8a war
const START_CLASS = 8;     // Klassenstufe damals

function getCurrentClassName() {
  const now = new Date();
  const month = now.getMonth() + 1; // 1-12
  const year = now.getFullYear();

  // Neues Schuljahr beginnt im August (Monat 8)
  const currentSchoolYear = month >= 8 ? year : year - 1;
  const yearDiff = currentSchoolYear - START_YEAR;
  const classNumber = START_CLASS + yearDiff;

  return `${classNumber}a`;
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'de-DE,de;q=0.9',
        'Referer': `https://${HOST}/WebUntis/`,
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data), headers: res.headers }); }
        catch (e) { resolve({ status: res.statusCode, raw: data.slice(0, 500), headers: res.headers }); }
      });
    }).on('error', reject);
  });
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

// Klassen-ID cachen (wird zurückgesetzt wenn neue Klasse erkannt)
let cachedClassId = null;
let cachedClassName = null;

async function getClassId() {
  const currentClass = getCurrentClassName();

  // Cache leeren wenn sich die Klasse geändert hat (neues Schuljahr)
  if (cachedClassName !== currentClass) {
    cachedClassId = null;
    cachedClassName = currentClass;
    console.log(`Neues Schuljahr erkannt – Klasse ist jetzt: ${currentClass}`);
  }

  if (cachedClassId) return { id: cachedClassId, name: currentClass };

  const today = new Date().toISOString().slice(0, 10);
  const res = await httpsGet(`https://${HOST}/WebUntis/api/public/timetable/weekly/pageconfig?type=1&date=${today}&formatId=1`);
  const elements = res.data?.data?.elements || [];

  const k = elements.find(e => e.name === currentClass);
  if (!k) {
    console.log(`Klasse "${currentClass}" nicht gefunden. Verfügbar:`, elements.map(e => e.name).join(', '));
    throw new Error(`Klasse "${currentClass}" nicht gefunden. Verfügbare Klassen: ${elements.map(e => e.name).slice(0, 20).join(', ')}`);
  }

  cachedClassId = k.id;
  console.log(`Klasse ${currentClass} gefunden, ID: ${cachedClassId}`);
  return { id: cachedClassId, name: currentClass };
}

async function fetchTimetable(offset = 0) {
  const currentClass = getCurrentClassName();
  const cacheKey = `tt_${currentClass}_${offset}`;
  if (cache[cacheKey] && Date.now() - cache[cacheKey].ts < CACHE_TTL) return cache[cacheKey].data;

  const monday = getMondayOfWeek(offset);
  const friday = new Date(monday);
  friday.setDate(friday.getDate() + 4);
  const dateStr = monday.toISOString().slice(0, 10);

  const { id: klassId, name: className } = await getClassId();
  const url = `https://${HOST}/WebUntis/api/public/timetable/weekly/data?elementType=1&elementId=${klassId}&date=${dateStr}&formatId=1`;
  const res = await httpsGet(url);

  if (res.status !== 200) throw new Error(`API Fehler ${res.status}: ${JSON.stringify(res.data || res.raw).slice(0, 200)}`);

  const payload = res.data?.data?.result?.data;
  if (!payload) throw new Error('Keine Daten: ' + JSON.stringify(res.data).slice(0, 300));

  const elements = payload.elements || [];
  const elementPeriods = payload.elementPeriods || {};
  const getEl = (type, id) => elements.find(e => e.type === type && e.id === id);

  const days = { 0: [], 1: [], 2: [], 3: [], 4: [] };

  for (const periods of Object.values(elementPeriods)) {
    for (const p of periods) {
      const ds = String(p.date);
      const d = new Date(`${ds.slice(0,4)}-${ds.slice(4,6)}-${ds.slice(6,8)}`);
      const idx = d.getDay() - 1;
      if (idx < 0 || idx > 4) continue;

      const subjects = (p.elements || []).filter(e => e.type === 3).map(e => getEl(3, e.id)?.longName || getEl(3, e.id)?.name || '–');
      const teachers = (p.elements || []).filter(e => e.type === 2).map(e => {
        const t = getEl(2, e.id);
        return t ? (t.forename ? t.forename[0] + '. ' : '') + t.name : '–';
      });
      const rooms = (p.elements || []).filter(e => e.type === 4).map(e => getEl(4, e.id)?.name || '–');

      // Duplikate vermeiden
      const existing = days[idx].find(x => x.startTime === p.startTime && x.subject === (subjects[0] || '–'));
      if (existing) continue;

      days[idx].push({
        time: `${fmtTime(p.startTime)}–${fmtTime(p.endTime)}`,
        startTime: p.startTime,
        subject: subjects.join(', ') || '–',
        teacher: teachers.join(', ') || '–',
        room: rooms.join(', ') || '–',
        cancelled: p.is?.cancelled || false,
        substitution: p.is?.irregular || false,
        note: p.substText || p.lessonText || '',
      });
    }
  }

  for (const key of Object.keys(days)) days[key].sort((a, b) => a.startTime - b.startTime);

  const result = {
    className,
    week: { monday: monday.toISOString().slice(0, 10), friday: friday.toISOString().slice(0, 10) },
    days,
    updatedAt: new Date().toISOString(),
  };

  cache[cacheKey] = { ts: Date.now(), data: result };
  return result;
}

// ── ROUTES ───────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', school: SCHOOL, currentClass: getCurrentClassName() });
});

app.get('/classes', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const r = await httpsGet(`https://${HOST}/WebUntis/api/public/timetable/weekly/pageconfig?type=1&date=${today}&formatId=1`);
    const elements = r.data?.data?.elements || [];
    res.json({
      currentClass: getCurrentClassName(),
      allClasses: elements.map(e => ({ id: e.id, name: e.name, longName: e.longName }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
app.listen(PORT, () => {
  console.log(`UntisProMax Server läuft auf Port ${PORT}`);
  console.log(`Aktuelle Klasse: ${getCurrentClassName()}`);
});
