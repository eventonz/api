/**
 * List/contest resolution from a merged RRPublish config
 * (port of iOS RRResultsController resultLists / contestEntries /
 * listDisplayName / currDetailsPath).
 */

const { str, toInt } = require('./util');
const { i18n } = require('./i18n');

/** All list definitions — modern TabConfig.Lists wins over legacy lists. */
function allLists(config) {
  return config?.TabConfig?.Lists || config?.lists || [];
}

/**
 * Viewable lists: Format contains V (on-screen) AND empty Mode (public).
 *
 * Format 'P' WITHOUT 'V' is a print/PDF-only list — RRPublish offers it as a
 * PDF download, not a results table. Rendering one as a tab yields an empty
 * list (e.g. 406086 "Varvtider (PDF)"), so it is excluded here and surfaced
 * separately by pdfLists().
 */
function visibleLists(config) {
  return allLists(config).filter((l) => str(l?.Format).includes('V') && str(l?.Mode) === '');
}

/** Public print-only lists — offered as PDF links, never as result tables. */
function pdfLists(config) {
  return allLists(config).filter((l) => {
    const format = str(l?.Format);
    return format.includes('P') && !format.includes('V') && str(l?.Mode) === '';
  });
}

/** Contest id → display label, deduped in list order. "0" = General. */
function contestEntries(config, lang) {
  const contests = config?.contests || {};
  const seen = new Set();
  const out = [];
  for (const l of visibleLists(config)) {
    const c = str(l?.Contest ?? '0') || '0';
    if (seen.has(c)) continue;
    seen.add(c);
    out.push({ id: c, name: c === '0' ? 'General' : i18n(str(contests[c] ?? c), lang) });
  }
  return out;
}

/** ShowAs wins; strip up to first '|'; trailing literal \n marker stripped. */
function listDisplayName(list, lang) {
  let s = str(list?.ShowAs);
  if (s === '') s = str(list?.Name);
  const pipe = s.indexOf('|');
  if (pipe !== -1) s = s.slice(pipe + 1);
  if (s.endsWith('\\n')) s = s.slice(0, -2);
  return s === '-' ? '' : i18n(s, lang);
}

/** Whether a list definition comes from the modern TabConfig. */
function isTabConfigList(config, list) {
  const lists = config?.TabConfig?.Lists;
  if (!Array.isArray(lists) || list?.ID == null) return false;
  return lists.some((l) => str(l?.ID) === str(list.ID));
}

/**
 * Details URL path for per-athlete calls: TabConfig.Lists[i].Details matched
 * by list ID, else TabConfig.StandardDetails, else the legacy path. (The
 * list's own Details field is a display reference, NOT a URL path.)
 */
function detailsPath(config, list) {
  const tc = config?.TabConfig;
  if (list?.ID != null && Array.isArray(tc?.Lists)) {
    const match = tc.Lists.find((l) => str(l?.ID) === str(list.ID));
    if (typeof match?.Details === 'string' && match.Details !== '') return match.Details;
  }
  if (typeof tc?.StandardDetails === 'string' && tc.StandardDetails !== '') {
    return tc.StandardDetails;
  }
  return 'RRPublish/data';
}

/** Normalized list descriptor for the config response. */
function listEntry(config, list, lang) {
  return {
    id: str(list?.ID),
    name: str(list?.Name),                       // raw — the listname query param
    displayName: listDisplayName(list, lang),
    contest: str(list?.Contest ?? '0') || '0',
    leaderCount: toInt(list?.Leader, 0),
    evento: list?._evento || null,               // CMS override hints, verbatim
  };
}

module.exports = {
  allLists, visibleLists, pdfLists, contestEntries, listDisplayName,
  isTabConfigList, detailsPath, listEntry,
};
