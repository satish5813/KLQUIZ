(function () {
  const { api, $, withBusy } = KL;
  // ?next=/live/ (the live monitor) or another admin page; anything else goes to the admin portal.
  const next = new URLSearchParams(location.search).get('next');
  const dest = next && /^\/(live|admin)\/[\w/#.-]*$/.test(next) ? next : '/admin/';
  api('/api/admin/me').then(() => { location.href = dest; }).catch(() => {});
  $('#loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#err');
    err.classList.add('hidden');
    withBusy($('#go'), async () => {
      try {
        await api('/api/admin/login', { method: 'POST', body: { username: $('#u').value, password: $('#p').value } });
        location.href = dest;
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
        $('#p').value = '';
      }
    });
  });
}());
