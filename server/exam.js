// Exam engine: attempt creation, grading, ranking. Correct answers never leave the server
// except through admin endpoints.
const crypto = require('crypto');
const { all, get, run, tx } = require('./db');
const { fail } = require('./security');

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function testWindowState(test, now = Date.now()) {
  if (test.status !== 'live') return 'not_live';
  if (test.start_at && now < Date.parse(test.start_at)) return 'not_started';
  if (test.end_at && now > Date.parse(test.end_at)) return 'ended';
  return 'open';
}

function sectionsWithPaper(testId) {
  return all(`SELECT s.*, (SELECT COUNT(*) FROM test_questions tq WHERE tq.section_id = s.id) AS paper_count
              FROM test_sections s WHERE s.test_id = ? ORDER BY s.sort, s.id`, testId);
}

// ---------- paper moderation ----------
const LEVELS = ['easy', 'medium', 'hard'];

// How many easy/medium/hard questions a section of n questions needs under the test's mix.
function mixCounts(n, test) {
  const easy = Math.round((n * test.mix_easy) / 100);
  const hard = Math.round((n * test.mix_hard) / 100);
  return { easy, medium: Math.max(0, n - easy - hard), hard };
}

// Approved bank questions available to a section, per difficulty.
function bankStatus(test, section) {
  const have = { easy: 0, medium: 0, hard: 0 };
  all(`SELECT difficulty, COUNT(*) c FROM questions WHERE exam_code = ? AND subject = ? AND status = 'approved' GROUP BY difficulty`,
    test.exam_code, section.name).forEach((r) => { if (r.difficulty in have) have[r.difficulty] = r.c; });
  const want = mixCounts(section.question_count, test);
  const total = have.easy + have.medium + have.hard;
  return { want, have, total, enough: total >= section.question_count, exact_mix: LEVELS.every((l) => have[l] >= want[l]) };
}

/**
 * Picks a section's questions to match the difficulty mix. If a level runs short, the gap is filled
 * from the other levels (medium first) so the section is still complete. With `preferUnused`,
 * questions that appear in fewer saved papers are taken first (fresh questions for each sitting).
 */
function pickQuestions(test, section, { preferUnused = false } = {}) {
  const want = mixCounts(section.question_count, test);
  const pools = {};
  for (const l of LEVELS) {
    const rows = shuffle(all(`SELECT q.id, (SELECT COUNT(*) FROM test_questions x WHERE x.question_id = q.id AND x.test_id <> ?) AS used
        FROM questions q WHERE q.exam_code = ? AND q.subject = ? AND q.status = 'approved' AND q.difficulty = ?`,
    test.id, test.exam_code, section.name, l));
    if (preferUnused) rows.sort((a, b) => a.used - b.used);
    pools[l] = rows.map((r) => r.id);
  }
  const picked = [];
  let short = 0;
  for (const l of LEVELS) {
    const take = pools[l].splice(0, want[l]);
    picked.push(...take);
    short += want[l] - take.length;
  }
  for (const l of ['medium', 'easy', 'hard']) {
    while (short > 0 && pools[l].length) { picked.push(pools[l].shift()); short--; }
  }
  return { qids: shuffle(picked), short };
}

