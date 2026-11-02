(function () {
  const { api, el, clear, $, toast, modal, confirmBox, withBusy, fmtDate, fmtDuration, toLocalInput } = KL;
  const view = $('#view');

  // ---------------- shell ----------------
  async function boot() {
    try {
      const me = await api('/api/admin/me');
      $('#who').textContent = `Signed in as ${me.username}`;
    } catch {
      location.href = '/admin/login.html';
      return;
    }
    $('#logoutBtn').addEventListener('click', async () => {
      await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
      location.href = '/admin/login.html';
    });
    $('#menuBtn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
    // Phones: tapping the dimmed backdrop (the menu's ::before, outside its box) closes the slide-in menu.
    $('#sidebar').addEventListener('click', (e) => {
      const sb = $('#sidebar');
      const r = sb.getBoundingClientRect();
      if (e.target === sb && (e.clientX > r.right || e.clientY < r.top)) sb.classList.remove('open');
    });
    window.addEventListener('hashchange', route);
    route();
  }

  const handle = (fn) => async (...args) => {
    try { return await fn(...args); } catch (e) {
      if (e.status === 401) { location.href = '/admin/login.html'; return undefined; }
      toast(e.message, 'error');
      return undefined;
    }
  };

  function route() {
    const parts = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/');
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === parts[0]));
    $('#sidebar').classList.remove('open');
    clear(view).appendChild(el('div.row', [el('span.spinner.dark'), el('span.muted', { text: 'Loading…' })]));
    const pages = { dashboard, patterns, tests, test: testDetail, bank, settings };
    handle(pages[parts[0]] || dashboard)(...parts.slice(1));
  }

  const pageHead = (title, sub, actions) => el('div.page-head', [
    el('div', [el('h1', { text: title }), sub ? el('div.sub', { text: sub }) : null]),
    actions ? el('div.row', actions) : null,
  ]);
  const isNameOnly = (e) => String(e || '').startsWith('name-only:');
  const badge = (status) => el(`span.badge.${status}`, { text: String(status).replace('_', ' ').toUpperCase() });
  const field = (label, input, hint) => el('div.field', [el('label', { text: label }), input, hint ? el('div.hint', { text: hint }) : null]);

  // ---------------- dashboard ----------------
  async function dashboard() {
    const s = await api('/api/admin/stats');
    clear(view).append(
      pageHead('Dashboard', 'KL Admissions Entrance Examinations 2027', [el('a.btn', { href: '#/tests', text: '+ New Test' })]),
      el('div.stat-grid', [
        stat(s.tests, 'Tests', ''), stat(s.live_tests, 'Live now', 'green'),
        stat(s.questions, 'Questions in bank', ''), stat(s.pending, 'Awaiting review', 'amber'),
        stat(s.students, 'Registered students', ''), stat(s.in_progress, 'Writing exam now', 'red'),
        stat(s.submitted, 'Submitted', 'green'),
      ]),
      el('div.card.mt', [
        el('h3', { text: 'How to conduct an exam' }),
        el('div.steps', [
          step('Pick pattern', 'KLEEE, KLGBS, KLNEET, KLBSAT, KLECET or your own'),
          step('Create test', 'Name, schedule, marking scheme'),
          step('Set syllabus', 'Per section — or let Gemini draft it'),
          step('Generate bank', 'Gemini writes MCQs from the syllabus'),
          step('Review', 'Approve, edit or reject questions'),
          step('Build paper', 'Pull questions per section count'),
          step('Pass key', 'One key for the whole session'),
          step('Go live', 'Students register & write the exam'),
          step('Results', 'Auto-graded ranking, CSV export'),
        ]),
      ]),
      el('div.card.mt', [
        el('div.card-title', [el('h3', { text: 'Recent tests' }), el('a.btn.ghost.sm', { href: '#/tests', text: 'All tests →' })]),
        s.recent_tests.length ? el('div.table-wrap', el('table.table', [
          el('thead', el('tr', ['Test', 'Exam', 'Status', 'Starts', 'Registered', 'Submitted'].map((h) => el('th', { text: h })))),
          el('tbody', s.recent_tests.map((t) => el('tr', [
            el('td', el('a', { href: `#/test/${t.id}`, text: t.name })), el('td', { text: t.exam_code }), el('td', badge(t.status)),
            el('td', { text: fmtDate(t.start_at) }), el('td', { text: t.students }), el('td', { text: t.submitted }),
          ])))])) : el('p.muted', { text: 'No tests yet. Create one from an exam pattern.' }),
      ]),
    );
  }
  const stat = (n, l, c) => el(`div.stat${c ? `.${c}` : ''}`, [el('div.n', { text: n }), el('div.l', { text: l })]);
  const step = (b, t) => el('div', [el('b', { text: b }), t]);

  // ---------------- exam patterns ----------------
  async function patterns() {
    const list = await api('/api/admin/templates');
    clear(view).append(
      pageHead('Exam Patterns', 'Section-wise question format for each entrance examination', [
        el('button.btn', { type: 'button', text: '+ New Pattern', onclick: () => editPattern(null) }),
      ]),
      ...list.map((t) => el('div.card.pattern-card', [
        el('div.card-title', [
          el('div', [el('h3', { text: `${t.code} — ${t.name}` })]),
          el('div.row', [
            el('button.btn.secondary.sm', { type: 'button', text: 'Edit', onclick: () => editPattern(t) }),
            el('button.btn.danger.sm', { type: 'button', text: 'Delete', onclick: handle(async () => {
              if (!(await confirmBox('Delete pattern', `Delete ${t.code}? Existing tests keep their own copy of the sections.`, 'Delete', 'danger'))) return;
              await api(`/api/admin/templates/${t.id}`, { method: 'DELETE' });
              route();
            }) }),
          ]),
        ]),
        el('div.meta', [
          el('span.badge.blue', { text: t.departments || '—' }),
          el('span.badge', { text: `${t.duration_min / 60 >= 1 ? `${+(t.duration_min / 60).toFixed(2)} Hrs` : `${t.duration_min} min`}` }),
          el('span.badge', { text: t.mode }),
          el('span.badge.red', { text: `${t.sections.reduce((a, s) => a + s.question_count, 0)} MCQs` }),
        ]),
        el('div.table-wrap', el('table.table', [
          el('thead', el('tr', ['Section', 'Questions', 'Approved bank (E / M / H)', 'Syllabus', ''].map((h) => el('th', { text: h })))),
          el('tbody', t.sections.map((s) => {
            const total = s.bank.easy + s.bank.medium + s.bank.hard;
            return el('tr', [
              el('td', el('b', { text: s.name })), el('td', { text: s.question_count }),
              el('td', [
                el(`span.${total >= s.question_count ? 'ok-text' : 'err-text'}`, { text: `${total} ` }),
                el('span.small.muted', { text: `(${s.bank.easy} / ${s.bank.medium} / ${s.bank.hard})${s.bank.pending ? ` · ${s.bank.pending} pending` : ''}` }),
              ]),
              el('td.small.muted', { text: s.syllabus.length > 160 ? `${s.syllabus.slice(0, 160)}…` : s.syllabus }),
              el('td', el('button.btn.purple.sm', { type: 'button', text: '✦ Generate', onclick: () => generateForPattern(t, s) })),
            ]);
          })),
        ])),
      ])),
    );
  }

  // Builds bank questions for a pattern section without needing a test (shared bank code).
  function generateForPattern(t, s) {
    const count = el('input', { type: 'number', min: 1, max: 100, value: 15 });
    const diff = el('select', ['mixed', 'easy', 'medium', 'hard'].map((d) => el('option', { value: d, text: d[0].toUpperCase() + d.slice(1) })));
    const focus = el('input', { type: 'text', maxlength: 500, placeholder: 'Optional focus topics' });
    modal({
      title: `Generate — ${t.bank_code} · ${s.name}`,
      body: [
        el('p.small.muted', { text: 'Questions are written from this section’s syllabus and added to the shared bank as "pending" for review.' }),
        el('div.grid-3', [field('How many', count), field('Difficulty', diff), field('Focus', focus)]),
      ],
      actions: [{ label: 'Cancel', class: 'secondary' }, { label: '✦ Generate', class: 'purple', onClick: handle(async (close) => {
        const btn = document.querySelector('.modal-foot .btn.purple');
        await withBusy(btn, async () => {
          const r = await api('/api/admin/questions/generate', { method: 'POST', body: { template_id: t.id, section_id: s.id, count: Number(count.value), difficulty: diff.value, focus: focus.value } });
          toast(`${r.generated} of ${r.requested} questions added for review${r.rejected ? ` (${r.rejected} rejected by checks)` : ''}`, 'success');
        });
        close(); route();
      }) }],
    });
  }

  function sectionEditor(sections) {
    const box = el('div.sec-editor');
    const rows = el('div');
    const addRow = (s = {}) => {
      const row = el('div.sec-row', [
        el('input', { type: 'text', placeholder: 'Section name (e.g. Physics)', value: s.name || '', 'data-k': 'name', maxlength: 80 }),
        el('input', { type: 'number', min: 1, max: 300, placeholder: 'Qs', value: s.question_count || '', 'data-k': 'question_count' }),
        el('button.btn.danger.sm', { type: 'button', text: 'Remove', onclick: () => row.remove() }),
        el('textarea', { placeholder: 'Syllabus topics for this section', 'data-k': 'syllabus', maxlength: 20000, value: s.syllabus || '' }),
      ]);
      if (s.id) row.dataset.id = s.id;
      rows.appendChild(row);
    };
    (sections.length ? sections : [{}]).forEach(addRow);
    box.append(rows, el('button.btn.secondary.sm', { type: 'button', text: '+ Add section', onclick: () => addRow() }));
    box.read = () => [...rows.children].map((r) => ({
      id: r.dataset.id ? Number(r.dataset.id) : undefined,
      name: r.querySelector('[data-k=name]').value,
      question_count: Number(r.querySelector('[data-k=question_count]').value),
      syllabus: r.querySelector('[data-k=syllabus]').value,
    }));
    return box;
  }

  function editPattern(t) {
    const f = {
      code: el('input', { type: 'text', value: t?.code || '', maxlength: 20, placeholder: 'e.g. KLEEE' }),
      name: el('input', { type: 'text', value: t?.name || '', maxlength: 150 }),
      departments: el('input', { type: 'text', value: t?.departments || '', maxlength: 300, placeholder: 'e.g. B.Tech & BCA' }),
      duration_min: el('input', { type: 'number', value: t?.duration_min || 120, min: 5, max: 600 }),
      mode: el('select', ['ONLINE', 'OFFLINE', 'ONLINE/OFFLINE'].map((m) => el('option', { value: m, text: m, selected: t?.mode === m }))),
    };
    const secs = sectionEditor(t?.sections || []);
    modal({
      title: t ? `Edit ${t.code}` : 'New exam pattern',
      wide: true,
      body: [
        el('div.grid-2', [field('Exam code', f.code), field('Exam name', f.name)]),
        el('div.grid-3', [field('Departments', f.departments), field('Duration (minutes)', f.duration_min), field('Mode', f.mode)]),
        el('h3', { text: 'Sections' }), secs,
      ],
      actions: [
        { label: 'Cancel', class: 'secondary' },
        { label: 'Save pattern', onClick: handle(async (close) => {
          const body = { code: f.code.value, name: f.name.value, departments: f.departments.value, duration_min: Number(f.duration_min.value), mode: f.mode.value, sections: secs.read() };
          await api(t ? `/api/admin/templates/${t.id}` : '/api/admin/templates', { method: t ? 'PUT' : 'POST', body });
          toast('Pattern saved', 'success'); close(); route();
        }) },
      ],
    });
  }

  // ---------------- tests list ----------------
  async function tests() {
    const [list, tpls] = await Promise.all([api('/api/admin/tests'), api('/api/admin/templates')]);
    clear(view).append(
      pageHead('Tests', 'Each test is one exam session with its own paper, pass key and results', [
        el('button.btn', { type: 'button', text: '+ Create Test', onclick: () => createTest(tpls) }),
      ]),
      el('div.card', list.length ? el('div.table-wrap', el('table.table', [
        el('thead', el('tr', ['Test', 'Exam', 'Status', 'Window', 'Paper', 'Registered', 'Submitted', ''].map((h) => el('th', { text: h })))),
        el('tbody', list.map((t) => el('tr', [
          el('td', [el('a', { href: `#/test/${t.id}`, text: t.name }), el('div.small.muted', { text: t.description })]),
          el('td', el('b', { text: t.exam_code })),
          el('td', badge(t.status)),
          el('td.small', { text: `${fmtDate(t.start_at)} → ${fmtDate(t.end_at)}` }),
          el('td', { text: t.selection_mode === 'random' ? `Random · ${t.total_questions} Qs` : `${t.paper_count}/${t.total_questions}` }),
          el('td', { text: t.students }), el('td', { text: t.submitted }),
          el('td', el('a.btn.secondary.sm', { href: `#/test/${t.id}`, text: 'Open' })),
        ]))),
      ])) : el('div', [el('p.muted', { text: 'No tests yet.' }), el('button.btn', { type: 'button', text: 'Create your first test', onclick: () => createTest(tpls) })])),
    );
  }

  function createTest(tpls) {
    const sel = el('select', tpls.map((t) => el('option', { value: t.id, text: `${t.code} — ${t.departments} (${t.sections.reduce((a, s) => a + s.question_count, 0)} MCQs)` })));
    const name = el('input', { type: 'text', maxlength: 150, placeholder: 'e.g. KLEEE 2027 — Phase 1 — 15 Nov' });
    const preview = el('div.small.muted');
    const pad = (n) => String(n).padStart(2, '0');
    const tomorrow = new Date(Date.now() + 86400000);
    const date = el('input', { type: 'date', value: `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}` });
    const start = el('input', { type: 'time', value: '10:00' });
    const end = el('input', { type: 'time' });
    const tpl = () => tpls.find((x) => String(x.id) === sel.value);
    // The window closes `duration` after the start unless the admin sets a later end.
    const autoEnd = () => {
      if (end.dataset.touched || !start.value || !tpl()) return;
      const [h, m] = start.value.split(':').map(Number);
      const mins = h * 60 + m + tpl().duration_min;
      end.value = `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
    };
    const showPreview = () => {
      const t = tpl();
      if (!t) return;
      preview.textContent = `${t.sections.map((s) => `${s.name} ${s.question_count}`).join(' · ')} · ${t.duration_min} min · ${t.mode}`;
      if (!name.dataset.touched) name.value = `${t.code} 2027 — Session 1`;
      autoEnd();
    };
    name.addEventListener('input', () => { name.dataset.touched = '1'; });
    end.addEventListener('input', () => { end.dataset.touched = '1'; });
    start.addEventListener('input', autoEnd);
    sel.addEventListener('change', showPreview);
    showPreview();
    modal({
      title: 'Create test',
      body: [
        field('Exam pattern', sel), preview, el('div.mt'), field('Test name', name),
        el('div.grid-3', [field('Exam date', date), field('Start time', start), field('End time', end)]),
        el('p.small.muted', { text: 'Students can register and start only inside this window. Anyone still writing at the end time is submitted automatically.' }),
      ],
      actions: [
        { label: 'Cancel', class: 'secondary' },
        { label: 'Create', onClick: handle(async (close) => {
          if (!date.value || !start.value || !end.value) { toast('Choose the exam date, start time and end time', 'error'); return; }
          const startAt = new Date(`${date.value}T${start.value}`);
          let endAt = new Date(`${date.value}T${end.value}`);
          if (endAt <= startAt) endAt = new Date(endAt.getTime() + 86400000); // window runs past midnight
          const r = await api('/api/admin/tests', { method: 'POST', body: {
            template_id: Number(sel.value), name: name.value, start_at: startAt.toISOString(), end_at: endAt.toISOString(),
          } });
          close(); location.hash = `#/test/${r.id}/setup`;
        }) },
      ],
    });
  }

  // ---------------- test detail ----------------
  const TABS = [['setup', 'Setup & Syllabus'], ['bank', 'Question Bank'], ['paper', 'Question Paper'], ['access', 'Pass Key & Go Live'], ['students', 'Students'], ['results', 'Results & Ranking']];

  async function testDetail(id, tab = 'setup') {
    const t = await api(`/api/admin/tests/${id}`);
    const body = el('div');
    const actions = [];
    if (t.status === 'draft') actions.push(el('a.btn.green', { href: `#/test/${id}/access`, text: 'Go live →' }));
    if (t.status === 'live') actions.push(el('button.btn.danger', { type: 'button', text: 'Close test', onclick: () => setStatus(t, 'closed') }));
    if (t.status === 'closed') actions.push(el('button.btn.secondary', { type: 'button', text: 'Reopen as draft', onclick: () => setStatus(t, 'draft') }));
    clear(view).append(
      pageHead(t.name, `${t.exam_code} · ${t.description}`, [badge(t.status), ...actions]),
      el('nav.tabs', TABS.map(([k, label]) => el(`a${k === tab ? '.active' : ''}`, { href: `#/test/${id}/${k}`, text: label }))),
      body,
    );
    if (t.locked) body.appendChild(el('div.alert.warn', { text: 'Candidates have started this test. The question paper, sections and marking scheme are locked.' }));
    const tabs = { setup: tabSetup, bank: tabBank, paper: tabPaper, access: tabAccess, students: tabStudents, results: tabResults };
    await (tabs[tab] || tabSetup)(t, body);
  }

  async function setStatus(t, status) {
    const msg = { live: 'Students will be able to register and start the exam.', closed: 'All in-progress attempts will be submitted automatically and no one can start the exam.', draft: 'The test will be hidden from students.' }[status];
    if (!(await confirmBox(`Set status: ${status.toUpperCase()}`, msg, 'Confirm', status === 'closed' ? 'danger' : ''))) return;
    await handle(async () => {
      await api(`/api/admin/tests/${t.id}/status`, { method: 'POST', body: { status } });
      toast(`Test is now ${status}`, 'success'); route();
    })();
  }

  // ----- setup -----
  function tabSetup(t, body) {
    const f = {
      name: el('input', { type: 'text', value: t.name, maxlength: 150 }),
      description: el('input', { type: 'text', value: t.description, maxlength: 500 }),
      duration_min: el('input', { type: 'number', value: t.duration_min, min: 5, max: 600 }),
      marks_correct: el('input', { type: 'number', value: t.marks_correct, step: '0.25', min: 0 }),
      marks_wrong: el('input', { type: 'number', value: t.marks_wrong, step: '0.25', min: 0 }),
      max_violations: el('input', { type: 'number', value: t.max_violations, min: 0, max: 50 }),
      start_at: el('input', { type: 'datetime-local', value: toLocalInput(t.start_at) }),
      end_at: el('input', { type: 'datetime-local', value: toLocalInput(t.end_at) }),
      shuffle_questions: el('input', { type: 'checkbox', checked: t.shuffle_questions }),
      shuffle_options: el('input', { type: 'checkbox', checked: t.shuffle_options }),
      show_result: el('input', { type: 'checkbox', checked: t.show_result }),
      instructions: el('textarea', { rows: 9, value: t.instructions, maxlength: 8000 }),
      mix_easy: el('input', { type: 'number', value: t.mix_easy, min: 0, max: 100, disabled: t.locked }),
      mix_medium: el('input', { type: 'number', value: t.mix_medium, min: 0, max: 100, disabled: t.locked }),
      mix_hard: el('input', { type: 'number', value: t.mix_hard, min: 0, max: 100, disabled: t.locked }),
      registration_mode: el('select', [
        el('option', { value: 'full', text: 'Full details (name, address, email, mobiles)', selected: t.registration_mode !== 'name_only' }),
        el('option', { value: 'name_only', text: 'Name only (trial / practice session)', selected: t.registration_mode === 'name_only' }),
      ]),
      selection_mode: el('select', { disabled: t.locked }, [
        el('option', { value: 'random', text: 'Random set for every student (same difficulty mix)', selected: t.selection_mode === 'random' }),
        el('option', { value: 'fixed', text: 'Same question paper for all students (order shuffled)', selected: t.selection_mode === 'fixed' }),
      ]),
    };
    const mixInfo = el('div.small');
    const mixTable = el('tbody');
    // Mirrors mixCounts() on the server so the admin sees exactly what each student will get.
    const renderMix = () => {
      const e = Number(f.mix_easy.value) || 0; const m = Number(f.mix_medium.value) || 0; const h = Number(f.mix_hard.value) || 0;
      const sum = e + m + h;
      mixInfo.textContent = sum === 100 ? `Total ${sum}% ✓` : `Total ${sum}% — must be exactly 100%`;
      mixInfo.className = sum === 100 ? 'small ok-text' : 'small err-text';
      clear(mixTable).append(...t.sections.map((s) => {
        const n = s.question_count;
        const want = { easy: Math.round((n * e) / 100), hard: Math.round((n * h) / 100) };
        want.medium = Math.max(0, n - want.easy - want.hard);
        const cell = (l) => {
          const have = s.bank.have[l];
          return el('td', [el('b', { text: want[l] }), el(`span.small.${have >= want[l] ? 'ok-text' : 'err-text'}`, { text: ` / ${have} in bank` })]);
        };
        return el('tr', [el('td', el('b', { text: s.name })), el('td', { text: n }), cell('easy'), cell('medium'), cell('hard')]);
      }));
    };
    [f.mix_easy, f.mix_medium, f.mix_hard].forEach((x) => x.addEventListener('input', renderMix));
    renderMix();
    const rows = el('div');
    t.sections.forEach((s) => {
      const syl = el('textarea', { rows: 3, value: s.syllabus, maxlength: 20000, 'data-k': 'syllabus' });
      const aiBtn = el('button.btn.purple.sm', { type: 'button', text: '✦ Draft with Gemini' });
      aiBtn.addEventListener('click', handle(() => withBusy(aiBtn, async () => {
        const r = await api(`/api/admin/tests/${t.id}/sections/${s.id}/syllabus`, { method: 'POST' });
        syl.value = r.syllabus; toast('Syllabus drafted — review and save', 'success');
      })));
      const row = el('div.sec-row', [
        el('input', { type: 'text', value: s.name, 'data-k': 'name', maxlength: 80, disabled: t.locked }),
        el('input', { type: 'number', value: s.question_count, 'data-k': 'question_count', min: 1, max: 300, disabled: t.locked }),
        aiBtn, syl,
      ]);
      row.dataset.id = s.id;
      rows.appendChild(row);
    });
    const saveBtn = el('button.btn.lg', { type: 'button', text: 'Save test' });
    saveBtn.addEventListener('click', handle(() => withBusy(saveBtn, async () => {
      const sections = [...rows.children].map((r) => ({
        id: Number(r.dataset.id),
        name: r.querySelector('[data-k=name]').value,
        question_count: Number(r.querySelector('[data-k=question_count]').value),
        syllabus: r.querySelector('[data-k=syllabus]').value,
      }));
      await api(`/api/admin/tests/${t.id}`, { method: 'PUT', body: {
        name: f.name.value, description: f.description.value, duration_min: Number(f.duration_min.value),
        marks_correct: Number(f.marks_correct.value), marks_wrong: Number(f.marks_wrong.value), max_violations: Number(f.max_violations.value),
        mix_easy: Number(f.mix_easy.value), mix_medium: Number(f.mix_medium.value), mix_hard: Number(f.mix_hard.value), selection_mode: f.selection_mode.value, registration_mode: f.registration_mode.value,
        start_at: f.start_at.value ? new Date(f.start_at.value).toISOString() : null,
        end_at: f.end_at.value ? new Date(f.end_at.value).toISOString() : null,
        shuffle_questions: f.shuffle_questions.checked, shuffle_options: f.shuffle_options.checked, show_result: f.show_result.checked,
        instructions: f.instructions.value, sections,
      } });
      toast('Test saved', 'success'); route();
    })));
    body.append(
      el('div.card', [
        el('h3', { text: 'Test details' }),
        el('div.grid-2', [field('Test name', f.name), field('Description', f.description)]),
        el('div.grid-4', [
          field('Duration (minutes)', f.duration_min), field('Marks per correct', f.marks_correct),
          field('Negative marks per wrong', f.marks_wrong, '0 = no negative marking'),
          field('Close exam at violation no.', f.max_violations, 'Tab switch / window change / full-screen exit. 2 = one warning, then the exam is closed and submitted. 0 = record only.'),
        ]),
        el('div.grid-2', [
          field('Exam window opens', f.start_at, 'Leave empty to allow any time while live'),
          field('Exam window closes', f.end_at, 'Attempts are force-submitted at this time'),
        ]),
        el('div.grid-2', [field('Registration form', f.registration_mode, 'Name only: candidates type just their name (then the pass key). Use for trials; real exams need full details.')]),
        el('div.row', [
          el('label.check', [f.shuffle_questions, 'Shuffle question order per student']),
          el('label.check', [f.shuffle_options, 'Shuffle options per student']),
          el('label.check', [f.show_result, 'Show score & rank to student after submit']),
        ]),
      ]),
      el('div.card', [
        el('div.card-title', [el('h3', { text: 'Question paper moderation' }), mixInfo]),
        el('div.grid-4', [field('Easy %', f.mix_easy), field('Medium %', f.mix_medium), field('Hard (tough) %', f.mix_hard), field('Question selection', f.selection_mode)]),
        el('div.table-wrap', el('table.table', [
          el('thead', el('tr', ['Section', 'Questions', 'Easy', 'Medium', 'Hard'].map((x) => el('th', { text: x })))),
          mixTable,
        ])),
        el('p.small.muted', { text: 'Each section is filled with this many easy, medium and hard approved questions. In "Random set" mode every student draws their own questions, so keep at least 2× the section size in the bank for real variety. If a level runs short, the gap is filled from the other levels.' }),
      ]),
      el('div.card', [
        el('div.card-title', [el('h3', { text: 'Sections & syllabus' }), el('span.muted.small', { text: 'Questions are generated and pulled per section using this syllabus' })]),
        el('div.sec-editor', rows),
      ]),
      el('div.card', [el('h3', { text: 'Exam instructions shown to students' }), f.instructions]),
      el('div.row.mt', [saveBtn, el('a.btn.secondary.lg', { href: `#/test/${t.id}/bank`, text: 'Next: Question Bank →' })]),
    );
  }

  // ----- bank (per section) -----
  function tabBank(t, body) {
    const listBox = el('div');
    body.append(el('div.alert.info', { text: `Questions are stored in the shared bank under exam "${t.exam_code}" and the section name, so they can be reused by future ${t.exam_code} tests. Approve questions before building the paper.` }));
    t.sections.forEach((s) => {
      const target = s.question_count;
      const pct = Math.min(100, Math.round((s.bank_approved / target) * 100));
      const count = el('input', { type: 'number', min: 1, max: 100, value: Math.max(5, Math.min(100, target - s.bank_approved > 0 ? target - s.bank_approved + 5 : 10)) });
      const diff = el('select', ['mixed', 'easy', 'medium', 'hard'].map((d) => el('option', { value: d, text: d[0].toUpperCase() + d.slice(1) })));
      const focus = el('input', { type: 'text', placeholder: 'Optional: focus topics (e.g. Thermodynamics, Optics)', maxlength: 500 });
      const auto = el('input', { type: 'checkbox' });
      const gen = el('button.btn.purple', { type: 'button', text: '✦ Generate with Gemini' });
      gen.addEventListener('click', handle(() => withBusy(gen, async () => {
        toast(`Gemini is writing ${count.value} ${s.name} questions… this can take a minute.`);
        const r = await api('/api/admin/questions/generate', { method: 'POST', body: {
          test_id: t.id, section_id: s.id, count: Number(count.value), difficulty: diff.value, focus: focus.value, auto_approve: auto.checked,
        } });
        toast(`${r.generated} of ${r.requested} ${s.name} questions added${auto.checked ? ' and approved' : ' for review'}${r.rejected ? ` (${r.rejected} rejected by formula/diagram checks)` : ''}`, 'success');
        route();
      })));
      body.appendChild(el('div.section-card', [
        el('div.row.between', [
          el('div', [el('h3', { text: s.name }), el('div.small.muted', { text: s.syllabus ? s.syllabus.slice(0, 180) + (s.syllabus.length > 180 ? '…' : '') : 'No syllabus set — add one in Setup for better questions.' })]),
          el('div.row', [
            el('span.badge.approved', { text: `${s.bank_approved} approved` }),
            el('span.badge.pending', { text: `${s.bank_pending} pending` }),
            el('span.badge', { text: `needs ${target}` }),
            el('span.badge.blue', { text: `E ${s.bank.have.easy} · M ${s.bank.have.medium} · H ${s.bank.have.hard}`, title: 'Approved questions by difficulty' }),
            el('button.btn.secondary.sm', { type: 'button', text: 'Review questions', onclick: () => {
              clear(listBox).appendChild(questionList({ exam_code: t.exam_code, subject: s.name, status: s.bank_pending ? 'pending' : '' }, t.locked));
              listBox.scrollIntoView({ behavior: 'smooth' });
            } }),
          ]),
        ]),
        el('div.progress', el(`span${pct < 100 ? '.warn' : ''}`, { style: `width:${pct}%` })),
        el('div.gen-form', [
          el('div', [el('label', { text: 'How many' }), count]),
          el('div', [el('label', { text: 'Difficulty' }), diff]),
          el('div', [el('label', { text: 'Focus (optional)' }), focus]),
          el('label.check', [auto, 'Auto-approve']),
          gen,
        ]),
      ]));
    });
    body.append(el('div.row.mt', [el('a.btn.secondary', { href: `#/test/${t.id}/paper`, text: 'Next: Build question paper →' })]), el('div.mt'), listBox);
  }

  // Reusable question list with filters, bulk actions, edit.
  function questionList(filter, locked) {
    const state = { page: 1, status: filter.status || '', q: '', difficulty: '' };
    const box = el('div.card');
    const listEl = el('div');
    const info = el('span.muted.small');
    const statusSel = el('select', [['', 'All statuses'], ['pending', 'Pending review'], ['approved', 'Approved'], ['rejected', 'Rejected']].map(([v, l]) => el('option', { value: v, text: l, selected: v === state.status })));
    const diffSel = el('select', [['', 'Any difficulty'], ['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']].map(([v, l]) => el('option', { value: v, text: l })));
    const search = el('input', { type: 'search', placeholder: 'Search text or topic…' });
    const selectAll = el('input', { type: 'checkbox' });
    const selected = new Set();
    let timer;
    statusSel.addEventListener('change', () => { state.status = statusSel.value; state.page = 1; load(); });
    diffSel.addEventListener('change', () => { state.difficulty = diffSel.value; state.page = 1; load(); });
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.q = search.value; state.page = 1; load(); }, 300); });
    selectAll.addEventListener('change', () => listEl.querySelectorAll('input[data-qid]').forEach((c) => { c.checked = selectAll.checked; c.dispatchEvent(new Event('change')); }));

    const bulk = (action, label, cls) => el(`button.btn.sm.${cls}`, { type: 'button', text: label, onclick: handle(async () => {
      if (!selected.size) { toast('Select questions first'); return; }
      if (action === 'delete' && !(await confirmBox('Delete questions', `Delete ${selected.size} selected question(s)?`, 'Delete', 'danger'))) return;
      const r = await api('/api/admin/questions/bulk', { method: 'POST', body: { ids: [...selected], action } });
      toast(r.skipped ? `Done. ${r.skipped} question(s) are in a paper and were kept.` : 'Done', 'success');
      load();
    }) });

    const tagBtn = el('button.btn.sm.purple', { type: 'button', text: '✦ Auto-tag difficulty' });
    tagBtn.addEventListener('click', handle(() => withBusy(tagBtn, async () => {
      if (!selected.size) { toast('Select questions first'); return; }
      const r = await api('/api/admin/questions/classify', { method: 'POST', body: { ids: [...selected] } });
      toast(`Gemini tagged ${r.updated}: ${r.easy} easy · ${r.medium} medium · ${r.hard} hard`, 'success');
      load();
    })));

    async function load() {
      selected.clear(); selectAll.checked = false;
      const qs = new URLSearchParams({ page: state.page, limit: 25 });
      if (filter.exam_code) qs.set('exam_code', filter.exam_code);
      if (filter.subject) qs.set('subject', filter.subject);
      if (state.status) qs.set('status', state.status);
      if (state.difficulty) qs.set('difficulty', state.difficulty);
      if (state.q) qs.set('q', state.q);
      const r = await api(`/api/admin/questions?${qs}`);
      info.textContent = `${r.total} question(s)`;
      clear(listEl);
      if (!r.items.length) listEl.appendChild(el('p.muted', { text: 'No questions match.' }));
      r.items.forEach((q, i) => listEl.appendChild(questionCard(q, (r.page - 1) * r.limit + i + 1, { selectable: true, selected, onChange: load, locked })));
      const pages = Math.ceil(r.total / r.limit);
      if (pages > 1) {
        listEl.appendChild(el('div.row', [
          el('button.btn.secondary.sm', { type: 'button', text: '← Prev', disabled: r.page <= 1, onclick: () => { state.page--; load(); } }),
          el('span.small', { text: `Page ${r.page} of ${pages}` }),
          el('button.btn.secondary.sm', { type: 'button', text: 'Next →', disabled: r.page >= pages, onclick: () => { state.page++; load(); } }),
        ]));
      }
    }
    box.append(
      el('div.card-title', [
        el('h3', { text: filter.subject ? `${filter.exam_code} · ${filter.subject}` : 'Questions' }),
        el('button.btn.secondary.sm', { type: 'button', text: '+ Add manually', onclick: () => editQuestion({ exam_code: filter.exam_code || '', subject: filter.subject || '', options: ['', '', '', ''], correct_index: 0, difficulty: 'medium', status: 'approved' }, load) }),
      ]),
      el('div.row.mb', [el('div.grow', search), statusSel, diffSel]),
      el('div.row.mb', [el('label.check', [selectAll, 'Select all on page']), bulk('approve', 'Approve', 'green'), bulk('reject', 'Reject', 'secondary'), bulk('delete', 'Delete', 'danger'), tagBtn, el('div.grow'), info]),
      listEl,
    );
    handle(load)();
    return box;
  }

  function questionCard(q, n, { selectable, selected, onChange, locked, chosen } = {}) {
    const cb = selectable ? el('input', { type: 'checkbox', 'data-qid': q.id }) : null;
    if (cb) cb.addEventListener('change', () => (cb.checked ? selected.add(q.id) : selected.delete(q.id)));
    const setStatus = (status) => handle(async () => { await api('/api/admin/questions/bulk', { method: 'POST', body: { ids: [q.id], action: status } }); onChange && onChange(); });
    return el('div.q-item', [
      el('div.q-head', [cb, el('b', { text: `Q${n}.` }), KLRender.rich(el('div.q-text'), q.text), q.status ? badge(q.status) : null]),
      KLRender.diagram(q.diagram),
      el(`ol${q.options_format === 'smiles' ? '.structures' : ''}`, q.options.map((o, i) => el(`li${i === q.correct_index ? '.correct' : ''}${chosen === i && chosen !== q.correct_index ? '.chosen' : ''}`, [
        KLRender.option(o, q.options_format),
        i === q.correct_index ? el('span.mark', { text: ' ✓' }) : null,
        chosen === i ? el('span.mark', { text: ' ← student' }) : null,
      ]))),
      q.explanation ? el('div.expl', [el('b', { text: 'Explanation: ' }), KLRender.rich(el('span'), q.explanation)]) : null,
      onChange ? el('div.q-foot', [
        el(`span.badge.diff-${q.difficulty}`, { text: q.difficulty }),
        el('span', { text: [q.exam_code, q.subject, q.topic, q.source].filter(Boolean).join(' · ') }),
        q.used_in ? el('span.badge.blue', { text: `in ${q.used_in} paper(s)` }) : null,
        el('div.grow'),
        q.status !== 'approved' ? el('button.btn.green.sm', { type: 'button', text: 'Approve', onclick: setStatus('approve') }) : null,
        q.status !== 'rejected' ? el('button.btn.secondary.sm', { type: 'button', text: 'Reject', onclick: setStatus('reject') }) : null,
        el('button.btn.secondary.sm', { type: 'button', text: 'Edit', onclick: () => editQuestion(q, onChange, locked) }),
        el('button.btn.danger.sm', { type: 'button', text: 'Delete', onclick: handle(async () => {
          if (!(await confirmBox('Delete question', 'Delete this question permanently?', 'Delete', 'danger'))) return;
          await api(`/api/admin/questions/${q.id}`, { method: 'DELETE' }); onChange();
        }) }),
      ]) : null,
    ]);
  }

  function editQuestion(q, onSaved) {
    const f = {
      exam_code: el('input', { type: 'text', value: q.exam_code || '', maxlength: 20 }),
      subject: el('input', { type: 'text', value: q.subject || '', maxlength: 80 }),
      topic: el('input', { type: 'text', value: q.topic || '', maxlength: 120 }),
      difficulty: el('select', ['easy', 'medium', 'hard'].map((d) => el('option', { value: d, text: d, selected: q.difficulty === d }))),
      text: el('textarea', { rows: 5, value: q.text || '', maxlength: 4000 }),
      explanation: el('textarea', { rows: 2, value: q.explanation || '', maxlength: 2000 }),
      status: el('select', ['approved', 'pending', 'rejected'].map((d) => el('option', { value: d, text: d, selected: q.status === d }))),
    };
    const opts = q.options.map((o) => el('input', { type: 'text', value: o, maxlength: 1000 }));
    const radios = opts.map((_, i) => el('input', { type: 'radio', name: 'correct', value: i, checked: i === q.correct_index }));
    const d = q.diagram || {};
    const fmt = el('select', [['text', 'Text / formulas'], ['smiles', 'Chemical structures (SMILES)']].map(([v, l]) => el('option', { value: v, text: l, selected: (q.options_format || 'text') === v })));
    const dKind = el('select', [['none', 'No diagram'], ['smiles', 'Chemical structure (SMILES)'], ['svg', 'SVG drawing']].map(([v, l]) => el('option', { value: v, text: l, selected: (d.kind || 'none') === v })));
    const dCode = el('textarea', { rows: 3, value: d.code || '', maxlength: 30000, placeholder: 'SMILES (e.g. CC(=O)O) or <svg viewBox="0 0 360 220">…</svg>' });
    const dCap = el('input', { type: 'text', value: d.caption || '', maxlength: 200 });
    const preview = el('div.q-item');
    const draw = () => {
      const cur = {
        text: f.text.value, options: opts.map((o) => o.value), correct_index: radios.findIndex((r) => r.checked),
        explanation: f.explanation.value, options_format: fmt.value,
        diagram: dKind.value !== 'none' && dCode.value ? { kind: dKind.value, code: dCode.value, caption: dCap.value } : null,
      };
      clear(preview).append(...questionCard(cur, 1).childNodes);
    };
    [f.text, f.explanation, fmt, dKind, dCode, dCap, ...opts, ...radios].forEach((x) => x.addEventListener('input', draw));
    draw();
    modal({
      title: q.id ? `Edit question #${q.id}` : 'Add question',
      wide: true,
      body: [
        el('div.grid-4', [field('Exam code', f.exam_code), field('Section / subject', f.subject), field('Topic', f.topic), field('Difficulty', f.difficulty)]),
        field('Question', f.text, 'Formulas in LaTeX between $…$ (e.g. $\\frac{1}{2}mv^2$); chemistry with $\\ce{H2SO4}$. Line breaks for passages or tables.'),
        field('Options format', fmt),
        el('label', { text: 'Options (select the correct one)' }),
        ...opts.map((o, i) => el('div.row.mb', [radios[i], el('b', { text: 'ABCD'[i] }), el('div.grow', o)])),
        field('Explanation', f.explanation),
        el('div.grid-3', [field('Diagram', dKind), field('Diagram caption', dCap), field('Status', f.status)]),
        field('Diagram source', dCode),
        el('label', { text: 'Live preview' }), preview,
      ],
      actions: [
        { label: 'Cancel', class: 'secondary' },
        { label: 'Save', onClick: handle(async (close) => {
          const body = {
            exam_code: f.exam_code.value, subject: f.subject.value, topic: f.topic.value, difficulty: f.difficulty.value,
            text: f.text.value, explanation: f.explanation.value, status: f.status.value,
            options: opts.map((o) => o.value), correct_index: radios.findIndex((r) => r.checked),
            options_format: fmt.value,
            diagram: dKind.value !== 'none' && dCode.value.trim() ? { kind: dKind.value, code: dCode.value, caption: dCap.value } : null,
          };
          await api(q.id ? `/api/admin/questions/${q.id}` : '/api/admin/questions', { method: q.id ? 'PUT' : 'POST', body });
          toast('Question saved', 'success'); close(); onSaved && onSaved();
        }) },
      ],
    });
  }

  // ----- paper -----
  async function tabPaper(t, body) {
    const p = await api(`/api/admin/tests/${t.id}/paper`);
    const total = t.sections.reduce((a, s) => a + s.question_count, 0);
    const inPaper = t.sections.reduce((a, s) => a + s.paper_count, 0);
    const build = (sectionId) => handle(async (ev) => {
      const btn = ev.currentTarget;
      if (inPaper && !sectionId && !(await confirmBox('Rebuild paper', 'This replaces the current paper with a fresh random pull from the approved bank.', 'Rebuild'))) return;
      await withBusy(btn, async () => {
        const r = await api(`/api/admin/tests/${t.id}/paper/build`, { method: 'POST', body: sectionId ? { section_id: sectionId } : {} });
        const short = r.report.filter((x) => x.pulled < x.required);
        if (short.length) toast(`Not enough approved questions: ${short.map((x) => `${x.section} ${x.pulled}/${x.required}`).join(', ')}. Generate more in Question Bank.`, 'error');
        else toast('Question paper built', 'success');
        route();
      });
    });
    if (t.selection_mode === 'random') {
      body.appendChild(el('div.alert.info', { text: `Random mode: every student gets their own set drawn from the approved bank (Easy ${t.mix_easy}% · Medium ${t.mix_medium}% · Hard ${t.mix_hard}%). You don't need to build a paper — "Build" below only creates a sample paper so you can preview what a student sees.` }));
    }
    body.append(
      el('div.card', [
        el('div.card-title', [
          el('div', [el('h3', { text: `${t.selection_mode === 'random' ? 'Sample paper' : 'Question paper'} — ${inPaper}/${total} questions` }), el('div.small.muted', { text: 'Questions are pulled randomly from approved bank questions, preferring ones not used in other papers.' })]),
          el('button.btn', { type: 'button', text: inPaper ? 'Rebuild entire paper' : 'Build question paper', disabled: t.locked, onclick: build(null) }),
        ]),
        el('div.table-wrap', el('table.table', [
          el('thead', el('tr', ['Section', 'Required', 'In paper', 'Approved in bank', ''].map((h) => el('th', { text: h })))),
          el('tbody', t.sections.map((s) => el('tr', [
            el('td', el('b', { text: s.name })), el('td', { text: s.question_count }),
            el('td', el(`span.badge.${s.paper_count >= s.question_count ? 'approved' : 'pending'}`, { text: s.paper_count })),
            el('td', { text: s.bank_approved }),
            el('td', el('button.btn.secondary.sm', { type: 'button', text: 'Re-pull section', disabled: t.locked, onclick: build(s.id) })),
          ]))),
        ])),
      ]),
      ...p.sections.filter((s) => s.questions.length).map((s) => el('div.card', [
        el('h3', { text: `${s.name} (${s.questions.length})` }),
        ...s.questions.map((q, i) => {
          const card = questionCard(q, i + 1);
          if (!t.locked) {
            card.appendChild(el('div.q-foot', [el('div.grow'), el('button.btn.danger.sm', { type: 'button', text: 'Remove from paper', onclick: handle(async () => {
              await api(`/api/admin/tests/${t.id}/paper/${q.id}`, { method: 'DELETE' }); route();
            }) })]));
          }
          return card;
        }),
      ])),
    );
  }

  // ----- access / pass key -----
  async function tabAccess(t, body) {
    const pk = t.has_passkey ? (await api(`/api/admin/tests/${t.id}/passkey`)).passkey : null;
    const shown = el('span.passkey', { text: pk ? '••••••••' : 'Not set' });
    let visible = false;
    const toggle = el('button.btn.secondary.sm', { type: 'button', text: 'Show', disabled: !pk, onclick: () => {
      visible = !visible; shown.textContent = visible ? pk : '••••••••'; toggle.textContent = visible ? 'Hide' : 'Show';
    } });
    const custom = el('input', { type: 'text', placeholder: 'Or type your own (6-32 chars)', maxlength: 32 });
    const setKey = (random) => handle(async () => {
      if (pk && !(await confirmBox('Change pass key', 'Students who have not unlocked the exam yet will need the new key.', 'Change'))) return;
      const r = await api(`/api/admin/tests/${t.id}/passkey`, { method: 'POST', body: random ? {} : { passkey: custom.value } });
      modal({ title: 'New pass key', body: [el('p', { text: 'Announce this pass key to all students in the session:' }), el('div.passkey', { text: r.passkey })], actions: [{ label: 'Done', onClick: (c) => { c(); route(); } }] });
    });
    const random = t.selection_mode === 'random';
    const ready = random ? t.sections.every((s) => s.bank.enough) : t.sections.every((s) => s.paper_count >= s.question_count);
    const url = `${location.origin}/`;
    body.append(
      el('div.grid-2', [
        el('div.card', [
          el('h3', { text: 'Session pass key' }),
          el('p.muted.small', { text: 'All students in this session use the same pass key after registering. It is stored hashed for login checks and encrypted for your reference.' }),
          el('div.row.mb', [shown, toggle, pk ? el('button.btn.secondary.sm', { type: 'button', text: 'Copy', onclick: () => navigator.clipboard.writeText(pk).then(() => toast('Copied')) }) : null]),
          el('div.row', [el('button.btn', { type: 'button', text: '⟳ Generate random key', onclick: setKey(true) })]),
          el('div.row.mt', [el('div.grow', custom), el('button.btn.secondary', { type: 'button', text: 'Set', onclick: setKey(false) })]),
        ]),
        el('div.card', [
          el('h3', { text: 'Go-live checklist' }),
          el('ul.checklist', [
            check(t.sections.every((s) => s.syllabus), 'Syllabus set for every section'),
            random
              ? check(ready, `Approved bank covers every section (${t.sections.map((s) => `${s.name} ${s.bank.total}/${s.question_count}`).join(', ')}) — each student gets a random set`)
              : check(ready, `Question paper complete (${t.sections.map((s) => `${s.name} ${s.paper_count}/${s.question_count}`).join(', ')})`),
            check(t.sections.every((s) => s.bank.exact_mix), `Exact difficulty mix available (Easy ${t.mix_easy}% · Medium ${t.mix_medium}% · Hard ${t.mix_hard}%)`),
            check(t.max_violations > 0, t.max_violations > 0 ? `Exam closes at violation no. ${t.max_violations}` : 'Violations are only recorded (exam never closes)'),
            check(!!t.start_at, t.start_at ? `Scheduled: ${fmtDate(t.start_at)} → ${fmtDate(t.end_at)}` : 'No schedule set'),
            check(t.has_passkey, 'Pass key generated'),
          ]),
          el('div.row.mt', [
            t.status !== 'live' ? el('button.btn.green.lg', { type: 'button', text: '● Go live', disabled: !ready || !t.has_passkey, onclick: () => setStatus(t, 'live') }) : el('span.badge.live', { text: 'LIVE' }),
            t.status === 'live' ? el('button.btn.danger', { type: 'button', text: 'Close test', onclick: () => setStatus(t, 'closed') }) : null,
          ]),
          el('p.small.mt', ['Student portal: ', el('a', { href: url, target: '_blank', rel: 'noopener', text: url })]),
        ]),
      ]),
    );
  }
  const check = (ok, text) => el('li', [el(`span.${ok ? 'ok' : 'no'}`, { text: ok ? '✔ ' : '✘ ' }), text]);

  // ----- students -----
  async function tabStudents(t, body) {
    const rows = await api(`/api/admin/tests/${t.id}/students`);
    const filter = el('input', { type: 'search', placeholder: 'Filter by name, email or mobile…' });
    const tbody = el('tbody');
    const render = () => {
      const q = filter.value.toLowerCase();
      clear(tbody).append(...rows.filter((s) => !q || `${s.full_name} ${s.email} ${s.mobile}`.toLowerCase().includes(q)).map((s) => el('tr', [
        el('td', { text: s.id }),
        el('td', [el('b', { text: s.full_name }), el('div.small.muted', { text: s.address })]),
        el('td', isNameOnly(s.email) ? el('span.muted', { text: 'name only (trial)' }) : [el('div', { text: s.email }), el('div.small', { text: `📱 ${s.mobile} · Parent ${s.parent_mobile}` })]),
        el('td', s.attempt_status ? badge(s.attempt_status) : el('span.badge', { text: 'NOT STARTED' })),
        el('td', { text: s.score ?? '—' }),
        el('td', { text: s.violations ?? '—' }),
        el('td.small', { text: fmtDate(s.created_at) }),
        el('td', el('div.row', [
          s.attempt_status === 'in_progress' ? el('button.btn.secondary.sm', { type: 'button', text: 'Force submit', onclick: handle(async () => {
            if (!(await confirmBox('Force submit', `Submit ${s.full_name}'s exam now?`, 'Submit'))) return;
            await api(`/api/admin/attempts/${s.attempt_id}/submit`, { method: 'POST' }); route();
          }) }) : null,
          s.attempt_id ? el('button.btn.secondary.sm', { type: 'button', text: 'Allow retake', onclick: handle(async () => {
            if (!(await confirmBox('Allow retake', `Delete ${s.full_name}'s attempt and answers so they can start again?`, 'Reset', 'danger'))) return;
            await api(`/api/admin/attempts/${s.attempt_id}/reset`, { method: 'POST' }); route();
          }) }) : null,
          el('button.btn.danger.sm', { type: 'button', text: 'Delete', onclick: handle(async () => {
            if (!(await confirmBox('Delete student', `Delete ${s.full_name} and any attempt?`, 'Delete', 'danger'))) return;
            await api(`/api/admin/students/${s.id}`, { method: 'DELETE' }); route();
          }) }),
        ])),
      ])));
    };
    filter.addEventListener('input', render);
    render();
    body.append(el('div.card', [
      el('div.card-title', [el('h3', { text: `Registered students (${rows.length})` }), el('div.row', [
        el('button.btn.secondary.sm', { type: 'button', text: '⟳ Refresh', onclick: route }),
        el('a.btn.secondary.sm', { href: `/api/admin/tests/${t.id}/students.csv`, text: '⬇ Export CSV' }),
      ])]),
      el('div.mb', filter),
      el('div.table-wrap', el('table.table', [el('thead', el('tr', ['#', 'Name & address', 'Contact', 'Status', 'Score', 'Violations', 'Registered', ''].map((h) => el('th', { text: h })))), tbody])),
    ]));
  }

  // ----- results -----
  async function tabResults(t, body) {
    const r = await api(`/api/admin/tests/${t.id}/results`);
    const rs = r.results;
    const avg = rs.length ? rs.reduce((a, x) => a + x.score, 0) / rs.length : 0;
    const secNames = t.sections.map((s) => s.name);
    body.append(
      el('div.stat-grid.mb', [
        stat(rs.length, 'Candidates submitted', ''), stat(rs.length ? rs[0].score : '—', `Top score / ${r.max_score}`, 'green'),
        stat(avg.toFixed(2), 'Average score', ''), stat(rs.filter((x) => x.submit_reason === 'violations').length, 'Auto-submitted (violations)', 'red'),
      ]),
      el('div.card', [
        el('div.card-title', [el('h3', { text: 'Merit list' }), el('div.row', [
          el('button.btn.secondary.sm', { type: 'button', text: '⟳ Refresh', onclick: route }),
          el('a.btn.sm', { href: `/api/admin/tests/${t.id}/results.csv`, text: '⬇ Export ranking CSV' }),
        ])]),
        rs.length ? el('div.table-wrap', el('table.table', [
          el('thead', el('tr', ['Rank', 'Candidate', 'Score', ...secNames, 'C / W / U', 'Time', 'Violations', 'Submitted', ''].map((h) => el('th', { text: h })))),
          el('tbody', rs.map((x) => el(`tr${x.rank === 1 ? '.rank-1' : ''}`, [
            el('td', { text: x.rank }),
            el('td', [el('b', { text: x.full_name }), el('div.small.muted', { text: isNameOnly(x.email) ? 'name only (trial)' : `${x.email} · ${x.mobile}` })]),
            el('td', el('b', { text: x.score })),
            ...secNames.map((n) => el('td', { text: x.sections.find((s) => s.name === n)?.score ?? '—' })),
            el('td.small', { text: `${x.correct} / ${x.wrong} / ${x.unanswered}` }),
            el('td.small', { text: fmtDuration(x.time_taken_sec) }),
            el('td', { text: x.violations }),
            el('td.small', [el('div', { text: fmtDate(x.submitted_at) }), el('div.muted', { text: x.submit_reason })]),
            el('td', el('button.btn.secondary.sm', { type: 'button', text: 'Answer sheet', onclick: handle(() => answerSheet(x.attempt_id)) })),
          ]))),
        ])) : el('p.muted', { text: 'No submissions yet.' }),
      ]),
    );
  }

  async function answerSheet(attemptId) {
    const d = await api(`/api/admin/attempts/${attemptId}`);
    const a = d.attempt;
    modal({
      title: `Answer sheet — ${d.student.full_name}`,
      wide: true,
      body: [
        el('div.row.mb', [
          el('span.badge.blue', { text: `Score ${a.score}` }), el('span.badge.approved', { text: `${a.correct} correct` }),
          el('span.badge.red', { text: `${a.wrong} wrong` }), el('span.badge', { text: `${a.unanswered} unanswered` }),
          el('span.badge.pending', { text: `${a.violations} violations` }),
        ]),
        el('p.small.muted', { text: isNameOnly(d.student.email) ? 'Name-only (trial) registration' : `${d.student.email} · ${d.student.mobile} · Parent ${d.student.parent_mobile} · ${d.student.address}` }),
        a.violation_log.length ? el('details.mb', [el('summary', { text: 'Violation log' }), el('ul.small', a.violation_log.map((v) => el('li', { text: `${fmtDate(v.at)} — ${v.type}` })))]) : null,
        ...d.sections.map((s) => el('div', [
          el('h3.mt', { text: s.name }),
          ...s.questions.map((q, i) => questionCard(q, i + 1, { chosen: q.answer })),
        ])),
      ],
    });
  }

  // ---------------- global bank ----------------
  async function bank() {
    const [subjects, tpls] = await Promise.all([api('/api/admin/questions/subjects'), api('/api/admin/templates')]);
    const listBox = el('div');
    const show = (f) => { clear(listBox).appendChild(questionList(f)); };
    const importBtn = el('button.btn.secondary', { type: 'button', text: '⬆ Import JSON', onclick: () => importDialog(tpls) });
    clear(view).append(
      pageHead('Question Bank', 'All questions across exams and sections', [importBtn, el('button.btn', { type: 'button', text: '+ Add question', onclick: () => editQuestion({ exam_code: '', subject: '', options: ['', '', '', ''], correct_index: 0, difficulty: 'medium', status: 'approved' }, route) })]),
      el('div.card', subjects.length ? el('div.table-wrap', el('table.table', [
        el('thead', el('tr', ['Exam', 'Section', 'Approved', 'Pending', 'Rejected', 'Total', ''].map((h) => el('th', { text: h })))),
        el('tbody', subjects.map((s) => el('tr', [
          el('td', el('b', { text: s.exam_code || '—' })), el('td', { text: s.subject }),
          el('td', el('span.badge.approved', { text: s.approved })), el('td', el('span.badge.pending', { text: s.pending })),
          el('td', { text: s.rejected }), el('td', { text: s.total }),
          el('td', el('button.btn.secondary.sm', { type: 'button', text: 'View', onclick: () => { show({ exam_code: s.exam_code, subject: s.subject }); listBox.scrollIntoView({ behavior: 'smooth' }); } })),
        ]))),
      ])) : el('p.muted', { text: 'The bank is empty. Open a test → Question Bank to generate questions with Gemini.' })),
      el('div.mt'), listBox,
    );
    show({});
  }

  function importDialog() {
    const ta = el('textarea', { rows: 12, placeholder: '[{"exam_code":"KLEEE","subject":"Physics","text":"…","options":["a","b","c","d"],"correct_index":0,"explanation":"…","topic":"…","difficulty":"medium"}]' });
    modal({
      title: 'Import questions (JSON)', wide: true,
      body: [el('p.small.muted', { text: 'Paste a JSON array. Each item needs exam_code, subject, text, 4 options and correct_index (0-3). Imported questions are approved unless "status" says otherwise.' }), ta],
      actions: [{ label: 'Cancel', class: 'secondary' }, { label: 'Import', onClick: handle(async (close) => {
        let items;
        try { items = JSON.parse(ta.value); } catch { toast('Invalid JSON', 'error'); return; }
        const r = await api('/api/admin/questions/import', { method: 'POST', body: { items } });
        toast(`${r.imported} questions imported`, 'success'); close(); route();
      }) }],
    });
  }

  // ---------------- settings ----------------
  async function settings() {
    const s = await api('/api/admin/settings');
    const key = el('input', { type: 'password', placeholder: s.gemini_configured ? `Current key ${s.gemini_key_hint} (${s.gemini_key_source})` : 'Paste your Gemini API key', autocomplete: 'off' });
    const model = el('input', { type: 'text', value: s.gemini_model, maxlength: 80 });
    const save = el('button.btn', { type: 'button', text: 'Save' });
    const test = el('button.btn.purple', { type: 'button', text: 'Test connection' });
    save.addEventListener('click', handle(() => withBusy(save, async () => {
      const body = { gemini_model: model.value };
      if (key.value) body.gemini_key = key.value;
      await api('/api/admin/settings', { method: 'PUT', body });
      toast('Settings saved', 'success'); route();
    })));
    test.addEventListener('click', handle(() => withBusy(test, async () => {
      const r = await api('/api/admin/gemini/test', { method: 'POST' });
      toast(`Gemini (${r.model}) replied: ${r.reply}`, 'success');
    })));
    const cur = el('input', { type: 'password', autocomplete: 'current-password' });
    const nw = el('input', { type: 'password', autocomplete: 'new-password' });
    const nw2 = el('input', { type: 'password', autocomplete: 'new-password' });
    const pw = el('button.btn', { type: 'button', text: 'Change password' });
    pw.addEventListener('click', handle(() => withBusy(pw, async () => {
      if (nw.value !== nw2.value) { toast('New passwords do not match', 'error'); return; }
      await api('/api/admin/password', { method: 'POST', body: { current: cur.value, next: nw.value } });
      toast('Password changed. Other sessions were signed out.', 'success'); cur.value = nw.value = nw2.value = '';
    })));
    clear(view).append(
      pageHead('Settings'),
      el('div.card', [
        el('h3', { text: 'Google Gemini' }),
        el('p.small.muted', ['Get a key from ', el('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener', text: 'Google AI Studio' }), '. It is stored encrypted on the server and never sent to browsers.']),
        el('div', { text: s.gemini_configured ? `Status: configured (${s.gemini_key_hint}, from ${s.gemini_key_source === 'env' ? '.env file' : 'admin settings'})` : 'Status: not configured', class: s.gemini_configured ? 'alert success' : 'alert warn' }),
        el('div.grid-2', [field('API key', key, 'Leave blank to keep the current key'), field('Model', model, 'e.g. gemini-3.8-flash or gemini-3.1-pro-preview')]),
        el('div.row', [save, test, s.gemini_key_source === 'admin' ? el('button.btn.danger', { type: 'button', text: 'Remove stored key', onclick: handle(async () => {
          await api('/api/admin/settings', { method: 'PUT', body: { gemini_key: '' } }); route();
        }) }) : null]),
      ]),
      el('div.card', [
        el('h3', { text: 'Change admin password' }),
        el('div.grid-3', [field('Current password', cur), field('New password (min 10)', nw), field('Repeat new password', nw2)]),
        pw,
      ]),
    );
  }

  boot();
}());
