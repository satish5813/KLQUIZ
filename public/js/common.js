// Shared browser helpers. All dynamic text is inserted with textContent (never innerHTML)
// to rule out XSS from question text or student input.
(function () {
  async function api(path, { method = 'GET', body } = {}) {
    const opts = { method, credentials: 'same-origin', headers: { 'X-KL-Req': '1' } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch {
      const e = new Error('Network error — check your connection.');
      e.network = true;
      throw e;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || `Request failed (${res.status})`);
      e.status = res.status;
      throw e;
    }
    return data;
  }

  // el('div.card#main', {onclick}, [children]) — tiny DOM builder.
  function el(spec, attrs, children) {
    if (Array.isArray(attrs) || typeof attrs === 'string' || attrs instanceof Node) { children = attrs; attrs = {}; }
    const m = spec.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
    const node = document.createElement((m && m[1]) || 'div');
    ((m && m[2]) || '').replace(/([.#])([\w-]+)/g, (_, t, n) => {
      if (t === '.') node.classList.add(n); else node.id = n;
    });
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'class') node.className += ` ${v}`;
      else if (k === 'text') node.textContent = v;
      else if (k === 'value') node.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') node[k] = !!v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    append(node, children);
    return node;
  }
  function append(node, children) {
    if (children === undefined || children === null || children === false) return node;
    (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c === undefined || c === null || c === false) return;
      node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    });
    return node;
  }
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };
  const $ = (sel, root = document) => root.querySelector(sel);

  function toast(msg, type = '') {
    let box = document.getElementById('toasts');
    if (!box) { box = el('div#toasts'); document.body.appendChild(box); }
    const t = el(`div.toast${type ? `.${type}` : ''}`, { text: msg });
    box.appendChild(t);
    setTimeout(() => t.remove(), type === 'error' ? 6000 : 3500);
  }

  // modal({title, body, actions:[{label, class, onClick}], wide}) -> {close}
  function modal({ title, body, actions = [], wide = false, onClose }) {
    const back = el('div.modal-backdrop');
    const close = () => { back.remove(); document.removeEventListener('keydown', esc); onClose && onClose(); };
    const esc = (e) => { if (e.key === 'Escape') close(); };
    const foot = actions.length ? el('div.modal-foot', actions.map((a) => el(`button.btn${a.class ? `.${a.class.split(' ').join('.')}` : ''}`, {
      type: 'button', text: a.label, onclick: () => (a.onClick ? a.onClick(close) : close()),
    }))) : null;
    back.appendChild(el(`div.modal${wide ? '.wide' : ''}`, [
      el('div.modal-head', [el('h3', { text: title }), el('button.x', { type: 'button', 'aria-label': 'Close', text: '×', onclick: close })]),
      el('div.modal-body', body),
      foot,
    ]));
    document.body.appendChild(back);
    document.addEventListener('keydown', esc);
    return { close, root: back };
  }

  function confirmBox(title, message, okLabel = 'Confirm', okClass = '') {
    return new Promise((resolve) => {
      let answered = false;
      modal({
        title,
        body: el('p.pre', { text: message }),
        onClose: () => { if (!answered) resolve(false); },
        actions: [
          { label: 'Cancel', class: 'secondary' },
          { label: okLabel, class: okClass, onClick: (close) => { answered = true; close(); resolve(true); } },
        ],
      });
    });
  }

  async function withBusy(btn, fn) {
    const label = btn.textContent;
    btn.disabled = true;
    clear(btn).appendChild(el('span.spinner'));
    btn.appendChild(document.createTextNode(' Please wait…'));
    try { return await fn(); } finally { btn.disabled = false; btn.textContent = label; }
  }

  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const fmtDuration = (sec) => {
    if (sec === null || sec === undefined) return '—';
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
    return h ? `${h}h ${m}m` : `${m}m ${r}s`;
  };
  const toLocalInput = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  window.KL = { api, el, append, clear, $, toast, modal, confirmBox, withBusy, fmtDate, fmtDuration, toLocalInput };
}());
