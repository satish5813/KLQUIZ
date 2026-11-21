// Bytes in and out of the exam portal, per signed-in candidate and in total, for the live monitor's bandwidth view.
// Counts request bodies (Content-Length) and responses (Content-Length) plus ~400 bytes of headers each way, which
// is what actually crosses the network for these small JSON/API requests. In memory only; resets on restart.
const HEADER_BYTES = 400;
const started = Date.now();
const total = { in: 0, out: 0, requests: 0 };
const students = new Map(); // sid -> { in, out, requests, last }

function middleware(keyOf) {
  return (req, res, next) => {
    const inBytes = (Number(req.headers['content-length']) || 0) + HEADER_BYTES;
    res.on('finish', () => {
      const outBytes = (Number(res.getHeader('content-length')) || 0) + HEADER_BYTES;
      total.in += inBytes; total.out += outBytes; total.requests++;
      const key = keyOf(req);
      if (key && key.startsWith('stu:')) {
        const sid = Number(key.slice(4));
        let s = students.get(sid);
        if (!s) { s = { in: 0, out: 0, requests: 0, last: 0 }; students.set(sid, s); }
        s.in += inBytes; s.out += outBytes; s.requests++; s.last = Date.now();
        if (students.size > 100000) students.clear();
      }
    });
    next();
  };
}

function report() {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    since: new Date(started).toISOString(), uptime_sec: Math.round((Date.now() - started) / 1000),
    total: { ...total },
    process: { rss_mb: Math.round(mem.rss / 1048576), heap_mb: Math.round(mem.heapUsed / 1048576), cpu_sec: Math.round((cpu.user + cpu.system) / 1e6) },
    students: Object.fromEntries([...students].map(([sid, s]) => [sid, s])),
  };
}

module.exports = { middleware, report };
