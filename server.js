require('dotenv').config();
const express  = require('express');
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const Anthropic  = require('@anthropic-ai/sdk');
const rateLimit  = require('express-rate-limit');

// ── Puppeteer Browser-Pool ──────────────────────────────
// Ein Browser bleibt offen, nur Pages werden geöffnet/geschlossen.
// Drastisch ressourcenschonender als pro Anfrage einen neuen Browser zu starten.
let _puppeteer = null;
let _browser   = null;
let _pdfQueue  = 0;           // aktive PDF-Renders
const PDF_CONCURRENCY = 3;   // max. gleichzeitige PDFs

async function getPuppeteer() {
  if (!_puppeteer) {
    const mod = await import('puppeteer');
    _puppeteer = mod.default;
  }
  return _puppeteer;
}

async function getBrowser() {
  if (!_browser || !_browser.connected) {
    const puppeteer = await getPuppeteer();
    _browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    console.log('Puppeteer Browser gestartet ✓');
    _browser.on('disconnected', () => { _browser = null; });
  }
  return _browser;
}

// Chart.js beim Start vorladen → kein CDN-Aufruf beim PDF-Rendering
let chartJsSource = null;
(async () => {
  try {
    const res = await fetch('https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js');
    if (res.ok) {
      chartJsSource = await res.text();
      console.log('Chart.js vorgeladen ✓');
    }
  } catch (err) {
    console.warn('Chart.js Vorladung fehlgeschlagen, nutze CDN als Fallback:', err.message);
  }
})();

const app = express();
const PORT = process.env.PORT || 3000;

// ── Session-Persistenz ──────────────────────────────────
// Sessions werden in einer JSON-Datei gespeichert → überleben Server-Restarts.
const SESSION_FILE = path.join(__dirname, '.sessions.json');
const SESSION_TTL  = 24 * 60 * 60 * 1000; // 24 Stunden

function loadSessions() {
  try {
    const raw = fs.readFileSync(SESSION_FILE, 'utf8');
    const data = JSON.parse(raw);
    const now  = Date.now();
    // Abgelaufene Sessions beim Laden entfernen
    const valid = {};
    for (const [token, ts] of Object.entries(data)) {
      if (now - ts < SESSION_TTL) valid[token] = ts;
    }
    return valid;
  } catch {
    return {};
  }
}

function saveSessions(sessions) {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions), 'utf8');
  } catch (err) {
    console.warn('Sessions konnten nicht gespeichert werden:', err.message);
  }
}

let activeSessions = loadSessions();
console.log(`Sessions geladen: ${Object.keys(activeSessions).length} aktive Sessions`);

function requireAuth(req, res, next) {
  const token = req.headers['x-session-token'];
  if (!token || !activeSessions[token]) {
    return res.status(401).json({ error: true, message: 'Nicht authentifiziert' });
  }
  next();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Nur PDF, PNG oder JPG erlaubt.'));
    }
  }
});

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/branding_assets', express.static(path.join(__dirname, 'branding_assets')));

// ── Rate Limiting ───────────────────────────────────────
// WICHTIG: Limits sind für Event-Betrieb mit shared IP (Corporate WLAN) ausgelegt.
// Bei shared IP teilen sich alle Nutzer hinter einem Router eine IP → Limits müssen
// entsprechend hoch sein, sonst werden legitime Nutzer fälschlicherweise blockiert.

// Login: 500 Versuche pro IP in 15 Minuten
// (40 Nutzer × mehrere Versuche, alle hinter einer IP)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Zu viele Versuche. Bitte kurz warten.' }
});

// Extraktion: 200 Analysen pro IP pro Stunde
// (40 Nutzer × je mehrere Uploads)
const extractLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: true, message: 'Stundenlimit erreicht. Bitte kurz warten.' }
});

// PDF: 150 PDFs pro IP pro Stunde
const pdfLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: true, message: 'Zu viele PDF-Anfragen. Bitte kurz warten.' }
});

