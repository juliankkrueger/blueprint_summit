# CLAUDE.md — Blueprint Survey Architect

## Project Vision
A web-based tool for physiotherapy practices to transform competency models into interactive
Mentor/Mentee surveys with high-end Blueprint Summit branding.
Clients use it at home after the event — the tool must be simple, beautiful, and self-explanatory.

## Technical Stack
- Frontend: Single HTML file with Tailwind CSS (served by Express).
- Charts: Chart.js for Radar/Spider diagrams.
- PDF Export: Puppeteer to print result page to PDF (download only, no print dialog).
- Logic: Node.js (Express) for backend processing.
- AI: Claude API (Anthropic) — claude-sonnet-4-6 model.
- API Key: stored in .env as ANTHROPIC_API_KEY (never hardcode).

## Language
- UI is 100% German. All buttons, labels, errors, placeholders in German.

## Core Workflow (one run = one competency level)
1. User enters global password (blueprint2024).
2. User uploads ONE level's competency document (PDF or PNG/screenshot).
3. Branded loading/progress bar shows while Claude API processes.
4. Claude extracts: level name, category names, all bullet points per category.
5. Tool displays extracted structure for user confirmation.
6. Mentor fills out 0–10 sliders for each bullet point → "Übergabe an Mentee".
7. Screen transitions to Mentee view (same questions, fresh inputs).
8. Mentee fills out → "Auswertung abschließen".
9. Results page: Radar chart (Mentor vs. Mentee overlaid) + summary.
10. PDF download button → file downloads automatically.
11. After download: "Nächstes Level bewerten" button → back to upload screen.

## AI System Prompt (anti-abuse, single-purpose)
The Claude API call MUST use a strict system prompt that:
- Restricts the model to ONLY extract competency model structures from uploaded documents.
- Refuses any other request (questions, chat, generation, etc.).
- Returns ONLY valid JSON with the extracted structure.
- Example refusal trigger: if no competency table/structure is detected, return error JSON.
System prompt template:
"""
Du bist ein spezialisiertes Extraktionswerkzeug. Deine einzige Aufgabe ist es,
Kompetenzmodell-Strukturen aus hochgeladenen Dokumenten zu extrahieren und als
strukturiertes JSON zurückzugeben. Du beantwortest keine anderen Fragen und führst
keine anderen Aufgaben aus. Antworte ausschließlich mit validem JSON.
"""

## Validation Rules
- No 30% structure check — client models vary freely.
- If Claude cannot detect a clear competency structure → return error, ask for clearer upload.
- Categories and levels can have any name and any number of bullet points.

## Radar Chart Logic
- Axes = categories extracted from the uploaded level (variable per client).
- Score per axis = arithmetic average of all bullet-point ratings (0–10) in that category.
- Mentor polygon: Teal #00E9B9 (filled semi-transparent + solid border).
- Mentee polygon: Cyan #5CE1E6 (filled semi-transparent + solid border), overlaid.

## AI Progress Bar (Branded)
- Show during API call (typically 5–15 seconds).
- Animated progress bar in Blueprint Summit colors (#00E9B9 → #5CE1E6 gradient).
- With loading text cycling through: "Dokument wird analysiert...",
  "Kategorien werden erkannt...", "Fragen werden generiert..."
- Must feel premium and on-brand, not like a generic spinner.

## Design System (Blueprint Summit — Option A "The Blueprint")
- Style: Dark, premium, tech — matching brand guide exactly.
- Background: #072330 (Deep Navy) with subtle topographic SVG contour line texture.
- Cards: Glassmorphism — rgba(255,255,255,0.05) bg, 1px border rgba(0,233,185,0.3),
  backdrop-filter: blur(12px).
- Buttons: Gradient #00E9B9 → #5CE1E6, dark text (#072330), rounded-full.
- Typography:
  - Headings: "Unbounded" (Google Fonts), font-weight 700, tight letter-spacing.
  - Body/Labels: "Noto Sans Display" (Google Fonts), font-weight 400/500.
- Color tokens:
  - --navy:   #072330  (background)
  - --teal:   #00E9B9  (primary accent, Mentor color)
  - --cyan:   #5CE1E6  (secondary accent, Mentee color)
  - --black:  #000000
  - --text:   #FFFFFF
  - --muted:  rgba(255,255,255,0.6)
- Logo: use /branding_assets/brand_guide/Logos/blueprint_summit_logo_weiss.png
- Topographic lines: subtle SVG or CSS pattern overlay, opacity ~0.08.

## Session Flow (single device, sequential)
- Mentor fills out all sliders → "Übergabe an Mentee" button.
- Screen clears and shows Mentee view (same questions).
- Mentee fills out → "Auswertung abschließen".
- Results page shown to both.
- No database. No real-time sync. Session state held in server memory / JS.

## Post-Result Flow
- Primary action: "PDF herunterladen" → triggers Puppeteer PDF, auto-download.
- After download button clicked: "Nächstes Level bewerten" button appears.
- "Nächstes Level bewerten" → resets to upload screen (no full page reload needed).

## Project Structure (target)
blueprint-summit/
├── server.js          # Express server, API routes
├── public/
│   └── index.html     # Single-page frontend (all views/steps)
├── branding_assets/   # Logos, brand guide images
├── .env               # API key + config (never commit)
├── .gitignore
├── package.json
└── CLAUDE.md

## Milestones
1. Fundament: Express server, Login-Seite im Blueprint-Design.
2. Upload & KI: Datei-Upload, Claude API Extraktion, branded Ladebalken.
3. Fragebogen: Dynamische 0–10 Slider für Mentor → Mentee.
4. Ergebnis: Radar-Chart (Chart.js), Mentor vs. Mentee übereinandergelegt.
5. PDF-Export: Puppeteer-PDF, Auto-Download, "Nächstes Level"-Button.
6. Polish: Mobile/iPad-Optimierung, Fehler-Handling, letzte Design-Details.
