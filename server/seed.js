// First-run data: admin account and the KL Admissions Entrance Examinations 2027 patterns.
const bcrypt = require('bcryptjs');
const { all, get, run, tx } = require('./db');
// Official syllabus text extracted from the KL Admissions syllabus PDFs (KLEEE, KLECET, KLGBS).
const SYL = require('./syllabus-data.json');


const TEMPLATES = [
  {
    code: 'KLEEE', name: 'KL Engineering Entrance Examination', departments: 'B.Tech & BCA', duration_min: 180, mode: 'ONLINE/OFFLINE',
    sections: [
      ['Physics', 25, SYL.KLEEE.Physics],
      ['Chemistry', 25, SYL.KLEEE.Chemistry],
      ['Mathematics', 25, SYL.KLEEE.Mathematics],
    ],
  },
  {
    code: 'KLGBS', name: 'KL General & Business Studies Entrance', departments: 'BA, BBA, LLB, B.COM & BSc A & G', duration_min: 120, mode: 'ONLINE/OFFLINE',
    sections: [
      ['Management Aptitude & Communication Skills', 30, 'Business awareness, basic management concepts, decision making, situational judgement, workplace communication, email & letter etiquette, comprehension of business scenarios, interpersonal skills'],
      ['English', 20, SYL.KLGBS.English],
      ['General Awareness', 20, SYL.KLGBS['General Awareness']],
      ['Logical & Analytical Ability', 20, SYL.KLGBS['Logical & Analytical Ability']],
    ],
  },
  {
    code: 'KLNEET', name: 'KL Life Sciences & Pharmacy Entrance', departments: 'B.Pharmacy, BSc FT, BSc Agri & Pharma.D', duration_min: 180, mode: 'ONLINE/OFFLINE',
    sections: [
      ['Physics', 20, SYL.KLEEE.Physics],
      ['Chemistry', 20, SYL.KLEEE.Chemistry],
      ['Botany', 25, 'Diversity in living world, plant kingdom, morphology & anatomy of flowering plants, cell structure & cell cycle, transport in plants, mineral nutrition, photosynthesis, respiration in plants, plant growth & development, reproduction in flowering plants, principles of inheritance, molecular basis of inheritance, ecology & environment'],
      ['Zoology', 25, 'Animal kingdom, structural organisation in animals, biomolecules, digestion, breathing & exchange of gases, body fluids & circulation, excretion, locomotion, neural control, chemical coordination, human reproduction, reproductive health, evolution, human health & disease, biotechnology'],
    ],
  },
  {
    code: 'KLBSAT', name: 'KL Business School Aptitude Test', departments: 'MBA, M.Tech, MCA & MSc', duration_min: 120, mode: 'ONLINE',
    sections: [
      ['Verbal Ability', 50, 'Vocabulary, synonyms & antonyms, sentence completion, error spotting, sentence improvement, para-jumbles, analogies, idioms & phrases, critical reasoning'],
      ['Reading Comprehension', 30, 'Passage-based questions on business, economics, science, technology and social issues: main idea, inference, tone, vocabulary in context, author\'s purpose'],
      ['Quantitative Aptitude', 30, 'Number system, percentages, profit & loss, simple & compound interest, ratio & proportion, averages, time & work, time speed & distance, mixtures, algebra, geometry & mensuration, permutations, probability'],
      ['Data Interpretation', 30, 'Tables, bar graphs, line graphs, pie charts, caselets, data sufficiency, percentage & ratio based analysis'],
    ],
  },
  // KLECET core differs by diploma branch: one pattern per branch. Codes "KLECET-xxx" share the
  // "KLECET" question bank (see bankCode), so Mathematics/Physics/Chemistry are reused across branches.
  ...[['CIVIL', 'Civil Engineering'], ['CSE', 'Computer Science & Engineering'], ['EEE', 'Electrical & Electronics Engineering'],
    ['ECE', 'Electronics & Communication Engineering'], ['MECH', 'Mechanical Engineering']].map(([code, branch]) => ({
    code: `KLECET-${code}`, name: `KL Engineering Common Entrance Test (Lateral Entry) — ${branch}`, departments: `B.Tech LE (${branch})`, duration_min: 120, mode: 'ONLINE',
    sections: [
      [`Core – ${branch}`, 40, SYL.KLECET_CORE[branch]],
      ['Mathematics', 20, SYL.KLECET.Mathematics],
      ['Physics', 20, SYL.KLECET.Physics],
      ['Chemistry', 20, SYL.KLECET.Chemistry],
    ],
  })),
];

