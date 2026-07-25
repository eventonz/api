/**
 * Traffic stats page — GET /stats?key=<api key>
 *
 * Parses the nginx access log and renders a small server-side HTML dashboard:
 * totals, per-endpoint counts (ids collapsed to {id}), status breakdown and
 * the most recent requests. Auto-refreshes via <meta http-equiv="refresh">
 * (helmet's CSP blocks inline JS, so no client scripting is used).
 *
 * Auth: same api_keys check as the bearer hook, but via ?key= so it works in
 * a plain browser tab. GET /stats.json?key= returns the raw JSON.
 */

const fs     = require('fs');
const crypto = require('crypto');
const pool   = require('../config/database');
const redis  = require('../config/redis');

const LOG_PATH  = process.env.NGINX_ACCESS_LOG || '/var/log/nginx/evento-api.access.log';
const CACHE_TTL = 30 * 1000; // parse at most every 30s
const KEY_CACHE_PREFIX = 'apikey:';

let cache = { at: 0, data: null };

async function validKey(key) {
  if (!key) return false;
  const keyHash  = crypto.createHash('sha256').update(String(key).trim()).digest('hex');
  const cacheKey = KEY_CACHE_PREFIX + keyHash;
  try {
    const cached = await redis.get(cacheKey);
    if (cached === 'valid')   return true;
    if (cached === 'invalid') return false;
  } catch { /* fall through to PG */ }
  const { rows } = await pool.query(
    'SELECT id FROM api_keys WHERE key_hash = $1 AND active = TRUE', [keyHash]
  );
  const ok = rows.length > 0;
  redis.setex(cacheKey, 300, ok ? 'valid' : 'invalid').catch(() => {});
  return ok;
}

