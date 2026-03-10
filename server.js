const express = require('express');
const cors = require('cors');
const { WebUntisAnonymousAuth, WebUntisElementType } = require('webuntis');

const app = express();
app.use(cors());
app.use(express.json());

const SCHOOL = 'hh5864';
const HOST   = 'hh5864.webuntis.com';

// Cache Stundenplan für 15 Minuten
let cache = {};
const CACHE_TTL = 15 * 60 * 1000;

async function getUntis() {
  const untis = new WebUntisAnonymousAuth(SCHOOL, HOST);
  await untis.login();
  return untis;
}

// Klassen-ID der 8a finden und cachen
let klasse8aId = null;

async function findKlasse8a(untis) {
  if (klasse8aId) return klasse8aId;
  const klassen = await untis.getClasses();
  const k = klassen.find(c => c.name === '8a' || c.longName?.toLowerCase().includes('8a'));
  if (!k) throw new Error('Klasse 8a nicht gefunden');
  klasse8aId = k.id;
  return klasse8aId;
}

// Stunden formatieren (WebUntis gibt z.B. 745 → 07:45)
function formatTime(t) {
  const s = String(t).padStart(4, '0');
  return s.slice(0, 2) + ':' + s.slice(2);
}

// Datum für WebUntis (YYYYMMDD → Date)
function untisDateToDate(d) {
  const s = String(d);
  return new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`);
}

// Montag der aktuellen Woche
function getMondayOfWeek(offset = 0) {
  const now = new Date();
  const day = now.getDay() || 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - day + 1 + offset * 7);
  monday.setHours(0,0,0,0);
  return monday;
}

app.get('/health', (req, res) => res.json({ status: 'ok', school: SCHOOL }));

// Stundenplan für eine Woche (offset: 0 = diese Woche, 1 = nächste, -1 = letzte)
app.get('/timetable', async (req, res) => {
  const offset = parseInt(req.query.offset) || 0;
  const cacheKey = `tt_${offset}`;

  // Cache prüfen
  if (cache[cacheKey] && Date.now() - cache[cacheKey].ts < CACHE_TTL) {
    return res.json(cache[cacheKey].data);
  }

  try {
    const untis = await getUntis();
    const id = await findKlasse8a(untis);

    const monday = getMondayOfWeek(offset);
    const friday = new Date(monday);
    friday.setDate(friday.getDate() + 4);

    const periods = await untis.getTimetableForRange(monday, friday, id, WebUntisElementType.CLASS);
    await untis.logout();

    // Perioden gruppieren nach Wochentag (0=Mo, 1=Di, ...)
    const days = { 0: [], 1: [], 2: [], 3: [], 4: [] };
    for (const p of periods) {
      const d = untisDateToDate(p.date);
      const dayIdx = d.getDay() - 1; // Mo=0 ... Fr=4
      if (dayIdx < 0 || dayIdx > 4) continue;

      const lesson = {
        id: p.id,
        time: `${formatTime(p.startTime)}–${formatTime(p.endTime)}`,
        startTime: p.startTime,
        subject: p.su?.[0]?.longname || p.su?.[0]?.name || '–',
        subjectShort: p.su?.[0]?.name || '–',
        teacher: p.te?.map(t => t.name).join(', ') || '–',
        room: p.ro?.map(r => r.name).join(', ') || '–',
        cancelled: p.code === 'cancelled',
        substitution: p.code === 'irregular' || (p.lstext && p.lstext !== ''),
        note: p.lstext || p.substText || '',
        code: p.code || 'regular',
      };
      days[dayIdx].push(lesson);
    }

    // Nach Startzeit sortieren
    for (const key of Object.keys(days)) {
      days[key].sort((a, b) => a.startTime - b.startTime);
    }

    const result = {
      week: {
        monday: monday.toISOString().split('T')[0],
        friday: friday.toISOString().split('T')[0],
      },
      days,
      updatedAt: new Date().toISOString(),
    };

    cache[cacheKey] = { ts: Date.now(), data: result };
    res.json(result);

  } catch (err) {
    console.error('Fehler beim Laden des Stundenplans:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ UntisProMax Server läuft auf Port ${PORT}`));
