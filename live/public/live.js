// Live Proctoring Monitor (examiners). Video tiles come over /live/ws/monitor; AI cost, risk and exam traffic
// come from the exam portal's admin API; server CPU/memory from /live/api/cluster.
(function () {
  const $ = (s) => document.querySelector(s);
  const h = (tag, attrs = {}, kids = []) => {
    const e = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => { if (k === 'text') e.textContent = v; else if (k === 'cls') e.className = v; else if (v !== undefined && v !== null) e.setAttribute(k, v); });
    [].concat(kids).forEach((k) => k !== null && k !== undefined && e.append(k));
    return e;
  };
  const num = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n) ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d }));
  const rupees = (n) => `₹${num(n, 2)}`;
  const getJSON = async (url) => { const r = await fetch(url, { credentials: 'same-origin' }); if (r.status === 401) { location.href = '/admin/login.html?next=/live/'; throw new Error('login'); } return r.json(); };

  const S = { live: null, tests: [], testId: null, proct: null, traffic: null, cluster: null, page: 0, focus: null, imgs: new Map(), ws: null, usdInr: 93.32 };

  // ---------------- data from the exam portal ----------------
  async function loadTests() {
    const tests = await getJSON('/api/admin/tests');
    S.tests = tests.filter((t) => t.status === 'live' || t.proctor_mode !== 'offline').sort((a, b) => (Date.parse(b.start_at || 0) - Date.parse(a.start_at || 0)));
    const sel = $('#testSel');
    sel.replaceChildren(...S.tests.map((t) => h('option', { value: t.id, text: `${t.exam_code} · ${t.name}${t.proctor_mode === 'offline' ? ' (offline)' : ''}` })));
    const pick = S.tests.find((t) => t.status === 'live' && t.proctor_mode !== 'offline' && (!t.end_at || Date.parse(t.end_at) > Date.now())) || S.tests[0];
    if (pick) { sel.value = pick.id; S.testId = pick.id; }
  }
  async function loadProctoring() {
    if (!S.testId) return;
    try { S.proct = await getJSON(`/api/admin/tests/${S.testId}/proctoring`); S.usdInr = S.proct.usd_inr || S.usdInr; } catch { /* keep last */ }
  }
  async function loadTraffic() { try { S.traffic = await getJSON('/api/admin/traffic'); } catch { /* keep last */ } }
  async function loadCluster() { try { S.cluster = await getJSON('/live/api/cluster'); } catch { /* keep last */ } }

  // ---------------- live socket ----------------
  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/live/ws/monitor`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { setConn('on', 'Live'); subscribe(); if (S.focus) ws.send(JSON.stringify({ type: 'focus', sid: S.focus })); };
    ws.onclose = () => { setConn('off', 'Disconnected — reconnecting…'); S.ws = null; setTimeout(connect, 3000); };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') { S.live = JSON.parse(e.data); render(); return; }
      const sid = new DataView(e.data).getUint32(0);
      const url = URL.createObjectURL(new Blob([new Uint8Array(e.data, 4)], { type: 'image/jpeg' }));
      [S.imgs.get(sid), S.focus === sid ? $('#mImg') : null].forEach((img) => {
        if (!img) return;
        const old = img.dataset.url;
        img.src = url; img.dataset.url = url;
        if (old && old !== url) setTimeout(() => URL.revokeObjectURL(old), 2000);
      });
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    };
    S.ws = ws;
  }
  const setConn = (cls, text) => { $('#connDot').className = `dot ${cls}`; $('#connText').textContent = text; };
  function subscribe() {
    if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ type: 'sub', sids: visible().map((s) => s.sid), fps: Number($('#fps').value) }));
  }

  // ---------------- merge ----------------
  function rows() {
    const live = (S.live && S.live.students) || [];
    const byStudent = new Map(((S.proct && S.proct.rows) || []).map((r) => [r.student_id, r]));
    const traffic = (S.traffic && S.traffic.students) || {};
    const ids = new Set([...live.filter((s) => !S.testId || s.testId === S.testId).map((s) => s.sid), ...byStudent.keys()]);
    return [...ids].map((sid) => {
      const l = live.find((s) => s.sid === sid) || { sid, online: false };
      const p = byStudent.get(sid) || {};
      const t = traffic[sid] || { in: 0, out: 0, requests: 0 };
      return { sid, name: l.name || p.full_name || `Candidate ${sid}`, l, p, t, risk: p.risk || 'low' };
    }).sort((a, b) => (b.l.online - a.l.online) || ({ high: 2, medium: 1, low: 0 }[b.risk] - { high: 2, medium: 1, low: 0 }[a.risk]) || a.name.localeCompare(b.name));
  }
  function filtered() {
    const q = $('#search').value.trim().toLowerCase();
    const f = $('#filter').value;
    return rows().filter((r) => (!q || r.name.toLowerCase().includes(q))
      && (f === 'all' || (f === 'online' && r.l.online) || (f === 'offline' && !r.l.online) || (f === 'flagged' && r.risk !== 'low')));
  }
  function visible() {
    const size = Number($('#pageSize').value);
    const all = filtered();
    S.pages = Math.max(1, Math.ceil(all.length / size));
    S.page = Math.min(S.page, S.pages - 1);
    return all.slice(S.page * size, S.page * size + size);
  }

  // ---------------- render ----------------
  let lastGridKey = '';
  function render() {
    const vis = visible();
    $('#pageInfo').textContent = `${S.page + 1} / ${S.pages}`;
    const key = vis.map((r) => r.sid).join(',');
    if (key !== lastGridKey) { lastGridKey = key; buildGrid(vis); subscribe(); }
    vis.forEach(updateTile);
    renderStats(); renderBandwidth(); renderPerStudent(); renderCalc(); renderModal();
  }

  function buildGrid(vis) {
    const keep = new Map();
    $('#grid').replaceChildren(...vis.map((r) => {
      const img = S.imgs.get(r.sid) || h('img', { alt: r.name });
      keep.set(r.sid, img);
      const tile = h('div', { cls: 'tile', 'data-sid': r.sid }, [img, h('div', { cls: 'none', text: 'Waiting for video…' }), h('div', { cls: 'tag' }), h('div', { cls: 'cap' })]);
      tile.addEventListener('click', () => openFocus(r.sid));
      return tile;
    }));
    S.imgs = keep;
    if (!vis.length) $('#grid').append(h('p', { cls: 'hint', text: 'No candidates match. Candidates appear here as soon as they start an online-proctored exam.' }));
  }

  function updateTile(r) {
    const tile = $(`#grid .tile[data-sid="${r.sid}"]`);
    if (!tile) return;
    tile.className = `tile risk-${r.risk}${r.l.online ? '' : ' offline'}`;
    tile.querySelector('.none').classList.toggle('hidden', !!(S.imgs.get(r.sid) || {}).src);
    tile.querySelector('.tag').replaceChildren(...[
      h('i', { cls: r.l.online ? 'green' : 'red', text: r.l.online ? `● ${num(r.l.fps, 1)} fps` : 'offline' }),
      r.risk !== 'low' ? h('i', { cls: r.risk === 'high' ? 'red' : 'amber', text: r.risk.toUpperCase() }) : null,
      r.l.q === 'hd' ? h('i', { text: 'HD' }) : null,
    ].filter(Boolean));
    tile.querySelector('.cap').replaceChildren(h('b', { text: r.name }),
      `${num(r.l.kbps, 0)} kbit/s · ${r.p.flags || 0} findings · AI ${rupees(r.p.cost_inr || 0)}`);
  }

  const stat = (v, label, cls = '') => h('div', { cls: `stat ${cls}` }, [h('b', { text: v }), h('span', { text: label })]);
  function renderStats() {
    const t = (S.live && S.live.totals) || {};
    const pt = (S.proct && S.proct.totals) || {};
    const nodes = (S.cluster && S.cluster.nodes) || [];
    const cpuUsed = nodes.reduce((a, n) => a + (n.cpuM || 0), 0); const cpuCap = nodes.reduce((a, n) => a + (n.cpuM !== null ? n.cpuCapM : 0), 0);
    const memUsed = nodes.reduce((a, n) => a + (n.memMiB || 0), 0); const memCap = nodes.reduce((a, n) => a + (n.memMiB !== null ? n.memCapMiB : 0), 0);
    $('#stats').replaceChildren(
      stat(num(t.online), 'Streaming now', 'green'), stat(num(pt.candidates), 'Candidates in exam'),
      stat(num(pt.high), 'High risk', 'red'), stat(`${num(t.inMbps, 2)} Mbit/s`, 'Video in (all candidates)'),
      stat(`${num(t.outMbps, 2)} Mbit/s`, 'Video out (to monitors)'), stat(`${num(t.fpsIn)}`, 'Frames per second in'),
      stat(rupees(pt.cost_inr), `AI cost (${num(pt.ai_calls)} checks)`), stat(rupees(pt.per_candidate_inr), 'AI cost per candidate', 'green'),
      stat(cpuCap ? `${num((cpuUsed / cpuCap) * 100, 1)}%` : '—', `Servers CPU (${num(cpuUsed / 1000, 2)} of ${num(cpuCap / 1000)} cores)`),
      stat(memCap ? `${num(memUsed / 1024, 1)} GiB` : '—', `Servers memory of ${num(memCap / 1024, 0)} GiB`),
    );
  }

  function renderBandwidth() {
    const c = S.cluster || {};
    const bar = (pct) => h('div', { cls: 'bar' }, h('i', { cls: pct > 85 ? 'bad' : pct > 60 ? 'warn' : '', style: `width:${Math.min(100, pct || 0)}%` }));
    $('#nodes').replaceChildren(h('tr', {}, ['Server', 'Role', 'CPU', '', 'Memory', ''].map((x) => h('th', { text: x }))),
      ...(c.nodes || []).map((n) => h('tr', {}, [h('td', { text: n.name }), h('td', { text: n.role || '' }),
        h('td', { cls: 'num', text: n.cpuM === null ? 'no data' : `${num(n.cpuM)}m / ${num(n.cpuCapM / 1000)} cores` }), h('td', {}, bar(n.cpuM / n.cpuCapM * 100)),
        h('td', { cls: 'num', text: n.memMiB === null ? 'no data' : `${num(n.memMiB / 1024, 1)} / ${num(n.memCapMiB / 1024, 0)} GiB` }), h('td', {}, bar(n.memMiB / n.memCapMiB * 100))])));
    $('#pods').replaceChildren(h('tr', {}, ['Pod', 'CPU', 'Memory'].map((x) => h('th', { text: x }))),
      ...(c.pods || []).map((p) => h('tr', {}, [h('td', { text: p.name }), h('td', { cls: 'num', text: `${num(p.cpuM)}m` }), h('td', { cls: 'num', text: `${num(p.memMiB)} MiB` })])));
    $('#clusterNote').textContent = c.error ? `Server metrics unavailable: ${c.error}` : 'CPU in millicores (1000m = one core). Refreshed every 5 s from the Kubernetes metrics server.';
    const t = (S.live && S.live.totals) || {};
    const pr = (S.live && S.live.proc) || {};
    const tr = S.traffic || { total: { in: 0, out: 0, requests: 0 }, process: {} };
    const n = Math.max(1, t.online || 0);
    const rowsBw = [
      ['Video in now (all candidates)', `${num(t.inMbps, 2)} Mbit/s`, `${num((t.inMbps || 0) * 1000 / n, 0)} kbit/s per streaming candidate`],
      ['Video out now (to examiners)', `${num(t.outMbps, 2)} Mbit/s`, `${num(t.monitors)} monitor(s) open`],
      ['Video received since start', `${num(t.inMB)} MB`, `${num(t.frames)} frames`],
      ['Video sent to examiners since start', `${num(t.outMB)} MB`, ''],
      ['Exam portal traffic (all candidates)', `${num(tr.total.in / 1048576, 1)} MB in · ${num(tr.total.out / 1048576, 1)} MB out`, `${num(tr.total.requests)} requests since ${tr.since ? new Date(tr.since).toLocaleTimeString() : '—'}`],
      ['Live monitor memory (video buffers)', `${num(pr.rssMB)} MiB process`, `${num(pr.bufferKB)} KB latest frames in memory`],
      ['Exam portal memory', `${num(tr.process.rss_mb)} MiB process`, `${num(tr.process.heap_mb)} MiB JS heap`],
    ];
    $('#bw').replaceChildren(h('tr', {}, ['', 'Now / total', 'Detail'].map((x) => h('th', { text: x }))), ...rowsBw.map((r) => h('tr', {}, r.map((x) => h('td', { text: x })))));
  }

  function renderPerStudent() {
    const all = rows();
    S.csvRows = all;
    $('#perStudent').replaceChildren(
      h('tr', {}, ['Candidate', 'Status', 'Video now', 'Video total', 'Avg frame', 'Exam API in / out', 'Device RAM', 'Browser memory', 'Network', 'AI checks', 'Tokens in / out', 'AI cost', 'Risk']
        .map((x) => h('th', { text: x }))),
      ...all.map((r) => h('tr', { cls: r.sid === S.focus ? 'hl' : '' }, [
        h('td', { text: r.name }), h('td', { text: r.l.online ? `● live ${num(r.l.fps, 1)} fps` : (r.p.status || 'offline') }),
        h('td', { cls: 'num', text: `${num(r.l.kbps, 0)} kbit/s` }), h('td', { cls: 'num', text: `${num(r.l.mb, 1)} MB` }),
        h('td', { cls: 'num', text: r.l.frameKB ? `${num(r.l.frameKB, 1)} KB` : '—' }),
        h('td', { cls: 'num', text: `${num(r.t.in / 1024)} / ${num(r.t.out / 1024)} KB` }),
        h('td', { cls: 'num', text: r.l.device && r.l.device.mem ? `${r.l.device.mem} GB` : '—' }),
        h('td', { cls: 'num', text: r.l.stats && r.l.stats.heapMB ? `${num(r.l.stats.heapMB)} / ${num(r.l.stats.heapLimitMB)} MB` : '—' }),
        h('td', { text: r.l.stats && r.l.stats.net ? `${r.l.stats.net} ${r.l.stats.downlink ? `${r.l.stats.downlink} Mbit/s` : ''}` : '—' }),
        h('td', { cls: 'num', text: num(r.p.ai_calls) }), h('td', { cls: 'num', text: `${num(r.p.tokens_in)} / ${num(r.p.tokens_out)}` }),
        h('td', { cls: 'num', text: rupees(r.p.cost_inr || 0) }), h('td', { text: (r.risk || 'low').toUpperCase() }),
      ])));
  }

  // Bandwidth needed for N candidates at a resolution: JPEG frames (what this system sends) and, for comparison,
  // H.264 video at the same frame rate (what a WebRTC video system would send).
  function renderCalc() {
    const N = Math.max(1, Number($('#calcN').value) || 100);
    const fps = Math.max(1, Number($('#calcFps').value) || 7);
    const live = ((S.live && S.live.students) || []).filter((s) => s.frames > 20 && s.q === 'sd');
    const measuredKB = live.length ? live.reduce((a, s) => a + s.frameKB, 0) / live.length : null;
    const bpp = measuredKB ? (measuredKB * 1024) / (320 * 240) : 0.12;
    const res = [['240p (320×240) — this system', 320, 240, 0.12], ['480p (640×480) — enlarged view', 640, 480, 0.35], ['720p HD (1280×720)', 1280, 720, 0.8],
      ['1080p Full HD (1920×1080)', 1920, 1080, 1.5], ['4K UHD (3840×2160)', 3840, 2160, 5]];
    const shrink = (w, hh) => Math.pow((320 * 240) / (w * hh), 0.15); // JPEG compresses bigger frames a little better per pixel
    $('#calc').replaceChildren(
      h('tr', {}, ['Resolution', 'Frame (JPEG)', 'Per candidate', `${N} candidates`, 'Data per hour', 'Server RAM (latest frames)', 'H.264 video instead'].map((x) => h('th', { text: x }))),
      ...res.map(([label, w, hh, h264At7]) => {
        const frameB = w * hh * bpp * shrink(w, hh);
        const per = (frameB * fps * 8) / 1e6;
        const totalMbps = per * N;
        const h264 = h264At7 * (fps / 7);
        return h('tr', { cls: w === 3840 ? 'hl' : '' }, [h('td', { text: label }), h('td', { cls: 'num', text: `${num(frameB / 1024, 0)} KB` }),
          h('td', { cls: 'num', text: `${num(per, 2)} Mbit/s` }), h('td', { cls: 'num', text: totalMbps >= 1000 ? `${num(totalMbps / 1000, 2)} Gbit/s` : `${num(totalMbps, 0)} Mbit/s` }),
          h('td', { cls: 'num', text: `${num((totalMbps / 8) * 3600 / 1000, 1)} GB` }), h('td', { cls: 'num', text: `${num((frameB * N) / 1048576, 0)} MiB` }),
          h('td', { cls: 'num', text: `${num(h264, 2)} Mbit/s each · ${num(h264 * N, 0)} Mbit/s total` })]);
      }));
    $('#calcNote').textContent = `${measuredKB ? `Based on the frames measured right now (${num(measuredKB, 1)} KB average at 320×240)` : 'Based on a typical 320×240 frame (about 9 KB)'}`
      + `; "Data per hour" is for all ${N} candidates together. 4K needs a 4K camera (most laptop and phone front cameras are 720p or 1080p), and candidates' home and mobile connections rarely sustain more than 2–5 Mbit/s upload, so 4K is not practical for live proctoring.`;
  }

  // ---------------- enlarged candidate ----------------
  function openFocus(sid) {
    S.focus = sid;
    $('#mImg').removeAttribute('src');
    $('#modal').classList.remove('hidden');
    if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ type: 'focus', sid }));
    renderModal();
  }
  function closeFocus() {
    S.focus = null;
    $('#modal').classList.add('hidden');
    if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ type: 'focus', sid: null }));
  }
  function renderModal() {
    if (!S.focus) return;
    const r = rows().find((x) => x.sid === S.focus);
    if (!r) return;
    $('#mTitle').textContent = `${r.name} — ${r.l.online ? `live ${num(r.l.fps, 1)} fps${r.l.q === 'hd' ? ' · 640×480' : ''}` : 'offline'}`;
    const d = r.l.device || {}; const st = r.l.stats || {};
    const info = [
      ['Risk', (r.risk || 'low').toUpperCase()], ['Findings', `${r.p.flags || 0} (${r.p.high || 0} serious)`],
      ['AI checks / tokens', `${num(r.p.ai_calls)} · ${num(r.p.tokens_in)} in / ${num(r.p.tokens_out)} out`], ['AI cost', rupees(r.p.cost_inr || 0)],
      ['Video now', `${num(r.l.kbps, 0)} kbit/s · ${num(r.l.frameKB, 1)} KB frames`], ['Video total', `${num(r.l.mb, 1)} MB · ${num(r.l.frames)} frames`],
      ['Exam API traffic', `${num(r.t.in / 1024)} KB in · ${num(r.t.out / 1024)} KB out · ${num(r.t.requests)} requests`],
      ['Device', `${d.mobile ? 'Phone/tablet' : 'Computer'} · ${d.mem ? `${d.mem} GB RAM` : 'RAM ?'} · ${d.cores || '?'} cores · screen ${d.screen || '?'}`],
      ['Browser memory', st.heapMB ? `${num(st.heapMB)} MB used of ${num(st.heapLimitMB)} MB` : 'not reported (Safari/Firefox)'],
      ['Network', st.net ? `${st.net}${st.downlink ? ` · ${st.downlink} Mbit/s` : ''}${st.rtt ? ` · ${st.rtt} ms` : ''}` : '—'],
      ['Frames skipped (slow upload)', num(st.skipped)], ['Reconnections', num(Math.max(0, (r.l.sessions || 1) - 1))],
    ];
    $('#mInfo').replaceChildren(...info.map(([k, v]) => h('tr', {}, [h('th', { text: k }), h('td', { text: v })])),
      ...(r.p.attempt_id ? [h('tr', {}, [h('th', { text: 'Evidence' }), h('td', {}, h('a', { href: `/admin/#/test/${S.testId}/proctoring`, target: '_blank', rel: 'noopener', text: 'Open proctoring report ↗' }))])] : []));
  }

  // ---------------- CSV ----------------
  function csv() {
    const head = ['Candidate', 'Student id', 'Streaming', 'Video kbit/s now', 'Video MB total', 'Avg frame KB', 'Exam API KB in', 'Exam API KB out', 'Device RAM GB', 'Browser heap MB', 'Network', 'AI checks', 'Tokens in', 'Tokens out', 'AI cost INR', 'Risk'];
    const lines = S.csvRows.map((r) => [r.name, r.sid, r.l.online ? 'yes' : 'no', r.l.kbps || 0, r.l.mb || 0, r.l.frameKB || 0, Math.round(r.t.in / 1024), Math.round(r.t.out / 1024),
      (r.l.device || {}).mem || '', (r.l.stats || {}).heapMB || '', (r.l.stats || {}).net || '', r.p.ai_calls || 0, r.p.tokens_in || 0, r.p.tokens_out || 0, r.p.cost_inr || 0, r.risk]);
    const text = [head, ...lines].map((l) => l.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = h('a', { href: URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv' })), download: `live-monitor-${new Date().toISOString().slice(0, 16)}.csv` });
    a.click();
  }

  // ---------------- wiring ----------------
  $('#testSel').addEventListener('change', () => { S.testId = Number($('#testSel').value); S.page = 0; lastGridKey = ''; loadProctoring().then(render); });
  ['#search', '#filter', '#pageSize'].forEach((s) => $(s).addEventListener('input', () => { S.page = 0; render(); }));
  $('#fps').addEventListener('change', subscribe);
  $('#prev').addEventListener('click', () => { S.page = Math.max(0, S.page - 1); render(); });
  $('#next').addEventListener('click', () => { S.page = Math.min(S.pages - 1, S.page + 1); render(); });
  ['#calcN', '#calcFps'].forEach((s) => $(s).addEventListener('input', renderCalc));
  $('#mClose').addEventListener('click', closeFocus);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeFocus(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFocus(); });
  $('#csv').addEventListener('click', csv);

  (async () => {
    try { await loadTests(); } catch { return; }
    await Promise.all([loadProctoring(), loadTraffic(), loadCluster()]);
    connect();
    render();
    setInterval(loadProctoring, 15000);
    setInterval(loadTraffic, 5000);
    setInterval(loadCluster, 5000);
  })();
}());
