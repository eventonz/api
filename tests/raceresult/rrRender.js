/**
 * Minimal RaceResult template renderer — TEST HELPER ONLY.
 *
 * Understands just the subset of RaceResult's expression language that
 * services/raceresult/listTemplate.js emits, so tests can render a generated
 * list against a synthetic athlete and assert the result is valid JSON.
 *
 * Supported forms:
 *   [if(1;"[")]                        literal
 *   [if(COND;#BODY)]                   body rendered when COND is true
 *   [if(COND;A)] / [if(COND;A;B)]      value forms
 *   [Name] [Name.Prop] [{LastSplit}.Prop]
 *   [uCase(x)] [CorrectSpelling(x)] [text(x;"lang")] [PushMessage(...)]
 *
 * Conditions: `1`, `<lhs> > 0`, `<lhs> = <rhs>`.
 */

/** Split the template into literal text and bracketed expressions. */
function tokenise(src) {
  const out = [];
  let buf = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch !== '[') { buf += ch; continue; }
    // Find the matching close bracket, respecting nesting and quotes.
    let depth = 0;
    let j = i;
    let inStr = false;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '"') inStr = !inStr;
      else if (!inStr && c === '[') depth++;
      else if (!inStr && c === ']') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) { buf += ch; continue; }
    if (buf) { out.push({ text: buf }); buf = ''; }
    out.push({ expr: src.slice(i + 1, j) });
    i = j;
  }
  if (buf) out.push({ text: buf });
  return out;
}

/** Split `if(...)` arguments on top-level `;`. */
function splitArgs(src) {
  const args = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (const c of src) {
    if (c === '"') { inStr = !inStr; cur += c; continue; }
    if (!inStr && (c === '(' || c === '[')) depth++;
    if (!inStr && (c === ')' || c === ']')) depth--;
    if (!inStr && c === ';' && depth === 0) { args.push(cur); cur = ''; continue; }
    cur += c;
  }
  args.push(cur);
  return args;
}

function renderValue(expr, athlete) {
  const src = expr.trim();

  if (/^".*"$/.test(src)) return src.slice(1, -1);
  if (/^-?\d+$/.test(src)) return src;

  let m = src.match(/^uCase\((.*)\)$/s);
  if (m) return String(render(m[1], athlete)).toUpperCase();

  m = src.match(/^CorrectSpelling\((.*)\)$/s);
  if (m) return render(m[1], athlete);

  m = src.match(/^text\((.*)\)$/s);
  if (m) return render(splitArgs(m[1])[0], athlete);

  m = src.match(/^PushMessage\((.*)\)$/s);
  if (m) return 'push-copy';

  m = src.match(/^if\((.*)\)$/s);
  if (m) {
    const args = splitArgs(m[1]);
    const truthy = evalCond(args[0], athlete);
    const branch = truthy ? args[1] : args[2];
    return branch === undefined ? '' : renderBranch(branch, athlete);
  }

  return lookup(src, athlete);
}

/**
 * A branch is either RaceResult's literal-text form (`#...`), a quoted string,
 * or a template fragment containing bracketed expressions.
 */
function renderBranch(branch, athlete) {
  const b = branch.trim();
  if (b.startsWith('#')) return render(b.slice(1), athlete);
  if (/^".*"$/s.test(b)) return b.slice(1, -1);
  return render(b, athlete);
}

/** Resolve `Name`, `Name.Prop`, `{LastSplit}.Prop`, `Bib`, `ID`, `Contest`. */
function lookup(path, athlete) {
  let src = path.trim();
  if (src === 'Bib') return athlete.bib;
  if (src === 'ID') return athlete.id;
  if (src === 'Contest') return athlete.contest;
  if (src === 'Firstname') return athlete.firstname;
  if (src === 'Lastname') return athlete.lastname;

  if (src.startsWith('{LastSplit}')) {
    src = athlete.lastSplit + src.slice('{LastSplit}'.length);
  }
  const [name, prop = 'time'] = src.split('.');
  const split = athlete.splits[name];
  if (!split) return prop === 'OrderPos' ? 0 : '';
  const value = split[prop === 'time' ? 'time' : prop];
  return value === undefined ? '' : value;
}

/** Evaluate `1`, `A > 0`, `A = B`. */
function evalCond(src, athlete) {
  const cond = src.trim();
  if (cond === '1') return true;

  let m = cond.match(/^(.*?)>\s*0$/s);
  if (m) return Number(render(m[1], athlete) || 0) > 0;

  m = cond.match(/^(.*?)=(.*)$/s);
  if (m) {
    const l = render(m[1], athlete);
    const r = render(m[2], athlete);
    return String(l) === String(r) && String(l) !== '';
  }
  return Boolean(render(cond, athlete));
}

/** Render a template fragment against an athlete. */
function render(src, athlete) {
  return tokenise(String(src))
    .map((t) => (t.text !== undefined ? t.text : renderValue(t.expr, athlete)))
    .join('');
}

/**
 * Render a full list body. The generated body starts with `#`, RaceResult's
 * literal-text marker, which is stripped before rendering.
 */
function renderList(data, athlete) {
  const body = data.startsWith('#') ? data.slice(1) : data;
  return render(body, athlete);
}

/**
 * Build a synthetic athlete.
 * @param {Object} splits  { SplitName: { OrderPos, ID, ...fields } }
 */
function athlete({ bib = 101, id = 4711, contest = 1, splits = {}, lastSplit = '' }) {
  const filled = {};
  for (const [name, s] of Object.entries(splits)) {
    filled[name] = {
      OrderPos: 0, ID: 0, Label: name, time: '00:10:00',
      ToD: '09:10:00', Gun: '00:10:00', Chip: '00:09:59',
      Overall: 0, Gender: 0, AgeGroup: 0, Pace: '4:00', Speed: '15.0',
      Predicted: '00:40:00', 'Predicted.ToD': '09:40:00',
      ...s,
    };
  }
  return {
    bib, id, contest, firstname: 'Ada', lastname: 'Lovelace',
    splits: filled,
    lastSplit: lastSplit || Object.keys(filled)[0] || '',
  };
}

module.exports = { renderList, render, athlete };