// "1.2.3.4 - - [25/Jul/2026:03:08:49 +0000] "GET /v1/x HTTP/1.1" 200 222 "-" "UA""
const LINE_RE = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d{3}) \S+ "[^"]*" "([^"]*)"/;

// Collapse numeric ids and uuids so endpoints group together
function normalisePath(p) {
  return p
    .split('?')[0]
    .replace(/\/[0-9]+(?=\/|$)/g, '/{id}')
    .replace(/\/[0-9a-fA-F-]{32,36}(?=\/|$)/g, '/{uuid}');
}

function parseLog() {
  if (cache.data && Date.now() - cache.at < CACHE_TTL) return cache.data;

  let raw = '';
  try {
    raw = fs.readFileSync(LOG_PATH, 'utf8');
  } catch (err) {
    return { error: `Cannot read ${LOG_PATH}: ${err.message}` };
  }

  const endpoints = new Map(); // "METHOD path" -> stats
  const hourly    = new Map(); // "HH" -> count
  const recent    = [];
  let total = 0, s2xx = 0, s4xx = 0, s5xx = 0;

  const lines = raw.split('\n');
  for (const line of lines) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const [, ip, time, method, path, status, ua] = m;
    total++;
    const st = Number(status);
    if (st < 400) s2xx++;
    else if (st < 500) s4xx++;
    else s5xx++;

    const key = `${method} ${normalisePath(path)}`;
    let e = endpoints.get(key);
    if (!e) { e = { count: 0, ok: 0, err4: 0, err5: 0, last: '' }; endpoints.set(key, e); }
    e.count++;
    if (st < 400) e.ok++; else if (st < 500) e.err4++; else e.err5++;
    e.last = time;

    const hour = time.slice(12, 14);
    hourly.set(hour, (hourly.get(hour) || 0) + 1);
  }

  for (let i = lines.length - 1; i >= 0 && recent.length < 25; i--) {
    const m = LINE_RE.exec(lines[i]);
    if (!m) continue;
    const [, ip, time, method, path, status, ua] = m;
    recent.push({ ip, time, method, path: path.slice(0, 80), status, ua: ua.slice(0, 40) });
  }

  const data = {
    generated: new Date().toISOString(),
    log: LOG_PATH,
    total, s2xx, s4xx, s5xx,
    endpoints: [...endpoints.entries()]
      .map(([k, v]) => ({ endpoint: k, ...v }))
      .sort((a, b) => b.count - a.count),
    hourly: [...hourly.entries()].sort(),
    recent,
  };
  cache = { at: Date.now(), data };
  return data;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderHtml(d, key) {
  if (d.error) return `<html><body><h2>Stats unavailable</h2><p>${esc(d.error)}</p></body></html>`;

  const maxHour = Math.max(1, ...d.hourly.map(([, c]) => c));
  const bars = d.hourly.map(([h, c]) =>
    `<div class="bar" title="${h}:00 — ${c} requests"><div class="fill" style="height:${Math.max(2, Math.round((c / maxHour) * 60))}px"></div><span>${h}</span></div>`
  ).join('');

  const rows = d.endpoints.slice(0, 40).map((e) => `
    <tr><td class="ep">${esc(e.endpoint)}</td>
      <td class="n">${e.count.toLocaleString()}</td>
      <td class="n ok">${e.ok.toLocaleString()}</td>
      <td class="n ${e.err4 ? 'warn' : 'dim'}">${e.err4.toLocaleString()}</td>
      <td class="n ${e.err5 ? 'bad' : 'dim'}">${e.err5.toLocaleString()}</td>
      <td class="dim">${esc(e.last.slice(12, 20))}</td></tr>`).join('');

  const recentRows = d.recent.map((r) => `
    <tr><td class="dim">${esc(r.time.slice(12, 20))}</td>
      <td>${esc(r.method)}</td><td class="ep">${esc(r.path)}</td>
      <td class="n ${r.status < '400' ? 'ok' : 'bad'}">${esc(r.status)}</td>
      <td class="dim">${esc(r.ip)}</td><td class="dim">${esc(r.ua)}</td></tr>`).join('');

  return `<!doctype html><html><head>
<meta charset="utf-8"><title>eventoapi traffic</title>
<meta http-equiv="refresh" content="30;url=/stats?key=${encodeURIComponent(key)}">
<style>
  body{background:#0f1420;color:#dce3f0;font:14px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:24px}
  h1{font-size:18px;margin:0 0 4px} .sub{color:#7f8ba3;font-size:12px;margin-bottom:20px}
  .cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}
  .card{background:#1a2233;border-radius:10px;padding:12px 18px;min-width:110px}
  .card b{display:block;font-size:22px} .card span{color:#7f8ba3;font-size:12px}
  .ok{color:#5dd39e}.warn{color:#e8c468}.bad{color:#e87a68}.dim{color:#5c6780}
  table{border-collapse:collapse;width:100%;margin-bottom:26px;background:#151c2c;border-radius:10px;overflow:hidden}
  th{text-align:left;font-size:11px;text-transform:uppercase;color:#7f8ba3;padding:8px 12px;background:#1a2233}
  td{padding:6px 12px;border-top:1px solid #222c42;font-size:13px}
  td.n{text-align:right;font-variant-numeric:tabular-nums}
  td.ep{font-family:ui-monospace,Menlo,monospace;font-size:12px}
  .chart{display:flex;align-items:flex-end;gap:4px;background:#151c2c;border-radius:10px;padding:14px;margin-bottom:26px}
  .bar{display:flex;flex-direction:column;align-items:center;gap:4px;flex:1}
  .bar .fill{width:100%;background:#4a7dde;border-radius:3px 3px 0 0;min-width:8px}
  .bar span{font-size:10px;color:#5c6780}
  h2{font-size:14px;color:#9fb0cc;margin:0 0 8px}
</style></head><body>
<h1>eventoapi.com traffic — today</h1>
<div class="sub">from ${esc(d.log)} · generated ${esc(d.generated)} · auto-refreshes every 30s</div>
<div class="cards">
  <div class="card"><b>${d.total.toLocaleString()}</b><span>requests</span></div>
  <div class="card"><b class="ok">${d.s2xx.toLocaleString()}</b><span>2xx/3xx</span></div>
  <div class="card"><b class="warn">${d.s4xx.toLocaleString()}</b><span>4xx</span></div>
  <div class="card"><b class="bad">${d.s5xx.toLocaleString()}</b><span>5xx</span></div>
</div>
<h2>Requests per hour (UTC)</h2><div class="chart">${bars}</div>
<h2>Endpoints</h2>
<table><tr><th>Endpoint</th><th>Total</th><th>OK</th><th>4xx</th><th>5xx</th><th>Last seen</th></tr>${rows}</table>
<h2>Most recent requests</h2>
<table><tr><th>Time</th><th>Method</th><th>Path</th><th>Status</th><th>IP</th><th>Agent</th></tr>${recentRows}</table>
</body></html>`;
}

async function statsRoutes(app) {
  const authed = async (request, reply) => {
    const key = request.query?.key || '';
    if (!(await validKey(key))) {
      reply.code(401).send({ error: 'Invalid or missing ?key=' });
      return null;
    }
    return key;
  };

  app.get('/stats', async (request, reply) => {
    const key = await authed(request, reply);
    if (key === null) return;
    return reply.type('text/html').send(renderHtml(parseLog(), key));
  });

  app.get('/stats.json', async (request, reply) => {
    const key = await authed(request, reply);
    if (key === null) return;
    return reply.send(parseLog());
  });
}

module.exports = statsRoutes;
