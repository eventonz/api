/**
 * RaceResult i18n text decoding (port of iOS RRText).
 *
 * Encoded strings look like "{EN:Foo|DE:Bar}" or "{EN:Foo}{DE:Bar}".
 * Picks the requested language, falls back EN → first. "///" → space.
 */

const { str } = require('./util');

function i18n(raw, lang) {
  let s = str(raw);
  if (s.includes('{') && s.includes(':')) {
    const translations = [];
    const re = /\{([A-Za-z]{2}):([^{}]*)\}/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      const code = m[1].toLowerCase();
      const inner = m[2];
      // inner may itself be "Foo|de:Bar" pipe-separated
      const bar = inner.indexOf('|');
      translations.push([code, bar === -1 ? inner : inner.slice(0, bar)]);
      if (bar !== -1) {
        for (const part of inner.slice(bar + 1).split('|')) {
          const colon = part.indexOf(':');
          if (colon === 2) {
            translations.push([part.slice(0, 2).toLowerCase(), part.slice(3)]);
          }
        }
      }
    }
    if (translations.length > 0) {
      const want = str(lang).toLowerCase() === 'cz' ? 'cs' : str(lang).toLowerCase();
      const pick = translations.find(([c]) => c === want)
        || translations.find(([c]) => c === 'en')
        || translations[0];
      s = pick[1];
    }
  }
  return s.split('///').join(' ');
}

/** Group keys arrive as "#1_Marathon" (sort prefix) — strip for display. */
function groupLabel(key, lang) {
  return i18n(str(key).replace(/^#\d+_/, ''), lang);
}

module.exports = { i18n, groupLabel };