// The question bank is shared by every pattern with the same code prefix (KLECET-CSE → KLECET).
const bankCode = (code) => String(code).split('-')[0];
const SYLLABUS_VERSION = '2';

const DEFAULT_INSTRUCTIONS = `1. The examination must be taken in full-screen mode. Do not exit full screen, switch tabs, minimise the window or open any other application.
2. Opening another tab, switching windows or leaving full screen is a violation. The first time you get a warning; the second time your exam is CLOSED and submitted automatically.
3. Questions are grouped section-wise. Use the section tabs at the top to move between sections.
4. Click an option to select it, then "Save & Next". Use "Mark for Review" to revisit a question later; marked questions that are answered are evaluated.
5. The question palette shows the status of every question: Not Visited, Not Answered, Answered, Marked for Review, Answered & Marked.
6. Your answers are saved to the server automatically. If your connection drops, log in again with the same email and mobile to resume.
7. The timer is controlled by the server. The exam is submitted automatically when time runs out.
8. Copy, paste, right-click and screenshots are disabled. Any malpractice leads to disqualification.`;

function seed() {
  if (!get('SELECT id FROM admins LIMIT 1')) {
    const user = process.env.ADMIN_USER || 'admin';
    const pass = process.env.ADMIN_PASSWORD;
    if (!pass || pass.length < 10) {
      throw new Error('Set ADMIN_PASSWORD (min 10 characters) in .env before the first start.');
    }
    run('INSERT INTO admins (username, password_hash) VALUES (?, ?)', user, bcrypt.hashSync(pass, 12));
    console.log(`Created admin account "${user}".`);
  }
  const version = get("SELECT value FROM settings WHERE key = 'syllabus_version'");
  if (!get('SELECT id FROM exam_templates LIMIT 1')) {
    tx(() => TEMPLATES.forEach(insertTemplate));
    console.log('Seeded KL Admissions 2027 exam templates.');
  } else if (!version || version.value !== SYLLABUS_VERSION) {
    tx(upgradeSyllabus);
    console.log('Updated exam patterns with the official KL syllabus.');
  }
  run("INSERT INTO settings (key, value) VALUES ('syllabus_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", SYLLABUS_VERSION);
}

function insertTemplate(t) {
  const r = run('INSERT INTO exam_templates (code, name, departments, duration_min, mode) VALUES (?, ?, ?, ?, ?)',
    t.code, t.name, t.departments, t.duration_min, t.mode);
  t.sections.forEach(([name, count, syl], i) => {
    run('INSERT INTO template_sections (template_id, name, question_count, syllabus, sort) VALUES (?, ?, ?, ?, ?)',
      r.lastInsertRowid, name, count, syl, i);
  });
}

// Existing installs: load the official syllabus into patterns and into draft tests nobody has started,
// and replace the single generic KLECET pattern with the per-branch ones. Admin edits to
// question counts, names and other patterns are left alone.
function upgradeSyllabus() {
  for (const t of TEMPLATES) {
    const cur = get('SELECT id FROM exam_templates WHERE code = ?', t.code);
    if (!cur) { insertTemplate(t); continue; }
    t.sections.forEach(([name, , syl]) => run('UPDATE template_sections SET syllabus = ? WHERE template_id = ? AND name = ?', syl, cur.id, name));
  }
  run("DELETE FROM exam_templates WHERE code = 'KLECET'");
  for (const test of all(`SELECT t.id, e.code FROM tests t JOIN exam_templates e ON e.id = t.template_id
      WHERE t.status = 'draft' AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.test_id = t.id)`)) {
    const t = TEMPLATES.find((x) => x.code === test.code);
    if (!t) continue;
    t.sections.forEach(([name, , syl]) => run('UPDATE test_sections SET syllabus = ? WHERE test_id = ? AND name = ?', syl, test.id, name));
  }
}

module.exports = { seed, bankCode, DEFAULT_INSTRUCTIONS };
