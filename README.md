# KL University — Online Entrance Examination Portal

Secure full-stack exam platform for the **KL Admissions Entrance Examinations 2027**
(KLEEE, KLGBS, KLNEET, KLBSAT, KLECET) with a Gemini-powered question bank.

## Run

```bash
npm install
npm start
```

- Student portal: http://localhost:3000/
- Admin portal:   http://localhost:3000/admin/

On first start a `.env` file is created with random secrets and an admin password
(`ADMIN_USER` / `ADMIN_PASSWORD`). Sign in, then change the password in **Settings**.
Add your Gemini API key in **Admin → Settings** (stored encrypted) or as `GEMINI_API_KEY` in `.env`.

Requires Node.js 22.13+ (uses the built-in `node:sqlite`; data lives in `data/klquiz.db`).

## Admin workflow

1. **Exam Patterns** — the five KL exams are pre-loaded with their section-wise question counts and durations. Edit or add new ones.
2. **Tests → Create Test** — pick a pattern; sections, counts and default syllabus are copied in.
3. **Setup & Syllabus** — schedule window, marking (+/−), allowed violations, shuffling, instructions. "Draft with Gemini" writes a syllabus per section.
4. **Question Bank** — "Generate with Gemini" per section (count, difficulty, focus topics). Review, edit, approve/reject. Manual add and JSON import also supported.
5. **Question Paper** — pulls the required number of approved questions per section (prefers questions not used in other papers).
6. **Pass Key & Go Live** — generate one session pass key for all students, then go live.
7. **Students** — live registrations, force-submit, allow retake, CSV export.
8. **Results & Ranking** — auto-graded merit list (score, then less time taken), section-wise scores, answer sheets, CSV export.

## Official syllabus

`server/syllabus-data.json` holds the syllabus text extracted from the official KL PDFs
(KLEEE 2023 syllabus, KLECET syllabus with unit-wise weightage, B.Sc/BBA/BCOM/BA/LLB/BCA syllabus for KLGBS).
It is loaded into the exam patterns on first start (and into existing installs once, via `syllabus_version`).
KLECET has one pattern per diploma branch (`KLECET-CIVIL`, `-CSE`, `-EEE`, `-ECE`, `-MECH`); patterns that share a
code prefix share a question bank, so Mathematics/Physics/Chemistry questions are reused across branches.

## Formulas, structures and diagrams

- Maths and physics formulas are written in LaTeX between `$…$` / `$$…$$` and typeset with KaTeX.
- Chemistry formulas and equations use mhchem: `$\ce{2H2 + O2 -> 2H2O}$`, `$\ce{SO4^2-}$`.
- Organic structures are stored as SMILES and drawn as skeletal formulas (SmilesDrawer) — as a question figure or as the four options.
- Circuits, ray diagrams and geometry figures are SVG drawings, sanitised on the server (strict allowlist) and again in the browser (DOMPurify).
- Every Gemini question is checked before it is stored: each formula must parse in KaTeX, SMILES must be valid and SVG must pass the sanitiser; failures are rejected and counted.
- The admin question editor has a live preview for all of the above.

## Scheduling, moderation and exam rules

- **Schedule:** a test is created with an exam date, start and end time. Students can register and start only inside that window; anyone still writing at the end is submitted automatically.
- **Paper moderation:** each test has an Easy / Medium / Hard mix (default 30 / 50 / 20 %). Every section gets exactly that mix; Gemini labels the difficulty of each question it writes, and "Auto-tag difficulty" labels imported or older questions.
- **Random set per student (default):** each student draws their own questions from the approved bank with the same difficulty mix, so papers differ but are equally hard. "Same paper for all" mode is also available.
- **2-strike rule:** leaving full screen, switching tabs or windows is a violation. The first shows a blocking final warning; the second closes the exam and submits it (configurable per test).

## Student flow

Register (full name, address, email, mobile, parent mobile) → session pass key → instructions →
full-screen exam with section tabs (Physics → Chemistry → …), question palette, mark-for-review,
server-side timer and autosave → submit summary → result with section-wise score and provisional rank.

## Security

- Correct answers never reach the browser; grading is server-side. Per-student question and option shuffling.
- Server-enforced deadline; late answers rejected; expired attempts auto-finalised.
- Single active session per candidate (a new login invalidates the old device).
- Tab switch / window blur / full-screen exit are logged; exceeding the limit auto-submits.
  Copy/paste/right-click/dev-tools shortcuts blocked; candidate email watermark on questions.
- bcrypt-hashed admin password and pass keys; JWT in httpOnly, SameSite=Strict cookies.
- CSRF guard (custom header + Origin check), strict Content-Security-Policy (Helmet), rate limits on login and pass-key attempts.
- All input validated server-side; all output rendered with `textContent` (no XSS); CSV export protected against formula injection.
- Gemini key and pass keys encrypted at rest (AES-256-GCM).

## Production

See **[DEPLOY.md](DEPLOY.md)**: running on a Linux or Windows server as a service, publishing through
Cloudflare Tunnel (no open ports), Cloudflare Access for the admin portal, required Cloudflare settings,
nightly full backups (`scripts/backup-full.js`) and an exam-day checklist.
In short, set in `.env`: `NODE_ENV=production`, `SECURE_COOKIES=true`, `TRUST_PROXY=1`, `HOST=127.0.0.1`.
Health check: `GET /api/health`.
