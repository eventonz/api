/**
 * Splits orchestrator.
 * Mirrors the dispatch logic in API/api/v4/modules/splits.cfm:
 *   1. Load raceobj
 *   2. Resolve contestDisplaySettings from url.contest
 *   3. Run the transformer keyed on raceobj.timing.script
 *      (currently sportsplits only — others to be ported one at a time)
 *   4. If transformer resolved a contest_id, re-fetch display_settings
 *   5. Build the header (summary + live race clock + external links)
 *   6. Render via athleteDetailV2 page builder
 */

const { raceconfigByRaceId } = require('../raceConfig');
const sportsplits = require('./transformers/sportsplits');
const { buildHeader } = require('./buildHeader');
const athleteDetailV2 = require('./athleteDetailV2');

function findContestDisplaySettings(raceobj, contestId) {
  if (!contestId || !Array.isArray(raceobj.events)) return {};
  const evt = raceobj.events.find((e) => String(e.contest_id) === String(contestId));
  return evt?.display_settings ? { ...evt.display_settings } : {};
}

async function buildSplits({ raceId, bib, athleteId, contest }) {
  const raceobj = await raceconfigByRaceId(raceId);
  if (!raceobj) {
    return { status: 404, body: { error: 'Race not found' } };
  }

  let contestId = contest;
  let displaySettings = findContestDisplaySettings(raceobj, contestId);

  // ---- Transformer dispatch ----
  let livetiming = {};
  let contestType = null;

  switch (raceobj.timing?.script) {
    case 'sportsplits': {
      const result = await sportsplits.transform(raceobj, {
        bib, athleteId, raceId,
      });
      livetiming  = result.livetiming;
      contestType = result.contestType;
      break;
    }
    default:
      contestType = 'nodata';
      break;
  }

  // If transformer resolved the actual contest, re-pull display_settings
  if (livetiming.contest_id && livetiming.contest_id !== 99
      && String(livetiming.contest_id) !== String(contestId)) {
    contestId = livetiming.contest_id;
    displaySettings = findContestDisplaySettings(raceobj, contestId);
  }

  // ---- Build header (mutates livetiming, merges splits from config) ----
  const header = buildHeader(livetiming, raceobj, { bib, athleteId, contest: contestId });

  // ---- Render page ----
  const results = athleteDetailV2.build(livetiming, raceobj, displaySettings, header);

  return { status: 200, body: results };
}

module.exports = { buildSplits };
