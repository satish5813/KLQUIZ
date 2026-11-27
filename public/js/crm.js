// Applicant login for exams fed by the Edmission CRM: personal link (/e/<token>) or registered email/mobile,
// then a one-time code, then a face check against the application photo, then the normal exam page.
(function () {
  const { api, el, clear, $, withBusy } = KL;
  const err = $('#err');
  const info = $('#info');
  const showErr = (m) => { info.classList.add('hidden'); err.textContent = m; err.classList.remove('hidden'); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const showInfo = (m) => { err.classList.add('hidden'); info.textContent = m; info.classList.remove('hidden'); };
  const hide = () => { err.classList.add('hidden'); info.classList.add('hidden'); };
  const only = (id) => ['findForm', 'otpForm', 'faceCard', 'doneCard'].forEach((x) => $(`#${x}`).classList.toggle('hidden', x !== id));

  const m = /^\/e\/([\w-]{16,64})\/?$/.exec(location.pathname);
  let ident = m ? { token: m[1] } : null;

  function done(title, text) {
    $('#doneTitle').textContent = title;
    $('#doneText').textContent = text;
    only('doneCard');
  }

  async function lookup() {
    hide();
    let r;
    try { r = await api('/api/student/crm/lookup', { method: 'POST', body: ident }); } catch (e) {
      if (m) { done('Link not valid', e.message); return; }
      showErr(e.message); return;
    }
    if (r.submitted) { done('Exam already submitted', `${r.name}, you have already submitted ${r.exam.name}.`); return; }
    $('#hello').textContent = `Welcome, ${r.name}`;
    $('#examLine').textContent = `${r.exam.name}${r.application_no ? ` · Application No ${r.application_no}` : ''} · ${r.exam.duration_min} minutes`;
    const open = r.exam.state === 'open';
    $('#sendBtn').disabled = !open;
    $('#sendBtn').textContent = open ? `Send login code to ${[r.email, r.phone].filter(Boolean).join(' / ')}` : 'Login opens when the exam starts';
    if (!open) showInfo(r.exam.opens && r.exam.state !== 'ended' ? `Your exam opens on ${r.exam.opens}. Please come back then and reload this page.` : 'This exam is not open right now.');
    only('otpForm');
  }

  async function send(btn) {
    hide();
    await withBusy(btn, async () => {
      try {
        const r = await api('/api/student/crm/otp', { method: 'POST', body: ident });
        $('#sentTo').textContent = `We sent a 6-digit code to ${r.sent_to.join(' and ')}. It is valid for 10 minutes.`;
        $('#codeBox').classList.remove('hidden');
        $('#sendBtn').classList.add('hidden');
        $('#otp').focus();
      } catch (e) { showErr(e.message); }
    });
  }
  $('#sendBtn').addEventListener('click', () => send($('#sendBtn')));
  $('#resendBtn').addEventListener('click', () => send($('#resendBtn')));
  $('#otp').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });

  $('#otpForm').addEventListener('submit', (e) => {
    e.preventDefault();
    hide();
    const otp = $('#otp').value.trim();
    if (!/^\d{6}$/.test(otp)) { showErr('Enter the 6-digit code'); return; }
    withBusy($('#verifyBtn'), async () => {
      try {
        const r = await api('/api/student/crm/verify', { method: 'POST', body: { ...ident, otp } });
        $('#f1').classList.replace('on', 'done');
        if (r.face_required) faceStep(); else location.href = '/exam.html';
      } catch (ex) { showErr(ex.message); $('#otp').value = ''; }
    });
  });

  // ---------- face check ----------
  let stream = null;
  async function faceStep() {
    only('faceCard');
    $('#f2').classList.add('on');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
      $('#cam').srcObject = stream;
      $('#faceBtn').disabled = false;
    } catch {
      $('#faceMsg').textContent = 'Camera not available. Allow camera access for this site (the camera icon in the address bar), then reload the page.';
    }
  }
  function capture() {
    const v = $('#cam');
    const c = document.createElement('canvas');
    c.width = v.videoWidth || 640; c.height = v.videoHeight || 480;
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85).split(',')[1];
  }
  $('#faceBtn').addEventListener('click', () => withBusy($('#faceBtn'), async () => {
    hide();
    $('#faceMsg').textContent = 'Checking…';
    try {
      const r = await api('/api/student/crm/face', { method: 'POST', body: { image: capture() } });
      if (r.done) {
        if (stream) stream.getTracks().forEach((t) => t.stop());
        $('#faceMsg').textContent = r.status === 'passed' ? 'Face verified.' : 'Thank you. Your photo will be reviewed by the examiner.';
        $('#f2').classList.replace('on', 'done');
        setTimeout(() => { location.href = '/exam.html'; }, 900);
        return;
      }
      $('#faceMsg').textContent = `${r.message} Look straight at the camera in good light and try again (${r.tries_left} attempt${r.tries_left === 1 ? '' : 's'} left).`;
    } catch (e) { $('#faceMsg').textContent = ''; showErr(e.message); }
  }));

  // ---------- without a personal link ----------
  async function findStep() {
    let tests = [];
    try { tests = (await api('/api/student/tests')).filter((t) => t.registration_mode === 'crm'); } catch (e) { showErr(e.message); return; }
    const sel = clear($('#test'));
    if (!tests.length) { done('No examination is open right now', 'Please use the exam link sent to you, or check the date and time of your exam.'); return; }
    tests.forEach((t) => sel.appendChild(el('option', { value: t.id, text: `${t.exam_code} — ${t.name}` })));
    const want = new URLSearchParams(location.search).get('test');
    if (want && tests.some((t) => String(t.id) === want)) sel.value = want;
    only('findForm');
  }
  $('#findForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const login = $('#login').value.trim();
    if (login.length < 5) { showErr('Enter your registered email or mobile number'); return; }
    ident = { test_id: Number($('#test').value), login };
    withBusy($('#findBtn'), lookup);
  });

  if (ident) lookup(); else findStep();
}());
