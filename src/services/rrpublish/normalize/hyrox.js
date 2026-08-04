/**
 * HYROX canonical-format mapping — port of iOS HyroxSplitsCard.
 *
 * HYROX is a STANDARDISED format — always 8 × 1 km runs alternating with the
 * same 8 stations in the same order. The card renders that canonical sequence
 * and slots the RaceResult rows into it (matched by keyword, runs by order);
 * unmatched steps render as "not yet reached". Extra timing points (Roxzone,
 * Finish…) append at the end in feed order.
 */

const { str } = require('./util');

const STATIONS = [
  { key: 'skierg', label: 'SkiErg', icon: 'figure.skiing.crosscountry' },
  { key: 'push', label: 'Sled Push', icon: 'figure.strengthtraining.traditional' },
  { key: 'pull', label: 'Sled Pull', icon: 'figure.cross.training' },
  { key: 'burpee', label: 'Burpee Broad Jump', icon: 'figure.mixed.cardio' },
  { key: 'row', label: 'RowErg', icon: 'figure.rower' },
  { key: 'farmer', label: 'Farmers Carry', icon: 'dumbbell.fill' },
  { key: 'lunge', label: 'Sandbag Lunges', icon: 'figure.strengthtraining.functional' },
  { key: 'wall', label: 'Wall Balls', icon: 'basketball.fill' },
];

/** A results set "is HYROX" when several hallmark stations appear. */
function isHyrox(rows) {
  const names = rows.map((r) => str(r?.Name).toLowerCase());
  const hallmarks = ['skierg', 'sled', 'burpee', 'wall ball', 'wallball', 'farmer', 'lunge'];
  return hallmarks.filter((s) => names.some((n) => n.includes(s))).length >= 3;
}

/** Sector (segment) time when published, else the running clock at the point. */
function times(row) {
  if (!row) return { main: '–', sub: '' };
  const sector = str(row.Sector);
  const cumulative = ['Time', 'Chip', 'Gun'].map((k) => str(row[k])).find((v) => v !== '') || '';
  if (sector !== '') return { main: sector, sub: cumulative };
  return { main: cumulative === '' ? '–' : cumulative, sub: '' };
}

/** The canonical 16-step sequence with matched rows, plus extras. */
function hyroxSteps(rows) {
  const runRows = [];
  const stationRow = {};
  const extras = [];
  for (const row of rows) {
    const n = str(row?.Name).toLowerCase();
    const station = STATIONS.find((s) => (
      s.key === 'push' || s.key === 'pull'
        ? n.includes('sled') && n.includes(s.key)
        : n.includes(s.key)
    ));
    if (n.includes('roxzone') || n.includes('rox zone')) {
      extras.push({ label: 'Roxzone', icon: 'figure.walk', row });
    } else if (station && !(station.key in stationRow)) {
      stationRow[station.key] = row;
    } else if (n.includes('run')) {
      runRows.push(row);
    } else if (n.includes('finish')) {
      extras.push({ label: 'Finish', icon: 'flag.checkered', row });
    } else {
      extras.push({ label: str(row?.Name), icon: 'flag.fill', row });
    }
  }
  const out = [];
  STATIONS.forEach((station, i) => {
    const runRow = i < runRows.length ? runRows[i] : null;
    const runT = times(runRow);
    out.push({
      kind: 'run', label: `Run ${i + 1}`, icon: 'figure.run',
      reached: runRow != null, main: runT.main, sub: runT.sub,
    });
    const sRow = stationRow[station.key] || null;
    const sT = times(sRow);
    out.push({
      kind: 'station', label: station.label, icon: station.icon,
      reached: sRow != null, main: sT.main, sub: sT.sub,
    });
  });
  for (const e of extras) {
    const t = times(e.row);
    out.push({ kind: 'extra', label: e.label, icon: e.icon, reached: true, main: t.main, sub: t.sub });
  }
  return out;
}

module.exports = { isHyrox, hyroxSteps };
