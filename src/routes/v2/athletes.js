const pool = require('../../config/database');

/**
 * POST /v2/athletes/:event_id — live startlist search over v2.athletes for a
 * V2 (block-based) event. Same request/response contract as /v1/athletes/
 * {race_id} so the app's DBAthletesController works unchanged:
 *   body   { pageNumber, searchstring, race? }          (race = v2.races.id filter)
 *   reply  [{ raceno, name, info, athlete_id, contest, profile_image, entry_type,
 *             members[], total_count }]
 * The startlist is loaded/refreshed in the CMS (RR Org API, timit teams, CSV,
 * webhooks) and changes right up to race day — the app searches the DB,
 * never a published snapshot.
 */
const PAGE_SIZE = 20;

async function v2AthleteRoutes(app) {
  app.post('/:event_id', {
    schema: {
      params: { type: 'object', properties: { event_id: { type: 'string' } }, required: ['event_id'] },
      body: { type: 'object', properties: {
        pageNumber: { type: 'integer', minimum: 1, default: 1 },
        searchstring: { type: 'string', default: '' },
        race: { type: 'string' },
      } },
    },
  }, async (request) => {
    const { event_id } = request.params;
    const { pageNumber = 1, searchstring = '', race } = request.body || {};
    const search = String(searchstring).trim();
    const offset = (pageNumber - 1) * PAGE_SIZE;

    // v2.search_athletes (migration 028): bib → "first last" → fuzzy, ranked;
    // rider names inside team entries are searchable. Empty q = bib order.
    const { rows } = await pool.query(
      'SELECT * FROM v2.search_athletes($1, $2, $3, $4, $5)',
      [search, event_id, race && /^\d+$/.test(race) ? Number(race) : null, PAGE_SIZE, offset]
    );

    return rows.map((x) => {
      const members = Array.isArray(x.athlete_details)
        ? x.athlete_details.map((m) => ({ name: m.name || '', bib: m.athletenumber || '', country: m.country || '' }))
        : [];
      // Teams: riders as the info line so a search hit on a rider shows why.
      const info = (x.info || '').trim() || (members.length ? members.map((m) => m.name).filter(Boolean).join(' · ') : '');
      return {
        raceno: x.raceno, name: x.name, info, athlete_id: x.athlete_id, contest: String(x.race_id), race_name: x.race_name,
        // Timing-platform contest id (RR contest) — athlete-page cards target on this.
        contest_id: x.contest == null ? '' : String(x.contest),
        profile_image: x.profile_image, entry_type: x.entry_type, country: x.country, category: x.category,
        gender: x.gender, members, total_count: Number(x.total_count),
      };
    });
  });

  // PATCH /v2/athletes/:event_id — re-validate the app's follow stubs against
  // the live startlist (same contract as v1's PATCH: body {athletes:[ids]} →
  // {patchedathletes:[{id,name,number,profile_image,info}]}). No edition
  // needed: v2 events are already scoped to one edition. profile_image is
  // omitted when unset so the app clears a removed photo.
  app.patch('/:event_id', {
    schema: {
      params: { type: 'object', properties: { event_id: { type: 'string' } }, required: ['event_id'] },
      body: { type: 'object', properties: {
        athletes: { type: 'array', items: { type: 'string' }, maxItems: 200 },
      }, required: ['athletes'] },
    },
  }, async (request) => {
    const { event_id } = request.params;
    const ids = request.body.athletes.map(String).filter(Boolean);
    if (!ids.length) return { patchedathletes: [] };
    const { rows } = await pool.query(
      `SELECT a.athlete_id, a.raceno, a.name, a.info, a.category, a.profile_image, a.athlete_details, a.contest
       FROM v2.athletes a JOIN v2.races r ON r.id = a.race_id
       WHERE r.event_id = $1 AND a.athlete_id = ANY($2::text[])`,
      [event_id, ids]
    );
    return {
      patchedathletes: rows.map((x) => {
        const members = Array.isArray(x.athlete_details) ? x.athlete_details.map((m) => m.name).filter(Boolean) : [];
        const info = (x.info || '').trim() || (x.category || '').trim() || members.join(' · ');
        const out = { id: x.athlete_id, name: x.name, number: x.raceno, info, contest_id: x.contest == null ? '' : String(x.contest) };
        if (x.profile_image) out.profile_image = x.profile_image;
        return out;
      }),
    };
  });
}

module.exports = v2AthleteRoutes;
