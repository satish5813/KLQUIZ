(function () {
  const { api, $, withBusy } = KL;
  api('/api/admin/me').then(() => { location.href = '/admin/'; }).catch(() => {});
  $('#loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#err');
    err.classList.add('hidden');
    withBusy($('#go'), async () => {
      try {
        await api('/api/admin/login', { method: 'POST', body: { username: $('#u').value, password: $('#p').value } });
        location.href = '/admin/';
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
        $('#p').value = '';
      }
    });
  });
}());