// ── API-Concurrency-Limit ───────────────────────────────
// Max. 5 gleichzeitige Claude-API-Calls → verhindert Anthropic Rate Limits.
// Weitere Anfragen warten in einer Queue (werden nicht abgelehnt).
const API_CONCURRENCY = 5;
let activeApiCalls = 0;
const apiWaitQueue = [];

function acquireApiSlot() {
  return new Promise(resolve => {
    if (activeApiCalls < API_CONCURRENCY) {
      activeApiCalls++;
      resolve();
    } else {
      apiWaitQueue.push(resolve);
    }
  });
}

function releaseApiSlot() {
  if (apiWaitQueue.length > 0) {
    const next = apiWaitQueue.shift();
    next();
  } else {
    activeApiCalls--;
  }
}

// ── Claude API mit Retry bei 429 ───────────────────────
async function claudeWithRetry(params, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await client.messages.create(params);
    } catch (err) {
      const is429 = err.status === 429;
      const isOverload = err.status === 529;
      if ((is429 || isOverload) && attempt < maxRetries) {
        // Exponential Backoff: 2s, 4s, 8s
        const waitMs = Math.pow(2, attempt + 1) * 1000;
        console.warn(`Claude API ${err.status} — warte ${waitMs}ms (Versuch ${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
}

// ── Login ──────────────────────────────────────────────
app.post('/api/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (password === process.env.APP_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    activeSessions[token] = Date.now();
    saveSessions(activeSessions);
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, message: 'Falsches Passwort.' });
  }
});

// ── KI-Extraktion ──────────────────────────────────────
app.post('/api/extract', requireAuth, extractLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: true, message: 'Keine Datei hochgeladen.' });
  }

  const base64Data = req.file.buffer.toString('base64');
  const mimeType   = req.file.mimetype;

  const systemPrompt = `Du bist ein spezialisiertes Extraktionswerkzeug. Deine einzige Aufgabe ist es, Kompetenzmodell-Strukturen aus hochgeladenen Dokumenten zu extrahieren und als strukturiertes JSON zurückzugeben. Du beantwortest keine anderen Fragen und führst keine anderen Aufgaben aus. Antworte ausschließlich mit validem JSON.

Das JSON muss folgendes Format haben:
{
  "level": "Name des Kompetenzlevels",
  "categories": [
    {
      "name": "Kategoriename",
      "bullets": ["Kompetenz 1", "Kompetenz 2"]
    }
  ]
}

Falls kein klares Kompetenzmodell erkannt werden kann, antworte mit:
{"error": true, "message": "Kein Kompetenzmodell erkannt. Bitte ein klareres Dokument hochladen."}`;

  let messageContent;
  if (mimeType === 'application/pdf') {
    messageContent = [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64Data }
      },
      { type: 'text', text: 'Extrahiere die Kompetenzmodell-Struktur aus diesem Dokument und gib sie als JSON zurück.' }
    ];
  } else {
    messageContent = [
      {
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: base64Data }
      },
      { type: 'text', text: 'Extrahiere die Kompetenzmodell-Struktur aus diesem Bild und gib sie als JSON zurück.' }
    ];
  }

  // Slot in der Concurrency-Queue holen (max. 5 gleichzeitige Calls)
  await acquireApiSlot();

  try {
    const API_TIMEOUT_MS = 90000; // 90 Sekunden (erhöht wegen Queue-Wartezeit)
    const apiCall = claudeWithRetry({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: messageContent }]
    });
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), API_TIMEOUT_MS)
    );

    const response = await Promise.race([apiCall, timeout]);

    const rawText = response.content[0].text.trim();
    const parsed = extractJSON(rawText);
    if (!parsed) {
      return res.json({ error: true, message: 'Keine gültige Struktur erkannt. Bitte ein klareres Dokument hochladen.' });
    }
    res.json(parsed);
  } catch (err) {
    if (err.message === 'TIMEOUT') {
      console.error('Claude API Timeout — Datei zu groß oder zu komplex.');
      return res.status(504).json({ error: true, message: 'Zeitüberschreitung — die Datei ist zu groß oder komplex. Bitte eine kleinere Datei hochladen (max. 8 MB, idealerweise 1 Seite).' });
    }
    if (err.status === 429 || err.status === 529) {
      console.error('Claude API überlastet nach allen Retries:', err.message);
      return res.status(429).json({ error: true, message: 'KI momentan sehr ausgelastet — bitte 30 Sekunden warten und erneut versuchen.' });
    }
    console.error('Claude API Fehler [', err.status || err.name, ']:', err.message);
    res.status(500).json({ error: true, message: 'API-Fehler. Bitte erneut versuchen.' });
  } finally {
    releaseApiSlot();
  }
});

// Robuster JSON-Extraktor (ignoriert Text vor/nach dem JSON-Block)
function extractJSON(text) {
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape)            { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"')        { inString = !inString; continue; }
    if (inString)          continue;
    if (ch === '{')        depth++;
    if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch {} } }
  }
  return null;
}

// ── PDF-Export ─────────────────────────────────────────
app.post('/api/pdf', requireAuth, pdfLimiter, async (req, res) => {
  const { extractedData, mentorRatings, menteeRatings } = req.body;
  if (!extractedData || !mentorRatings || !menteeRatings) {
    return res.status(400).json({ error: true, message: 'Fehlende Daten.' });
  }

  // Concurrency-Check: max. 3 PDFs gleichzeitig rendern
  if (_pdfQueue >= PDF_CONCURRENCY) {
    return res.status(503).json({ error: true, message: 'PDF-Erstellung kurz ausgelastet — bitte 10 Sekunden warten und erneut versuchen.' });
  }
  _pdfQueue++;

  const avg = (ratings, catIdx, bullets) => {
    const vals = (bullets || []).map((_, bIdx) => ratings[catIdx]?.[bIdx] ?? 5);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };

  const mentorAvgs = extractedData.categories.map((cat, i) => avg(mentorRatings, i, cat.bullets));
  const menteeAvgs = extractedData.categories.map((cat, i) => avg(menteeRatings, i, cat.bullets));

  const logoPath = path.join(__dirname, 'branding_assets', 'brand_guide', 'Logos', 'blueprint_summit_logo_weiss.png');
  const logoB64  = fs.readFileSync(logoPath).toString('base64');
  const html     = generatePdfHtml(extractedData, mentorAvgs, menteeAvgs, mentorRatings, menteeRatings, logoB64);

  let page;
  try {
    // Shared Browser-Pool: nur neue Page öffnen, kein neuer Browser
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setContent(html, { waitUntil: chartJsSource ? 'domcontentloaded' : 'networkidle0' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', bottom: '14mm', left: '14mm', right: '14mm' }
    });
    await page.close();

    const safe     = (extractedData.level || 'Level').replace(/[^a-zA-Z0-9äöüÄÖÜß_-]/g, '_');
    const dateStr  = new Date().toISOString().slice(0, 10);
    const filename = `Blueprint_Summit_${safe}_${dateStr}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (err) {
    if (page) await page.close().catch(() => {});
    console.error('PDF-Fehler:', err);
    res.status(500).json({ error: true, message: 'PDF konnte nicht erstellt werden. Bitte erneut versuchen.' });
  } finally {
    _pdfQueue--;
  }
});

function generatePdfHtml(data, mentorAvgs, menteeAvgs, mentorRatings, menteeRatings, logoB64) {
  const date   = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const labels = JSON.stringify(data.categories.map(c => c.name));
  const mData  = JSON.stringify(mentorAvgs.map(v => +v.toFixed(2)));
  const meData = JSON.stringify(menteeAvgs.map(v => +v.toFixed(2)));

  // Kategorie-Übersichtstabelle (Durchschnitte)
  const summaryRows = data.categories.map((cat, i) => {
    const diff      = menteeAvgs[i] - mentorAvgs[i];
    const diffStr   = (diff >= 0 ? '+' : '') + diff.toFixed(1);
    const diffColor = diff >= 0 ? '#00E9B9' : '#ff9a9a';
    return `<tr>
      <td>${cat.name}</td>
      <td style="text-align:center;color:#00E9B9;font-weight:700;">${mentorAvgs[i].toFixed(1)}</td>
      <td style="text-align:center;color:#5CE1E6;font-weight:700;">${menteeAvgs[i].toFixed(1)}</td>
      <td style="text-align:center;color:${diffColor};font-weight:700;">${diffStr}</td>
    </tr>`;
  }).join('');

  // Detailtabellen pro Kategorie (alle Einzelfragen)
  const detailSections = data.categories.map((cat, i) => {
    const bulletRows = cat.bullets.map((bullet, j) => {
      const mVal  = mentorRatings[i]?.[j] ?? 5;
      const meVal = menteeRatings[i]?.[j] ?? 5;
      const diff  = meVal - mVal;
      const diffStr   = (diff >= 0 ? '+' : '') + diff.toFixed(0);
      const diffColor = diff >= 0 ? '#00E9B9' : '#ff9a9a';
      return `<tr>
        <td style="padding-left:14px;color:rgba(255,255,255,.8);font-size:10px;">${bullet}</td>
        <td style="text-align:center;color:#00E9B9;font-weight:600;">${mVal}</td>
        <td style="text-align:center;color:#5CE1E6;font-weight:600;">${meVal}</td>
        <td style="text-align:center;color:${diffColor};font-weight:600;">${diffStr}</td>
      </tr>`;
    }).join('');

    const catDiff      = menteeAvgs[i] - mentorAvgs[i];
    const catDiffStr   = (catDiff >= 0 ? '+' : '') + catDiff.toFixed(1);
    const catDiffColor = catDiff >= 0 ? '#00E9B9' : '#ff9a9a';

    return `
    <div class="cat-header">
      <span class="cat-name">${cat.name}</span>
      <span class="cat-avgs">
        <span style="color:#00E9B9;">Mentor Ø ${mentorAvgs[i].toFixed(1)}</span>
        &nbsp;·&nbsp;
        <span style="color:#5CE1E6;">Mentee Ø ${menteeAvgs[i].toFixed(1)}</span>
        &nbsp;·&nbsp;
        <span style="color:${catDiffColor};">Δ ${catDiffStr}</span>
      </span>
    </div>
    <table style="margin-bottom:18px;">
      <thead><tr>
        <th>Kompetenz</th>
        <th style="text-align:center;width:70px;">Mentor</th>
        <th style="text-align:center;width:70px;">Mentee</th>
        <th style="text-align:center;width:70px;">Differenz</th>
      </tr></thead>
      <tbody>${bulletRows}</tbody>
    </table>`;
  }).join('');

  const chartScriptTag = chartJsSource
    ? `<script>${chartJsSource}</script>`
    : `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>`;

  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
${chartScriptTag}
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#072330;color:#fff;font-family:'Helvetica Neue',Arial,sans-serif;padding:36px;font-size:12px;line-height:1.5;}
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px;padding-bottom:18px;border-bottom:1px solid rgba(0,233,185,0.3);}
.header img{height:44px;}
.level-badge{display:inline-block;background:linear-gradient(135deg,#00E9B9,#5CE1E6);color:#072330;font-weight:700;font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:3px 12px;border-radius:999px;margin-bottom:5px;}
.main-title{font-size:20px;font-weight:700;color:#00E9B9;margin-bottom:6px;}
.subtitle{color:rgba(255,255,255,.45);font-size:11px;}
.chart-wrap{width:340px;height:340px;margin:0 auto 16px;}
.legend{display:flex;justify-content:center;gap:28px;margin-bottom:24px;}
.legend-item{display:flex;align-items:center;gap:7px;font-size:11px;color:rgba(255,255,255,.8);}
.dot{width:11px;height:11px;border-radius:50%;}
table{width:100%;border-collapse:collapse;}
th{background:rgba(0,233,185,.08);color:rgba(255,255,255,.5);font-size:9px;letter-spacing:.08em;text-transform:uppercase;padding:8px 12px;text-align:left;border-bottom:1px solid rgba(0,233,185,.2);}
td{padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.06);color:rgba(255,255,255,.85);}
tr:last-child td{border-bottom:none;}
.section-title{font-size:13px;font-weight:700;color:#00E9B9;margin:28px 0 12px;padding-bottom:6px;border-bottom:1px solid rgba(0,233,185,.25);letter-spacing:.04em;text-transform:uppercase;}
.cat-header{display:flex;align-items:center;justify-content:space-between;background:rgba(0,233,185,.06);border-left:3px solid #00E9B9;padding:8px 12px;margin-top:18px;margin-bottom:0;}
.cat-name{font-size:11px;font-weight:700;color:#fff;text-transform:uppercase;letter-spacing:.06em;}
.cat-avgs{font-size:10px;color:rgba(255,255,255,.65);}
.footer{margin-top:32px;padding-top:14px;border-top:1px solid rgba(255,255,255,.08);text-align:center;font-size:9px;color:rgba(255,255,255,.2);letter-spacing:.08em;text-transform:uppercase;}
</style></head><body>

<div class="header">
  <img src="data:image/png;base64,${logoB64}" alt="Blueprint Summit"/>
  <div style="text-align:right;">
    <div class="level-badge">${data.level}</div>
    <div class="subtitle">${date}</div>
  </div>
</div>

<div class="main-title" style="text-align:center;">Kompetenz-Auswertung</div>
<div class="subtitle" style="text-align:center;margin-bottom:20px;">Mentor &amp; Mentee im Vergleich</div>

<div class="chart-wrap"><canvas id="c"></canvas></div>

<div class="legend">
  <div class="legend-item"><div class="dot" style="background:#00E9B9;"></div><span>Mentor</span></div>
  <div class="legend-item"><div class="dot" style="background:#5CE1E6;"></div><span>Mentee</span></div>
</div>

<div class="section-title">Übersicht nach Kategorie</div>
<table>
  <thead><tr><th>Kategorie</th><th style="text-align:center;">Mentor Ø</th><th style="text-align:center;">Mentee Ø</th><th style="text-align:center;">Differenz</th></tr></thead>
  <tbody>${summaryRows}</tbody>
</table>

<div class="section-title" style="margin-top:32px;">Detailbewertung — Alle Kompetenzen</div>
${detailSections}

<div class="footer">Blueprint Summit · 14.03.2026 · Wolfsburg</div>

<script>
new Chart(document.getElementById('c'),{type:'radar',data:{labels:${labels},datasets:[
  {label:'Mentor',data:${mData},backgroundColor:'rgba(0,233,185,.18)',borderColor:'#00E9B9',borderWidth:2.5,pointBackgroundColor:'#00E9B9',pointRadius:4},
  {label:'Mentee',data:${meData},backgroundColor:'rgba(92,225,230,.18)',borderColor:'#5CE1E6',borderWidth:2.5,pointBackgroundColor:'#5CE1E6',pointRadius:4}
]},options:{animation:false,responsive:false,scales:{r:{min:0,max:10,ticks:{stepSize:2,color:'rgba(255,255,255,.3)',backdropColor:'transparent',font:{size:9}},grid:{color:'rgba(255,255,255,.1)'},angleLines:{color:'rgba(255,255,255,.12)'},pointLabels:{color:'rgba(255,255,255,.88)',font:{size:10}}}},plugins:{legend:{display:false}}}});
</script>
</body></html>`;
}

app.listen(PORT, () => {
  console.log(`Blueprint Summit läuft auf http://localhost:${PORT}`);
});
