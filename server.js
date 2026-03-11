const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const HOST = 'hh5864.webuntis.com';
const SCHOOL = 'hh5864';

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

app.get('/health', (req, res) => res.json({ status: 'ok', school: SCHOOL }));

app.get('/debug', async (req, res) => {
  try {
    const results = {};

    const r1 = await httpsGet(`https://${HOST}/WebUntis/api/rest/view/v1/classes?schoolyear=2025`);
    results.classes_2025 = { status: r1.status, data: JSON.stringify(r1.data || r1.raw).slice(0, 500) };

    const r2 = await httpsGet(`https://${HOST}/WebUntis/api/rest/view/v1/classes?schoolyear=2026`);
    results.classes_2026 = { status: r2.status, data: JSON.stringify(r2.data || r2.raw).slice(0, 500) };

    const r3 = await httpsGet(`https://${HOST}/WebUntis/api/public/timetable/weekly/pageconfig?type=1&date=2026-03-11&formatId=1`);
    results.pageconfig = { status: r3.status, data: JSON.stringify(r3.data || r3.raw).slice(0, 500) };

    const r4 = await httpsGet(`https://${HOST}/WebUntis/api/rest/view/v1/app/data`);
    results.appdata = { status: r4.status, data: JSON.stringify(r4.data || r4.raw).slice(0, 300) };

    const r5 = await httpsGet(`https://${HOST}/WebUntis/api/public/timetable/weekly/data?elementType=1&elementId=1&date=2026-03-11&formatId=1`);
    results.timetable_id1 = { status: r5.status, data: JSON.stringify(r5.data || r5.raw).slice(0, 300) };

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/timetable', (req, res) => {
  res.json({ error: 'Debug-Modus aktiv – bitte zuerst /debug aufrufen' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`UntisProMax Debug-Server läuft auf Port ${PORT}`));

