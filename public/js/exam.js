(function () {
  const { api, el, clear, $, toast, modal } = KL;
  const LETTERS = 'ABCD';

  const S = {
    info: null, sections: [], secIdx: 0, qIdx: 0,
    answers: {}, marked: new Set(), visited: new Set(),
    deadline: 0, offset: 0, violations: 0, maxViolations: 0,
    started: false, submitting: false, done: false,
  };

  // ---------------- instructions ----------------
  async function init() {
    let info;
    try { info = await api('/api/student/exam'); } catch (e) {
      if (e.status === 401) { alert(e.message); location.href = '/'; return; }
      $('#iErr').textContent = e.message; $('#iErr').classList.remove('hidden'); $('#instrView').classList.remove('hidden');
      return;
    }
    if (info.attempt && info.attempt.status === 'submitted') { location.href = '/result.html'; return; }
    S.info = info;
    const t = info.test;
    clear($('#iTitle')).append(`${t.exam_code} · ${t.name}`, el('small', { text: t.description }));
    clear($('#iCand')).append(
      el('b', { text: info.student.full_name }), el('br'),
      info.student.email || null, info.student.email ? el('br') : null, info.student.mobile ? `Mobile ${info.student.mobile}` : null,
    );
    clear($('#iSecs')).append(
      ...t.sections.map((s) => el('tr', [el('td', { text: s.name }), el('td', { text: s.question_count })])),
      el('tr', [el('td', el('b', { text: 'Total' })), el('td', el('b', { text: t.sections.reduce((a, s) => a + s.question_count, 0) }))]),
    );
    $('#iMarks').textContent = `Duration ${t.duration_min} minutes · +${t.marks_correct} per correct answer · ${t.marks_wrong ? `−${t.marks_wrong} per wrong answer` : 'no negative marking'} · ${t.max_violations ? `exam closes on tab-switch / full-screen violation no. ${t.max_violations}` : 'violations are recorded'}`;
    $('#iText').textContent = t.instructions;
    const resuming = info.attempt && info.attempt.status === 'in_progress';
    $('#startBtn').textContent = resuming ? 'Resume exam' : 'Start exam';
    if (resuming) $('#iNote').textContent = 'Your exam is in progress. The timer has kept running.';
    else if (t.state !== 'open') $('#iNote').textContent = 'The exam window is not open yet. Wait for the invigilator.';
    $('#iAgree').addEventListener('change', () => { $('#startBtn').disabled = !$('#iAgree').checked; });
    $('#startBtn').addEventListener('click', start);
    $('#logoutBtn').addEventListener('click', async () => { await api('/api/student/logout', { method: 'POST' }).catch(() => {}); location.href = '/'; });
    $('#instrView').classList.remove('hidden');
  }

  async function enterFullscreen() {
    const d = document.documentElement;
    try {
      // Some embedded/mobile browsers never settle this promise, so don't wait on it forever.
      if (!document.fullscreenElement && d.requestFullscreen) {
        await Promise.race([d.requestFullscreen({ navigationUI: 'hide' }), new Promise((r) => setTimeout(r, 1500))]);
      }
    } catch { /* some mobile browsers do not support it; violations are still tracked */ }
  }

  async function start() {
    const btn = $('#startBtn');
    btn.disabled = true;
    await enterFullscreen();
    try {
      await api('/api/student/start', { method: 'POST' });
      await loadPaper();
    } catch (e) {
      btn.disabled = false;
      $('#iErr').textContent = e.message; $('#iErr').classList.remove('hidden');
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }
  }

  async function loadPaper() {
    const p = await api('/api/student/paper');
    if (p.submitted) { location.href = '/result.html'; return; }
    S.sections = p.sections;
    S.answers = Object.fromEntries(Object.entries(p.answers).map(([k, v]) => [Number(k), v]));
    S.marked = new Set(p.marked);
    S.visited = new Set(p.visited);
    S.deadline = Date.parse(p.deadline_at);
    S.offset = Date.parse(p.server_now) - Date.now();
    S.violations = p.violations;
    S.maxViolations = p.max_violations;
    S.marks = [p.marks_correct, p.marks_wrong];
    // Resume at the first question not yet visited.
    outer: for (let si = 0; si < S.sections.length; si++) {
      for (let qi = 0; qi < S.sections[si].questions.length; qi++) {
        if (!S.visited.has(S.sections[si].questions[qi].id)) { S.secIdx = si; S.qIdx = qi; break outer; }
      }
    }
    $('#instrView').classList.add('hidden');
    $('#examView').classList.remove('hidden');
    document.body.classList.add('exam');
    const t = S.info.test;
    clear($('#eTitle')).append(`${t.exam_code} · ${t.name}`, el('small', { text: `${S.sections.reduce((a, s) => a + s.questions.length, 0)} questions` }));
    clear($('#eCand')).append(el('b', { text: S.info.student.full_name }), S.info.student.email ? el('br') : null, S.info.student.email || null);
    const wm = $('#wm');
    const mark = [S.info.student.email, S.info.student.mobile].filter(Boolean).join(' · ') || S.info.student.full_name;
    for (let i = 0; i < 40; i++) wm.appendChild(el('span', { text: mark }));
    S.started = true;
    buildTabs();
    show();
    setInterval(tick, 500);
    tick();
    updateViolInfo();
    armGuards();
  }

  // ---------------- rendering ----------------
  const cur = () => S.sections[S.secIdx].questions[S.qIdx];
  const status = (q) => {
    const a = S.answers[q.id] !== undefined;
    const m = S.marked.has(q.id);
    if (a && m) return 'am';
    if (m) return 'm';
    if (a) return 'a';
    if (S.visited.has(q.id)) return 'na';
    return 'nv';
  };

  function buildTabs() {
    clear($('#secTabs')).append(...S.sections.map((s, i) => el(`button${i === S.secIdx ? '.active' : ''}`, {
      type: 'button',
      onclick: () => { S.secIdx = i; S.qIdx = 0; show(); },
    }, [s.name, el('span.cnt', { text: `(${s.questions.filter((q) => S.answers[q.id] !== undefined).length}/${s.questions.length})` })])));
  }

  function show() {
    const sec = S.sections[S.secIdx];
    const q = cur();
    if (!S.visited.has(q.id)) { S.visited.add(q.id); save({ qid: q.id }); }
    const globalNo = S.sections.slice(0, S.secIdx).reduce((a, s) => a + s.questions.length, 0) + S.qIdx + 1;
    $('#qNo').textContent = `${sec.name} — Question ${S.qIdx + 1} of ${sec.questions.length}  (Q.${globalNo})`;
    $('#qMarks').textContent = `+${S.marks[0]}${S.marks[1] ? ` / −${S.marks[1]}` : ''}`;
    KLRender.rich($('#qText'), q.text);
    clear($('#qFig')).append(KLRender.diagram(q.diagram) || '');
    $('#opts').classList.toggle('structures', q.options_format === 'smiles');
    clear($('#opts')).append(...q.options.map((o, i) => el(`div.opt${S.answers[q.id] === i ? '.sel' : ''}`, {
      role: 'radio', tabindex: 0, 'aria-checked': String(S.answers[q.id] === i),
      onclick: () => choose(i),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(i); } },
    }, [el('span.l', { text: LETTERS[i] }), el('span.tx', KLRender.option(o, q.options_format))])));
    $('#markBtn').textContent = S.marked.has(q.id) ? 'Unmark & next' : 'Mark for review & next';
    $('#prevBtn').disabled = S.secIdx === 0 && S.qIdx === 0;
    $('#qScroll').scrollTop = 0;
    buildTabs();
    renderPalette();
  }

  function renderPalette() {
    const sec = S.sections[S.secIdx];
    $('#palTitle').textContent = sec.name;
    $('#palSub').textContent = `${sec.questions.length} questions in this section`;
    clear($('#pgrid')).append(...sec.questions.map((q, i) => el(`button.pbtn.st-${status(q)}${i === S.qIdx ? '.cur' : ''}`, {
      type: 'button', text: i + 1, title: `Question ${i + 1}`,
      onclick: () => { S.qIdx = i; show(); $('#palette').classList.remove('open'); },
    })));
    const counts = { a: 0, na: 0, nv: 0, m: 0, am: 0 };
    sec.questions.forEach((q) => { counts[status(q)]++; });
    $('#lgA').textContent = counts.a; $('#lgNA').textContent = counts.na; $('#lgNV').textContent = counts.nv;
    $('#lgM').textContent = counts.m; $('#lgAM').textContent = counts.am;
  }

  function choose(i) {
    const q = cur();
    S.answers[q.id] = i;
    save({ qid: q.id, answer: i });
    show();
  }

  function next() {
    const sec = S.sections[S.secIdx];
    if (S.qIdx < sec.questions.length - 1) S.qIdx++;
    else if (S.secIdx < S.sections.length - 1) { S.secIdx++; S.qIdx = 0; }
    else { toast('This is the last question. Review your answers or submit the exam.'); }
    show();
  }

  $('#nextBtn').addEventListener('click', next);
  $('#prevBtn').addEventListener('click', () => {
    if (S.qIdx > 0) S.qIdx--;
    else if (S.secIdx > 0) { S.secIdx--; S.qIdx = S.sections[S.secIdx].questions.length - 1; }
    show();
  });
  $('#clearBtn').addEventListener('click', () => {
    const q = cur();
    delete S.answers[q.id];
    save({ qid: q.id, answer: null });
    show();
  });
  $('#markBtn').addEventListener('click', () => {
    const q = cur();
    const m = !S.marked.has(q.id);
    if (m) S.marked.add(q.id); else S.marked.delete(q.id);
    save({ qid: q.id, marked: m });
    next();
  });
  $('#palBtn').addEventListener('click', () => $('#palette').classList.toggle('open'));
  $('#submitBtn').addEventListener('click', confirmSubmit);

  // ---------------- autosave (serialised, retried) ----------------
  const queue = [];
  let saving = false;
  function save(item) {
    queue.push(item);
    pump();
  }
  async function pump() {
    if (saving || !queue.length || S.done) return;
    saving = true;
    $('#saveState').textContent = 'Saving…';
    $('#saveState').style.color = 'var(--muted)';
    while (queue.length && !S.done) {
      try {
        await api('/api/student/answer', { method: 'POST', body: queue[0] });
        queue.shift();
      } catch (e) {
        if (e.status === 410) { S.done = true; location.href = '/result.html'; return; }
        if (e.status === 401) { alert(e.message); location.href = '/'; return; }
        if (e.status === 400) { queue.shift(); continue; }
        $('#saveState').textContent = '⚠ Offline — retrying…';
        $('#saveState').style.color = 'var(--kl-red)';
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
    saving = false;
    $('#saveState').textContent = '✓ Saved';
    $('#saveState').style.color = 'var(--green)';
  }
  async function flush(timeoutMs = 8000) {
    const until = Date.now() + timeoutMs;
    while ((queue.length || saving) && Date.now() < until) await new Promise((r) => setTimeout(r, 150));
  }

  // ---------------- timer ----------------
  function tick() {
    if (S.done) return;
    const left = Math.max(0, Math.floor((S.deadline - (Date.now() + S.offset)) / 1000));
    const h = Math.floor(left / 3600); const m = Math.floor((left % 3600) / 60); const s = left % 60;
    const p = (n) => String(n).padStart(2, '0');
    $('#timer').textContent = `${p(h)}:${p(m)}:${p(s)}`;
    $('#timer').classList.toggle('low', left <= 300);
    if (left === 300 && !S.warned5) { S.warned5 = true; toast('5 minutes remaining!', 'error'); }
    if (left <= 0) submit('time');
  }

  // ---------------- submit ----------------
  function confirmSubmit() {
    const rows = S.sections.map((s) => {
      const c = { a: 0, na: 0, nv: 0, m: 0, am: 0 };
      s.questions.forEach((q) => { c[status(q)]++; });
      return el('tr', [el('td', el('b', { text: s.name })), el('td', { text: s.questions.length }), el('td', { text: c.a + c.am }),
        el('td', { text: c.na }), el('td', { text: c.m + c.am }), el('td', { text: c.nv })]);
    });
    const unanswered = S.sections.reduce((a, s) => a + s.questions.filter((q) => S.answers[q.id] === undefined).length, 0);
    modal({
      title: 'Submit examination?',
      wide: true,
      body: [
        el('div.table-wrap', el('table.table.summary-table', [
          el('thead', el('tr', ['Section', 'Questions', 'Answered', 'Not answered', 'Marked for review', 'Not visited'].map((h) => el('th', { text: h })))),
          el('tbody', rows),
        ])),
        unanswered ? el('div.alert.warn.mt', { text: `You have ${unanswered} unanswered question(s).` }) : null,
        el('p.mt', { text: 'Once submitted you cannot change your answers. Are you sure?' }),
      ],
      actions: [
        { label: 'Go back & review', class: 'secondary' },
        { label: 'Yes, submit exam', class: 'green', onClick: (close) => { close(); submit('candidate'); } },
      ],
    });
  }

  async function submit(why) {
    if (S.submitting) return;
    S.submitting = true;
    const o = $('#fsOverlay');
    clear(o.querySelector('.box')).append(el('h2', { text: why === 'time' ? 'Time is up!' : why === 'violations' ? 'Exam auto-submitted' : 'Submitting your exam…' }),
      el('p', { text: why === 'violations' ? 'You exceeded the allowed number of tab/window switches.' : 'Saving your answers. Please do not close this window.' }), el('span.spinner'));
    o.classList.remove('hidden');
    await flush();
    S.done = true;
    for (let i = 0; i < 5; i++) {
      try {
        if (why !== 'violations') await api('/api/student/submit', { method: 'POST' });
        break;
      } catch (e) {
        if (e.status === 410 || e.status === 401) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    location.replace('/result.html');
  }

  // ---------------- anti-malpractice ----------------
  function updateViolInfo() {
    $('#violInfo').textContent = S.maxViolations
      ? `Violations: ${S.violations} — exam closes at ${S.maxViolations}`
      : `Violations recorded: ${S.violations}`;
  }

  // One trip away from the exam is one incident: leaving the app on a phone fires visibilitychange, blur and
  // fullscreenchange (often the last one only when the student comes back, seconds later). While the warning
  // screen is up, and for a short grace after the student returns, further events are not counted again.
  let incidentOpen = false;
  let graceUntil = 0;

  // Blocking warning screen; the student must tap the button to return to the exam.
  function showGuard(title, text) {
    const o = $('#fsOverlay');
    clear(o.querySelector('.box')).append(
      el('h2', { text: `⚠ ${title}` }),
      el('p', { text }),
      el('button.btn.lg', { type: 'button', text: 'Return to full screen & continue', onclick: async () => {
        await enterFullscreen();
        // Phones that refuse full screen must not leave the student stuck behind this screen.
        o.classList.add('hidden');
        incidentOpen = false;
        graceUntil = Date.now() + 3000;
      } }),
    );
    o.classList.remove('hidden');
  }

  async function violation(type, msg) {
    if (!S.started || S.done || S.submitting) return;
    if (incidentOpen || Date.now() < graceUntil) return;
    incidentOpen = true;
    showGuard('You left the exam screen', 'Recording…');
    try {
      const r = await api('/api/student/violation', { method: 'POST', body: { type } });
      S.violations = r.violations;
      updateViolInfo();
      if (r.auto_submitted) { submit('violations'); return; }
      if (r.max) {
        const left = r.max - r.violations;
        showGuard(left === 1 ? 'FINAL WARNING' : `Warning ${r.violations} of ${r.max - 1}`, `${msg} This has been recorded. ${left === 1
          ? 'If you leave the exam screen once more, your exam will be CLOSED and submitted automatically.'
          : `After ${left} more violation(s) your exam will be closed and submitted automatically.`}`);
      } else showGuard('Violation recorded', `${msg} This has been recorded and will be reported to the examiner.`);
    } catch (e) {
      if (e.status === 410) location.replace('/result.html');
      else showGuard('You left the exam screen', `${msg} Return to the exam now.`);
    }
  }

  function armGuards() {
    document.addEventListener('visibilitychange', () => { if (document.hidden) violation('tab_switch', 'You switched tab / minimised the window.'); });
    window.addEventListener('blur', () => setTimeout(() => { if (!document.hidden && !document.hasFocus()) violation('window_blur', 'You switched to another window.'); }, 300));
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) violation('fullscreen_exit', 'You exited full-screen mode.');
    });
    ['copy', 'cut', 'paste', 'contextmenu', 'dragstart', 'selectstart', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault()));
    document.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      const blocked = k === 'f12' || k === 'printscreen'
        || ((e.ctrlKey || e.metaKey) && ['c', 'v', 'x', 'u', 's', 'p', 'a', 'f', 'r'].includes(k))
        || ((e.ctrlKey || e.metaKey) && e.shiftKey && ['i', 'j', 'c', 'k'].includes(k))
        || k === 'f5' || (e.altKey && k === 'arrowleft');
      if (blocked) {
        e.preventDefault();
        e.stopPropagation();
        if (k === 'printscreen' || (e.shiftKey && ['i', 'j', 'c'].includes(k)) || k === 'f12') violation('devtools', 'That key combination is not allowed.');
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[1-4a-d]$/.test(k) && S.started && !document.querySelector('.modal-backdrop')) {
        choose(/\d/.test(k) ? Number(k) - 1 : k.charCodeAt(0) - 97);
      }
    }, true);
    document.addEventListener('keyup', (e) => {
      if (e.key === 'PrintScreen' && navigator.clipboard) navigator.clipboard.writeText('').catch(() => {});
    });
    window.addEventListener('beforeunload', (e) => { if (!S.done) { e.preventDefault(); e.returnValue = ''; } });
    history.pushState(null, '', location.href);
    window.addEventListener('popstate', () => history.pushState(null, '', location.href));
    if (window.screen && window.screen.isExtended) toast('A second monitor is connected. Disconnect it — switching to it will be recorded as a violation.', 'error');
  }

  init();
}());
