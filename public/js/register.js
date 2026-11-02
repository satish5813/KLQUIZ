(function () {
  const { api, el, clear, $, withBusy, fmtDate } = KL;
  const err = $('#err');
  const showErr = (m) => { err.textContent = m; err.classList.remove('hidden'); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const hideErr = () => err.classList.add('hidden');
  let tests = [];

  async function loadTests() {
    // A candidate who already unlocked the exam goes straight back to it.
    try { await api('/api/student/exam'); location.href = '/exam.html'; return; } catch { /* not logged in */ }
    try {
      tests = await api('/api/student/tests');
    } catch (e) { showErr(e.message); return; }
    const sel = $('#test');
    clear(sel);
    if (!tests.length) {
      $('#regForm').classList.add('hidden');
      $('#noTests').classList.remove('hidden');
      return;
    }
    $('#regForm').classList.remove('hidden');
    $('#noTests').classList.add('hidden');
    if (tests.length > 1) sel.appendChild(el('option', { value: '', text: '— Select your examination —' }));
    tests.forEach((t) => sel.appendChild(el('option', { value: t.id, text: `${t.exam_code} — ${t.name}` })));
    showInfo();
  }

  function showInfo() {
    const t = tests.find((x) => String(x.id) === $('#test').value);
    const info = $('#testInfo');
    if (!t) { info.textContent = ''; return; }
    const parts = [`${t.sections.reduce((a, s) => a + s.question_count, 0)} MCQs — ${t.sections.map((s) => `${s.name} ${s.question_count}`).join(', ')}`, `Duration ${t.duration_min} min`];
    if (t.start_at) parts.push(`Exam window ${fmtDate(t.start_at)} – ${fmtDate(t.end_at)}`);
    info.textContent = parts.join(' · ');
    const waiting = t.state === 'not_started';
    $('#regBtn').disabled = waiting;
    $('#regBtn').textContent = waiting ? `Registration opens at ${fmtDate(t.start_at)}` : 'Submit & continue';
    // Trial sessions ask only for a name.
    const nameOnly = t.registration_mode === 'name_only';
    ['address', 'email'].forEach((id) => $(`#${id}`).closest('.field').classList.toggle('hidden', nameOnly));
    $('#mobile').closest('.grid-2').classList.toggle('hidden', nameOnly);
    $('label[for=full_name]').textContent = nameOnly ? 'Your full name' : 'Full name (as in 10th certificate)';
    $('#resumeHint').textContent = nameOnly
      ? 'Got disconnected during the exam? Reopen this page in the same browser to continue.'
      : 'Already registered and got disconnected? Enter the same email and mobile number to resume your exam.';
  }
  const isNameOnly = () => (tests.find((x) => String(x.id) === $('#test').value) || {}).registration_mode === 'name_only';
  $('#test').addEventListener('change', showInfo);
  $('#refreshBtn').addEventListener('click', loadTests);

  const digits = (s) => s.replace(/[^\d+]/g, '');
  ['mobile', 'parent_mobile'].forEach((id) => $(`#${id}`).addEventListener('input', (e) => { e.target.value = digits(e.target.value); }));

  function validate() {
    const v = (id) => $(`#${id}`).value.trim();
    if (!v('test')) return 'Select your examination';
    if (v('full_name').length < 3) return 'Enter your full name';
    if (!/^[\p{L} .'-]+$/u.test(v('full_name'))) return 'Full name may contain only letters, spaces, dots and hyphens';
    if (isNameOnly()) return $('#agree').checked ? null : 'Please accept the declaration';
    if (v('address').length < 5) return 'Enter your address';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v('email'))) return 'Enter a valid email address';
    const m = /^(\+91)?[6-9]\d{9}$/;
    if (!m.test(v('mobile'))) return 'Enter a valid 10-digit mobile number';
    if (!m.test(v('parent_mobile'))) return 'Enter a valid 10-digit parent mobile number';
    if (v('mobile').slice(-10) === v('parent_mobile').slice(-10)) return 'Parent mobile must be different from your mobile';
    if (!$('#agree').checked) return 'Please accept the declaration';
    return null;
  }

  $('#regForm').addEventListener('submit', (e) => {
    e.preventDefault();
    hideErr();
    const problem = validate();
    if (problem) { showErr(problem); return; }
    withBusy($('#regBtn'), async () => {
      try {
        const r = await api('/api/student/register', { method: 'POST', body: {
          test_id: Number($('#test').value),
          full_name: $('#full_name').value, address: $('#address').value, email: $('#email').value,
          mobile: $('#mobile').value, parent_mobile: $('#parent_mobile').value,
        } });
        $('#hello').textContent = `${r.returning ? 'Welcome back' : 'Registered'}, ${r.name}. Exam: ${r.test}.`;
        $('#regForm').classList.add('hidden');
        $('#keyForm').classList.remove('hidden');
        $('#f1').classList.replace('on', 'done'); $('#f2').classList.add('on');
        $('#passkey').focus();
      } catch (ex) { showErr(ex.message); }
    });
  });

  $('#keyForm').addEventListener('submit', (e) => {
    e.preventDefault();
    hideErr();
    withBusy($('#keyBtn'), async () => {
      try {
        await api('/api/student/unlock', { method: 'POST', body: { passkey: $('#passkey').value.trim() } });
        location.href = '/exam.html';
      } catch (ex) {
        showErr(ex.status === 401 && /register/i.test(ex.message) ? 'Your registration expired. Please submit your details again.' : ex.message);
        $('#passkey').value = '';
      }
    });
  });

  $('#backBtn').addEventListener('click', () => {
    $('#keyForm').classList.add('hidden');
    $('#regForm').classList.remove('hidden');
    $('#f2').classList.remove('on'); $('#f1').classList.replace('done', 'on');
  });

  loadTests();
}());
