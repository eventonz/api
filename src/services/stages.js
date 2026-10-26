/**
 * Stage races (Epic Series style: teams of two, only the team is timed).
 *
 * Pure helpers shared by routes/v2/stages.js, the CLI and the tests. The
 * worker (../evento-worker) writes v2.stage_results / v2.stage_starts and the
 * Redis read key; this module only shapes rows into the document the app
 * reads:
 *
 *   redis_stages:{v2_race_id}:bib:{raceno} = {
 *     stages: [{ no, name, time, rank, gc_time, gc_rank, cat_rank, gap }],
 *     next_start: { stage_no, name, date, time, chute } | null,
 *     updated: ISO string,
 *   }
 *
 * A stage that only has a start row (not ridden yet) is listed with null
 * times so the app can grey it; next_start is the lowest such stage.
 */

// Mirrors evento-worker SPLITS_TTL_SECS (redis_splits keys live 72 h).
const STAGES_TTL_SECS = 72 * 3600;

const FORMATS = ['evento', 'raceresult_list', 'starts'];

const stagesKey = (raceId, bib) => `redis_stages:${raceId}:bib:${bib}`;

/** Trim and strip leading zeros from a numeric bib ('0042' → '42'); other bibs are only trimmed. */
function normaliseBib(v) {
  const s = v == null ? '' : String(v).trim();
  if (!s) return '';
  if (/^\d+$/.test(s)) return String(Number(s));
  return s;
}

const nullIfEmpty = (v) => (v == null || String(v).trim() === '' ? null : v);
const intOrNull = (v) => {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
const dateStr = (v) => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

/**
 * Lowest stage_no present in `startRows` that has no row in `resultRows`.
 * Returns { stage_no, name, date, time, chute } or null.
 */
function nextStart(resultRows = [], startRows = []) {
  const ridden = new Set(resultRows.map((r) => Number(r.stage_no)));
  const pending = startRows
    .filter((s) => !ridden.has(Number(s.stage_no)))
    .sort((a, b) => Number(a.stage_no) - Number(b.stage_no));
  if (!pending.length) return null;
  const s = pending[0];
  return {
    stage_no: Number(s.stage_no),
    name: nullIfEmpty(s.stage_name),
    date: dateStr(s.start_date),
    time: nullIfEmpty(s.start_time),
    chute: nullIfEmpty(s.chute),
  };
}

/** Rows from v2.stage_results + v2.stage_starts (one bib) → the app document. */
function buildStagesDoc(resultRows = [], startRows = []) {
  const byNo = new Map();
  for (const s of startRows) {
    const no = Number(s.stage_no);
    byNo.set(no, { no, name: nullIfEmpty(s.stage_name), time: null, rank: null, gc_time: null, gc_rank: null, cat_rank: null, gap: null });
  }
  let latest = 0;
  for (const r of resultRows) {
    const no = Number(r.stage_no);
    byNo.set(no, {
      no,
      name: nullIfEmpty(r.stage_name) || byNo.get(no)?.name || null,
      time: nullIfEmpty(r.stage_time),
      rank: intOrNull(r.stage_rank),
      gc_time: nullIfEmpty(r.gc_time),
      gc_rank: intOrNull(r.gc_rank),
      cat_rank: intOrNull(r.cat_rank),
      gap: nullIfEmpty(r.gc_gap),
    });
    const t = r.updated_at ? new Date(r.updated_at).getTime() : 0;
    if (t > latest) latest = t;
  }
  for (const s of startRows) {
    const t = s.updated_at ? new Date(s.updated_at).getTime() : 0;
    if (t > latest) latest = t;
  }
  const stages = [...byNo.values()].sort((a, b) => a.no - b.no);
  return {
    stages,
    next_start: nextStart(resultRows, startRows),
    updated: new Date(latest || Date.now()).toISOString(),
  };
}

/**
 * Validate a POST /v2/stages body. Returns { ok:true, body } with the
 * normalised body, or { ok:false, error }.
 *   { format: 'evento'|'raceresult_list'|'starts', results?: [], starts?: [], race_id? }
 * 'evento'/'raceresult_list' carry `results`; 'starts' carries `starts`.
 */
function validateStagesBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Body must be a JSON object' };
  const format = String(body.format || '').trim();
  if (!FORMATS.includes(format)) return { ok: false, error: `format must be one of ${FORMATS.join(', ')}` };
  const listKey = format === 'starts' ? 'starts' : 'results';
  const list = body[listKey];
  if (!Array.isArray(list)) return { ok: false, error: `${listKey} must be an array for format ${format}` };
  if (!list.length) return { ok: false, error: `${listKey} is empty` };
  if (!list.every((x) => x && typeof x === 'object' && !Array.isArray(x))) return { ok: false, error: `${listKey} items must be objects` };
  const out = { format, [listKey]: list };
  if (body.race_id != null && body.race_id !== '') {
    const id = Number(body.race_id);
    if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'race_id must be a positive integer' };
    out.race_id = id;
  }
  return { ok: true, body: out };
}

module.exports = { STAGES_TTL_SECS, FORMATS, stagesKey, normaliseBib, nextStart, buildStagesDoc, validateStagesBody };
