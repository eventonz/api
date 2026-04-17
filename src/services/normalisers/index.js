/**
 * Normaliser Dispatcher — Stage 2 (stub)
 *
 * Routes the raw POST payload to the correct timer-specific normaliser,
 * returning either:
 *   { trackdata }        — single athlete (SportSplits, RR API path, etc.)
 *   { trackdataarray }   — multiple athletes (Ugo's RaceResult array, RaceTec batch)
 *
 * Stage 2 normalisers slot in here. Until each is built, the pass-through
 * default lets you test the pipeline end-to-end with pre-normalised payloads.
 */

function normalise(payload, raceobj) {
  const script = raceobj.timing?.script ?? '';

  switch (script) {
    // Stage 2 — add normaliser imports here as they are built:
    // case 'sportsplits':       return require('./sportsplits').normalise(payload, raceobj);
    // case 'sportsplits_epic':  return require('./sportsplits_epic').normalise(payload, raceobj);
    // case 'raceresult':        return require('./raceresult').normalise(payload, raceobj);
    // case 'racetec':
    // case 'ses':
    // case 'bluechip':          return require('./racetec').normalise(payload, raceobj);
    // case 'therace':
    // case 'timit':
    // case 'chronoconsult':
    // case 'solemotive':
    // case 'secondwind':
    // case 'popupraces':
    // case 'racebase':          return require('./therace').normalise(payload, raceobj);

    default:
      // Pass-through: expects payload to already be normalised trackdata.
      // Handles both single struct and array.
      if (Array.isArray(payload)) {
        return { trackdataarray: payload };
      }
      return { trackdata: payload };
  }
}

module.exports = { normalise };
