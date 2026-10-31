(function () {
  const { api, el, clear, $, fmtDate, fmtDuration } = KL;
  const out = $('#out');
  const REASONS = { candidate: 'Submitted by you', time_expired: 'Auto-submitted: time over', violations: 'Auto-submitted: too many tab/window switches', test_closed: 'Submitted when the exam was closed', admin_forced: 'Submitted by the invigilator' };

  $('#logoutBtn').addEventListener('click', async () => {
    await api('/api/student/logout', { method: 'POST' }).catch(() => {});
    location.href = '/';
  });

  async function load() {
    let r;
    try { r = await api('/api/student/result'); } catch (e) {
      if (e.status === 401) { location.href = '/'; return; }
      if (e.status === 409) { location.href = '/exam.html'; return; }
      clear(out).appendChild(el('div.alert.error', { text: e.message }));
      return;
    }
    const head = el('div.card', [
      el('div.alert.success', { text: '✔ Your examination has been submitted successfully.' }),
      el('h2', { text: r.student.full_name }),
      el('p.muted', { text: `${r.test.exam_code} · ${r.test.name}` }),
      el('p.small', { text: `${REASONS[r.submit_reason] || 'Submitted'} · ${fmtDate(r.submitted_at)}` }),
    ]);
    if (!r.published) {
      clear(out).append(head, el('div.card', [el('h3', { text: 'Results will be announced soon' }), el('p.muted', { text: 'The results and merit list will be published by KL University admissions. You may now close this window.' })]));
      return;
    }
    const pct = r.max_score ? Math.max(0, Math.round((r.score / r.max_score) * 100)) : 0;
    const ring = el('div.score-ring', [el('div', [el('b', { text: r.score }), el('span.muted.small', { text: `out of ${r.max_score}` })])]);
    ring.style.setProperty('--p', pct);
    clear(out).append(
      head,
      el('div.grid-2.mt', [
        el('div.card', { style: 'text-align:center' }, [ring, el('div.muted', { text: `${pct}% score` })]),
        el('div.rank-box', [
          el('div', { text: 'Provisional rank' }),
          el('div.n', { text: r.rank ? `#${r.rank}` : '—' }),
          el('div', { text: `among ${r.candidates} candidate(s) who have submitted so far` }),
          el('div.small.mt', { text: `Time taken: ${fmtDuration(r.time_taken_sec)}` }),
        ]),
      ]),
      el('div.card.mt', [
        el('div.stat-grid.mb', [
          stat(r.correct, 'Correct', 'green'), stat(r.wrong, 'Wrong', 'red'), stat(r.unanswered, 'Unanswered', ''),
        ]),
        el('h3', { text: 'Section-wise performance' }),
        el('div.table-wrap', el('table.table', [
          el('thead', el('tr', ['Section', 'Questions', 'Correct', 'Wrong', 'Unanswered', 'Score'].map((h) => el('th', { text: h })))),
          el('tbody', r.sections.map((s) => el('tr', [
            el('td', el('b', { text: s.name })), el('td', { text: s.total }), el('td', { text: s.correct }),
            el('td', { text: s.wrong }), el('td', { text: s.unanswered }), el('td', el('b', { text: s.score })),
          ]))),
        ])),
        el('p.small.muted.mt', { text: `Marking: +${r.marks_correct} per correct${r.marks_wrong ? `, −${r.marks_wrong} per wrong` : ''}. The rank shown is provisional and may change as other candidates submit. Final merit list will be published by KL University.` }),
      ]),
    );
  }
  const stat = (n, l, c) => el(`div.stat${c ? `.${c}` : ''}`, [el('div.n', { text: n }), el('div.l', { text: l })]);
  load();
}());
