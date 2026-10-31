// Google Gemini integration: question generation and syllabus drafting.
const crypto = require('crypto');
const { get } = require('./db');
const { decrypt, fail } = require('./security');
const { repairEscapes, checkMath, isSmiles, cleanDiagram } = require('./content');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const BATCH = 15;

function getConfig() {
  const row = get("SELECT value FROM settings WHERE key = 'gemini_key'");
  const modelRow = get("SELECT value FROM settings WHERE key = 'gemini_model'");
  const key = (row && decrypt(row.value)) || process.env.GEMINI_API_KEY || '';
  const model = (modelRow && modelRow.value) || process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  return { key, model };
}

async function callGemini(prompt, { schema, temperature = 0.7, timeoutMs = 180000 } = {}) {
  const { key, model } = getConfig();
  if (!key) fail(400, 'Gemini API key is not configured. Add it in Admin → Settings.');
  if (!/^[\w.-]+$/.test(model)) fail(400, 'Invalid Gemini model name');

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature },
  };
  if (schema) {
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseSchema = schema;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${API_BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    fail(502, e.name === 'AbortError' ? 'Gemini request timed out' : `Could not reach Gemini: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    fail(502, `Gemini error: ${msg}`);
  }
  const text = (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) fail(502, `Gemini returned no content (${json.candidates?.[0]?.finishReason || 'unknown reason'})`);
  return text;
}

const QUESTION_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      question: { type: 'STRING' },
      options: { type: 'ARRAY', items: { type: 'STRING' } },
      correct_index: { type: 'INTEGER' },
      explanation: { type: 'STRING' },
      topic: { type: 'STRING' },
      difficulty: { type: 'STRING', enum: ['easy', 'medium', 'hard'] },
      options_format: { type: 'STRING', enum: ['text', 'smiles'] },
      diagram_kind: { type: 'STRING', enum: ['none', 'smiles', 'svg'] },
      diagram_code: { type: 'STRING' },
      diagram_caption: { type: 'STRING' },
    },
    required: ['question', 'options', 'correct_index', 'explanation', 'topic', 'difficulty', 'options_format', 'diagram_kind'],
  },
};

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

// Returns a cleaned question, or {rejected: reason} so callers can report why items were dropped.
function cleanQuestion(q) {
  if (!q || typeof q.question !== 'string' || !Array.isArray(q.options)) return { rejected: 'malformed' };
  const smilesOpts = q.options_format === 'smiles';
  const options = q.options.map((o) => repairEscapes(String(o)).replace(/^\s*\(?[A-Da-d][).:]\s+/, '').trim());
  if (options.length !== 4 || options.some((o) => !o)) return { rejected: 'needs 4 options' };
  if (new Set(options.map(norm)).size !== 4) return { rejected: 'duplicate options' };
  const ci = Number(q.correct_index);
  if (!Number.isInteger(ci) || ci < 0 || ci > 3) return { rejected: 'bad correct_index' };
  const text = repairEscapes(q.question).trim();
  if (text.length < 10 || text.length > 4000) return { rejected: 'question length' };
  const explanation = repairEscapes(String(q.explanation || '')).trim().slice(0, 2000);

  const mathErr = checkMath(text) || checkMath(explanation) || (smilesOpts ? null : options.map(checkMath).find(Boolean));
  if (mathErr) return { rejected: mathErr };
  if (smilesOpts && !options.every(isSmiles)) return { rejected: 'invalid SMILES option' };
  let diagram;
  try {
    diagram = cleanDiagram({ kind: q.diagram_kind, code: q.diagram_code, caption: q.diagram_caption });
  } catch (e) {
    return { rejected: e.message };
  }
  // LLMs rarely put the answer in position D; reshuffle so the key is evenly spread.
  const order = [0, 1, 2, 3];
  for (let i = 3; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return {
    text,
    options: order.map((i) => options[i]),
    correct_index: order.indexOf(ci),
    explanation,
    topic: String(q.topic || '').trim().slice(0, 120),
    difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium',
    options_format: smilesOpts ? 'smiles' : 'text',
    diagram,
  };
}

/**
 * Generates `count` validated MCQs in batches. `existing` holds question texts already
 * in the bank so Gemini is steered away from duplicates and exact repeats are dropped.
 */
async function generateQuestions({ examName, subject, syllabus, count, difficulty, focus, existing = [] }) {
  const seen = new Set(existing.map(norm));
  const out = [];
  const rejected = [];
  let lastError = null;
  let attempts = 0;
  while (out.length < count && attempts < Math.ceil(count / BATCH) + 3) {
    attempts++;
    const n = Math.min(BATCH, count - out.length);
    const avoid = [...existing.slice(-25), ...out.slice(-15).map((q) => q.text)]
      .map((t) => `- ${t.slice(0, 140)}`).join('\n');

    const prompt = `You are a senior question-paper setter for "${examName}", an entrance examination conducted by KL University (India).
Write ${n} ORIGINAL multiple-choice questions for the section "${subject}".
Difficulty: ${difficulty}.
${focus ? `Focus especially on: ${focus}\n` : ''}Syllabus to cover (spread questions across these topics):
"""
${syllabus || subject}
"""
If the syllabus lists unit weightage (questions per unit), distribute questions in the same proportion.

Content rules:
- Exactly 4 options per question and exactly ONE correct option. correct_index is 0-based (0 = first option).
- Do NOT prefix options with letters like "A)" or "(a)". Avoid "all of the above" / "none of the above".
- Solve every question yourself before answering; numerical answers must be exactly right and every distractor must be wrong.
- Give a concise explanation (1-3 sentences, showing the key formula/step) and the syllabus unit as "topic".
- Label each question's difficulty honestly: "easy" = direct recall or one-step formula use; "medium" = two or three steps or combining two ideas; "hard" = multi-concept, lengthy or tricky (JEE-Main level).
- If the section needs a passage, data table or statement set (e.g. Reading Comprehension, Data Interpretation), include it in the question text using line breaks.
- No Markdown, except: wrap a phrase in *single asterisks* to italicise it (e.g. the part of a sentence to be improved, or a book title); use "____" for a blank. Never use "$" for money (write ₹).
- Data tables (data interpretation, caselets): typeset them as a LaTeX array on their own line, e.g. $$\\begin{array}{|l|r|r|}\\hline \\text{Year} & \\text{Sales} & \\text{Profit} \\\\ \\hline 2021 & 120 & 18 \\\\ 2022 & 150 & 24 \\\\ \\hline\\end{array}$$
- General knowledge / current affairs: use only stable, verifiable facts. Avoid anything that changes over time (office-holders, latest records, recent events after 2024) unless the question states the year it refers to.

Formatting of formulas (rendered with KaTeX):
- Write ALL mathematical expressions, variables with sub/superscripts, fractions, roots, vectors, matrices, integrals and limits in LaTeX between $…$ (inline) or $$…$$ (a long equation on its own line).
  Examples: $\\frac{1}{2}mv^2$, $\\sqrt{2gh}$, $\\int_0^{\\pi/2}\\sin^2 x\\,dx$, $\\lim_{x\\to 0}\\frac{\\sin x}{x}$, $\\vec F = q\\,\\vec v\\times\\vec B$, $\\begin{bmatrix}1&2\\\\3&4\\end{bmatrix}$, $U = -\\frac{k}{2r^2}$.
- Units: $9.8\\ \\text{m s}^{-2}$, $6.0\\ \\mu\\text{F}$, or plain text outside the formula ("40 rad/s").
- Chemistry: write every formula, ion and equation with mhchem inside $…$: $\\ce{H2SO4}$, $\\ce{SO4^2-}$, $\\ce{Fe^3+}$, $\\ce{2KMnO4 + 16HCl -> 2KCl + 2MnCl2 + 5Cl2 + 8H2O}$, $\\ce{N2 + 3H2 <=> 2NH3}$, $\\ce{CH3COOH}$.
- In the JSON output every backslash must be escaped (write \\\\frac, not \\frac).
- Options must use the same formatting rules (an option may be just "$\\frac{3}{4}$").

Structures and diagrams (use only where the question genuinely needs a picture):
- Organic structure questions (identify the major product, IUPAC name of a drawn structure, isomers): set options_format "smiles" and make each option a valid SMILES string (e.g. "CC(=O)O"); or draw the given reactant with diagram_kind "smiles" and diagram_code = its SMILES. Keep these to at most 1 in 5 chemistry questions.
- Physics/mathematics figures (circuits, ray diagrams, free-body diagrams, inclined planes, geometry figures, graphs): set diagram_kind "svg" and diagram_code to a compact SVG: viewBox about "0 0 360 220", black strokes (stroke-width 1.5-2), fill "none" or "white", labels as <text> with font-size 13, using only svg, g, line, polyline, polygon, path, rect, circle, ellipse, text, defs, marker elements. No style, script, image or href. The question text must still state every value needed. At most 1 in 5 questions should have a diagram.
- Otherwise diagram_kind "none", diagram_code "", options_format "text".
${avoid ? `Do not repeat or paraphrase these existing questions:\n${avoid}\n` : ''}`;

    let raw;
    try {
      raw = await callGemini(prompt, { schema: QUESTION_SCHEMA, temperature: 0.7 });
    } catch (e) {
      // One blocked (e.g. RECITATION) or timed-out batch shouldn't lose the whole request; try another batch.
      // Configuration errors (missing key, bad model) are not retried.
      if (e.status !== 502) throw e;
      lastError = e;
      rejected.push(e.message);
      continue;
    }
    let arr;
    try { arr = JSON.parse(raw); } catch { rejected.push('invalid JSON from Gemini'); continue; }
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const q = cleanQuestion(item);
      if (q.rejected) { rejected.push(q.rejected); continue; }
      if (seen.has(norm(q.text))) continue;
      seen.add(norm(q.text));
      out.push(q);
      if (out.length >= count) break;
    }
  }
  if (!out.length && lastError) throw lastError;
  if (rejected.length) console.warn(`Gemini: rejected ${rejected.length} item(s) for ${subject}:`, rejected.slice(0, 5).join(' | '));
  return { questions: out, rejected };
}

// Labels existing questions easy/medium/hard (for imports, manual questions and older bank entries).
async function classifyDifficulty(questions, examName) {
  const out = [];
  for (let i = 0; i < questions.length; i += 20) {
    const chunk = questions.slice(i, i + 20);
    const list = chunk.map((q) => `ID ${q.id} [${q.subject}]: ${q.text.slice(0, 600)}\nOptions: ${q.options.join(' | ').slice(0, 300)}`).join('\n\n');
    const prompt = `You moderate the question paper for "${examName}", a KL University entrance examination for students finishing Class 12 / diploma.
Rate the difficulty of each question for that audience:
- "easy" = direct recall or one-step formula use
- "medium" = two or three steps, or combining two ideas
- "hard" = multi-concept, lengthy or tricky (JEE-Main level)
Questions:
${list}`;
    const raw = await callGemini(prompt, {
      temperature: 0,
      schema: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: { type: 'INTEGER' }, difficulty: { type: 'STRING', enum: ['easy', 'medium', 'hard'] } }, required: ['id', 'difficulty'] } },
    });
    let arr = [];
    try { arr = JSON.parse(raw); } catch { /* skip this chunk */ }
    const ids = new Set(chunk.map((q) => q.id));
    out.push(...arr.filter((r) => ids.has(r.id) && ['easy', 'medium', 'hard'].includes(r.difficulty)));
  }
  return out;
}

async function suggestSyllabus({ examName, departments, subject, questionCount }) {
  const prompt = `Draft a concise syllabus for the "${subject}" section of "${examName}", a KL University (India) entrance examination for admission to ${departments || 'undergraduate programmes'}. The section has ${questionCount} multiple-choice questions.
Base it on the standard Indian curriculum level appropriate for these candidates.
Return plain text only: a comma-separated list of 10-25 topics grouped as "Unit name: topic, topic; Unit name: topic, topic". No Markdown, no numbering, under 900 characters.`;
  const text = await callGemini(prompt, { temperature: 0.4, timeoutMs: 60000 });
  return text.replace(/[*#`]/g, '').trim().slice(0, 4000);
}

async function testConnection() {
  const t = await callGemini('Reply with the single word OK.', { temperature: 0, timeoutMs: 30000 });
  return t.trim().slice(0, 50);
}

module.exports = { generateQuestions, classifyDifficulty, suggestSyllabus, testConnection, getConfig };
