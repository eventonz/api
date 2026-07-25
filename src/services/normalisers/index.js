/**
 * Normaliser Dispatcher — Stage 2
 *
 * Routes the raw POST payload to the correct timer-specific normaliser,
 * returning either:
 *   { trackdata }        — single athlete (SportSplits, RR API path, etc.)
 *   { trackdataarray }   — multiple athletes (Ugo's RaceResult array, RaceTec batch)
 *
 * The converter is selected by the INGEST ENDPOINT, mirroring the CF API
 * where /raceresult/{rr_eventid} includes convert_data/raceresult.cfm
 * regardless of the race's timing script. /tracks/race receives
 * pre-normalised Evento-format payloads (pass-through).
 */

const raceresult = require('./raceresult');

function normalise(payload, raceobj, endpoint, raceId) {
  switch (endpoint) {
    case 'tracks/raceresult':
      return raceresult.normalise(payload, raceobj, raceId);

    // Stage 2 — remaining normalisers slot in here as they are ported:
    // case 'tracks/sportsplits': return require('./sportsplits').normalise(payload, raceobj, raceId);
    // case 'tracks/racetec':     return require('./racetec').normalise(payload, raceobj, raceId);

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