function createAttempt(student, test, meta) {
  const sections = sectionsWithPaper(test.id);
  if (!sections.length) fail(409, 'The question paper for this exam is not ready yet. Please contact the invigilator.');
  let order;
  if (test.selection_mode === 'random') {
    // Every candidate gets their own random set with the same difficulty mix.
    order = sections.map((s) => {
      const { qids, short } = pickQuestions(test, s);
      if (short) fail(409, 'The question bank for this exam is not ready yet. Please contact the invigilator.');
      return { section_id: s.id, name: s.name, qids };
    });
  } else {
    if (sections.some((s) => s.paper_count < s.question_count)) {
      fail(409, 'The question paper for this exam is not ready yet. Please contact the invigilator.');
    }
    order = sections.map((s) => {
      const qids = all('SELECT question_id FROM test_questions WHERE section_id = ? ORDER BY sort', s.id).map((r) => r.question_id);
      return { section_id: s.id, name: s.name, qids: test.shuffle_questions ? shuffle(qids) : qids };
    });
  }
  const optionMaps = {};
  if (test.shuffle_options) {
    for (const s of order) for (const q of s.qids) optionMaps[q] = shuffle([0, 1, 2, 3]);
  }
  const now = Date.now();
  let deadline = now + test.duration_min * 60000;
  if (test.end_at) deadline = Math.min(deadline, Date.parse(test.end_at));
  run(`INSERT INTO attempts (student_id, test_id, started_at, deadline_at, question_order, option_maps, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  student.id, test.id, new Date(now).toISOString(), new Date(deadline).toISOString(),
  JSON.stringify(order), JSON.stringify(optionMaps), meta.ip || '', String(meta.ua || '').slice(0, 300));
  const a = get('SELECT * FROM attempts WHERE student_id = ?', student.id);
  order.forEach((s) => s.qids.forEach((q) => run('INSERT INTO attempt_questions (attempt_id, question_id) VALUES (?, ?)', a.id, q)));
  return a;
}

function grade(attempt, test) {
  const order = JSON.parse(attempt.question_order);
  const answers = JSON.parse(attempt.answers);
  const qids = order.flatMap((s) => s.qids);
  const correctMap = new Map();
  if (qids.length) {
    const rows = all(`SELECT id, correct_index FROM questions WHERE id IN (${qids.map(() => '?').join(',')})`, ...qids);
    rows.forEach((r) => correctMap.set(r.id, r.correct_index));
  }
  let correct = 0, wrong = 0, unanswered = 0;
  const sections = order.map((s) => {
    const sec = { section_id: s.section_id, name: s.name, total: s.qids.length, correct: 0, wrong: 0, unanswered: 0, score: 0 };
    for (const q of s.qids) {
      const a = answers[q];
      if (a === undefined || a === null) sec.unanswered++;
      else if (a === correctMap.get(q)) sec.correct++;
      else sec.wrong++;
    }
    sec.score = sec.correct * test.marks_correct - sec.wrong * test.marks_wrong;
    correct += sec.correct; wrong += sec.wrong; unanswered += sec.unanswered;
    return sec;
  });
  const score = sections.reduce((t, s) => t + s.score, 0);
  return { score, correct, wrong, unanswered, sections };
}

function finalize(attemptId, reason) {
  return tx(() => {
    const a = get('SELECT * FROM attempts WHERE id = ?', attemptId);
    if (!a || a.status === 'submitted') return a;
    const test = get('SELECT * FROM tests WHERE id = ?', a.test_id);
    const g = grade(a, test);
    // Never record a submission time past the deadline (e.g. lazily finalised expired attempts).
    const submittedAt = new Date(Math.min(Date.now(), Date.parse(a.deadline_at))).toISOString();
    run(`UPDATE attempts SET status = 'submitted', submitted_at = ?, score = ?, correct = ?, wrong = ?, unanswered = ?,
           section_scores = ?, submit_reason = ? WHERE id = ?`,
    submittedAt, g.score, g.correct, g.wrong, g.unanswered, JSON.stringify(g.sections), reason, a.id);
    return get('SELECT * FROM attempts WHERE id = ?', a.id);
  });
}

// Attempts whose time ran out without the browser submitting (closed tab, lost power...).
function finalizeExpired(testId) {
  const rows = all(`SELECT id FROM attempts WHERE status = 'in_progress' AND deadline_at < ? ${testId ? 'AND test_id = ?' : ''}`,
    new Date(Date.now() - 15000).toISOString(), ...(testId ? [testId] : []));
  rows.forEach((r) => finalize(r.id, 'time_expired'));
}

// Standard competition ranking: score desc, then less time taken, then earlier submission.
function rankings(testId) {
  return all(`
    SELECT a.*, s.full_name, s.email, s.mobile, s.parent_mobile, s.address,
      ROUND((julianday(a.submitted_at) - julianday(a.started_at)) * 86400) AS time_taken_sec,
      RANK() OVER (ORDER BY a.score DESC, (julianday(a.submitted_at) - julianday(a.started_at)) ASC) AS rank
    FROM attempts a JOIN students s ON s.id = a.student_id
    WHERE a.test_id = ? AND a.status = 'submitted'
    ORDER BY rank, a.submitted_at`, testId);
}


module.exports = {
  testWindowState, sectionsWithPaper, createAttempt, grade, finalize, finalizeExpired, rankings, shuffle,
  mixCounts, bankStatus, pickQuestions,
};
