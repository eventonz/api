/**
 * Premade per-language wording for SYSTEM pushes (race-day athlete updates).
 * CMS campaigns are translated by hand in the CMS; these are the only strings
 * the server composes itself. Keys → {en, es, de, fr}; `{name}`, `{split}`,
 * `{time}`, `{place}` are substituted. Use with fcm.resolveText / send():
 *
 *   const { title, body } = athleteCopy('split', { name, split, time });
 *   push.send({ audience: 'athlete', ..., title, body })   // maps → per-language fan-out
 */
const STRINGS = {
  started: {
    title: { en: '{name} has started', es: '{name} ha salido', de: '{name} ist gestartet', fr: '{name} est parti(e)' },
    body:  { en: 'Follow their race live.', es: 'Sigue su carrera en directo.', de: 'Verfolge das Rennen live.', fr: 'Suivez sa course en direct.' },
  },
  split: {
    title: { en: '{name} · {split}', es: '{name} · {split}', de: '{name} · {split}', fr: '{name} · {split}' },
    body:  { en: 'Through {split} in {time}{place}.', es: 'Pasó {split} en {time}{place}.', de: 'Durch {split} in {time}{place}.', fr: 'Passage à {split} en {time}{place}.' },
  },
  finished: {
    title: { en: '{name} has finished! 🎉', es: '¡{name} ha terminado! 🎉', de: '{name} ist im Ziel! 🎉', fr: '{name} a terminé ! 🎉' },
    body:  { en: 'Finish time {time}{place}.', es: 'Tiempo final {time}{place}.', de: 'Zielzeit {time}{place}.', fr: 'Temps final {time}{place}.' },
  },
  dnf: {
    title: { en: '{name} · race update', es: '{name} · actualización', de: '{name} · Rennupdate', fr: '{name} · mise à jour' },
    body:  { en: '{name} did not finish the race.', es: '{name} no terminó la carrera.', de: '{name} hat das Rennen nicht beendet.', fr: "{name} n'a pas terminé la course." },
  },
};
const PLACE = { en: ', {n}th overall', es: ', {n}º en la general', de: ', Platz {n} gesamt', fr: ', {n}e au général' };

function ordinalEn(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Build {title:{…}, body:{…}} maps for every language. vars.place = overall rank (number) or absent. */
function athleteCopy(key, vars = {}) {
  const def = STRINGS[key];
  if (!def) throw new Error(`push_strings: unknown key ${key}`);
  const fill = (tpl, lang) => tpl.replace(/\{(\w+)\}/g, (_, k) => {
    if (k === 'place') {
      if (!vars.place) return '';
      return lang === 'en' ? `, ${ordinalEn(Number(vars.place))} overall` : PLACE[lang].replace('{n}', String(vars.place));
    }
    return vars[k] == null ? '' : String(vars[k]);
  });
  const out = { title: {}, body: {} };
  for (const lang of Object.keys(def.title)) {
    out.title[lang] = fill(def.title[lang], lang);
    out.body[lang] = fill(def.body[lang], lang);
  }
  return out;
}

module.exports = { athleteCopy, STRINGS };
