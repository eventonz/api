/**
 * Live dashboard snapshot helpers (GET /v2/ops/live). Pure functions over the
 * raw-push list (raceresult:pushes:{rr_eventid} / racetec:pushes:{key}) and
 * the race activity log, so the route stays thin and the folding is testable.
 */
const repair = (t) => t.replace(/("\s*:\s*)(?=[,}\]])/g, '$1null');

/**
 * Fold raw push entries newer than `since` into: how many, which exporter
 * format, how many carried a real split id vs none, distinct bibs, split-id
 * histogram, newest timestamp.
 */
function summarisePushes(entries, since) {
  const s = { pushes: 0, evento: 0, native: 0, unparseable: 0, with_split: 0, no_split: 0, bibs: 0, split_ids: {}, newest: null, oldest: null };
  const bibs = new Set();
  for (const raw of entries) {
    let p; try { p = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { continue; }
    if (new Date(p.at).getTime() < since) break; // newest first
    s.pushes++; s.newest = s.newest || p.at; s.oldest = p.at;
    const body = String(p.body || '');
    let j;
    try { j = JSON.parse(repair(body)); } catch { s.unparseable++; continue; }
    const recs = Array.isArray(j) ? j : [j];
    if (body.includes('evento_created')) s.evento++; else if (Array.isArray(j)) s.native++;
    for (const rec of recs) {
      if (!rec || typeof rec !== 'object') continue;
      bibs.add(rec.bib ?? rec.Bib);
      const id = String(rec.rr_splitid ?? rec.RR_SplitID ?? rec.split_id ?? 'null');
      s.split_ids[id] = (s.split_ids[id] || 0) + 1;
      if (id === '0' || id === 'null' || id === '') s.no_split++; else s.with_split++;
    }
  }
  s.bibs = bibs.size;
  return s;
}

/** The activity-log lines the dashboard shows: pulls, startlist, state, errors, recent non-noise. */
function summariseLog(entries, { recent = 20 } = {}) {
  const out = { pulls: [], startlist: null, state: null, errors: [], recent: [] };
  for (const e of entries) {
    if (e.kind === 'pull' && out.pulls.length < 3) out.pulls.push(e);
    if (!out.startlist && /startlist refreshed/.test(e.msg)) out.startlist = e;
    if (!out.state && e.kind === 'state') out.state = e;
    if (e.kind === 'error' && out.errors.length < 5) out.errors.push(e);
    if (!['push', 'notify'].includes(e.kind) && out.recent.length < recent) out.recent.push(e);
  }
  return out;
}

module.exports = { summarisePushes, summariseLog };
