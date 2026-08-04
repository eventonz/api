/** Shared helpers for the RRPublish normalizers. */

/** Swift-style string coercion: null/undefined → ''. */
const str = (v) => (v == null ? '' : `${v}`);

const toInt = (v, dflt = 0) => {
  const n = parseInt(str(v), 10);
  return Number.isNaN(n) ? dflt : n;
};

/**
 * "1:02:33" / "52:10" / "52:10,3" → total seconds, or null when the value
 * isn't purely time-shaped (port of RRSplitTable.parseSeconds).
 */
function parseSeconds(t) {
  const clean = str(t).split(',')[0];
  const rawParts = clean.split(':');
  // Strict integer parts (Swift Int() semantics — "56 min/km" is NOT 56)
  const parts = rawParts
    .map((p) => p.trim())
    .filter((p) => /^\d+$/.test(p))
    .map((p) => parseInt(p, 10));
  if (parts.length === 0 || parts.length !== rawParts.length) return null;
  return parts.reverse().reduce((acc, n, i) => acc + n * 60 ** i, 0);
}

/** Seconds → "m:ss" or "h:mm:ss" (port of RRSplitTable.formatSeconds). */
function formatSeconds(total) {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => `${n}`.padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

module.exports = { str, toInt, parseSeconds, formatSeconds };
