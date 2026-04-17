const pool = require('../../config/database');

const PAGE_SIZE = 20;

// Epic Series race IDs use direct SQL instead of Postgres functions
const EPIC_SERIES_IDS = new Set([60, 76, 84, 86, 87, 88]);

async function athletesRoutes(app) {

  // ---------------------------------------------------------------------------
  // POST /athletes/:race_id
  // Paginated athlete search
  // Body: { pageNumber: int, searchstring: string }
  // ---------------------------------------------------------------------------
  app.post('/:race_id', {
    schema: {
      params: {
        type: 'object',
        properties: { race_id: { type: 'integer' } },
        required: ['race_id'],
      },
      body: {
        type: 'object',
        properties: {
          pageNumber:   { type: 'integer', minimum: 1, default: 1 },
          searchstring: { type: 'string', default: '' },
        },
        required: ['pageNumber'],
      },
    },
  }, async (request, reply) => {
    const { race_id }                   = request.params;
    const { pageNumber, searchstring }  = request.body;
    const search                        = (searchstring || '').trim();
    const offset                        = (pageNumber - 1) * PAGE_SIZE;
    const isEpic                        = EPIC_SERIES_IDS.has(race_id);

    let rows;

    if (search === '') {
      // -----------------------------------------------------------------------
      // Empty search — return paginated list
      // -----------------------------------------------------------------------
      if (isEpic) {
        ({ rows } = await pool.query(
          `SELECT
             athletes.raceno,
             athletes.name,
             athletes.info,
             athletes.id,
             athletes.athlete_id,
             athletes.country_name  AS country,
             athletes.disRaceNo,
             athletes.extra,
             athletes.contest,
             athletes.profile_image,
             COALESCE(aa.athlete_details, athletes.athlete_details) AS athlete_details,
             COUNT(*) OVER()        AS total_count
           FROM athletes
           LEFT JOIN athlete_additional aa
             ON aa.raceno = athletes.raceno AND aa.race_id = athletes.race_id
           WHERE athletes.race_id = $1
           ORDER BY CAST(athletes.raceno AS INTEGER)
           LIMIT $2 OFFSET $3`,
          [race_id, PAGE_SIZE, offset]
        ));
      } else {
        ({ rows } = await pool.query(
          'SELECT * FROM emptysearch_function($1, $2, $3)',
          [race_id, PAGE_SIZE, offset]
        ));
      }
    } else {
      // -----------------------------------------------------------------------
      // Search string — filter athletes
      // -----------------------------------------------------------------------
      if (isEpic) {
        const term = `%${search}%`;
        ({ rows } = await pool.query(
          `SELECT
             athletes.raceno,
             athletes.name,
             athletes.info,
             athletes.id,
             athletes.athlete_id,
             athletes.country_name  AS country,
             athletes.disRaceNo,
             athletes.extra,
             athletes.contest,
             athletes.profile_image,
             COALESCE(aa.athlete_details, athletes.athlete_details) AS athlete_details,
             COUNT(*) OVER()        AS total_count
           FROM athletes
           LEFT JOIN athlete_additional aa
             ON aa.raceno = athletes.raceno AND aa.race_id = athletes.race_id
           WHERE athletes.race_id = $1
             AND (
               athletes.raceno = $2  OR
               athletes.name   ILIKE $3 OR
               athletes.info   ILIKE $3 OR
               athletes.extra  ILIKE $3
             )
           ORDER BY athletes.name
           LIMIT $4 OFFSET $5`,
          [race_id, search, term, PAGE_SIZE, offset]
        ));
      } else {
        ({ rows } = await pool.query(
          'SELECT * FROM search_athletes($1, $2, $3, $4)',
          [search, race_id, PAGE_SIZE, offset]
        ));
      }
    }

    const totalCount = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;

    // Separate TBC athletes — they always sort last
    const normal = [];
    const tbc    = [];

    for (const row of rows) {
      const athlete = mapAthlete(row);
      if (row.raceno === 'TBC') {
        tbc.push(athlete);
      } else {
        normal.push(athlete);
      }
    }

    // Async: increment search counter — fire and forget, never blocks response
    pool.query(
      'UPDATE races SET athlete_search_count = COALESCE(athlete_search_count, 0) + 1 WHERE id = $1',
      [race_id]
    ).catch(() => {});

    return reply.send({
      athletes: [...normal, ...tbc],
      pagination: {
        currentPage:  pageNumber,
        totalRecords: totalCount,
        totalPages:   Math.ceil(totalCount / PAGE_SIZE),
      },
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH /athletes/:race_id
  // Fetch specific athletes by edition + athlete_id array
  // Body: { edition: string, athletes: [athlete_id, ...] }
  // ---------------------------------------------------------------------------
  app.patch('/:race_id', {
    schema: {
      params: {
        type: 'object',
        properties: { race_id: { type: 'integer' } },
        required: ['race_id'],
      },
      body: {
        type: 'object',
        properties: {
          edition:  { type: 'string' },
          athletes: { type: 'array', items: { type: 'string' } },
        },
        required: ['edition', 'athletes'],
      },
    },
  }, async (request, reply) => {
    const { race_id }            = request.params;
    const { edition, athletes }  = request.body;

    if (!edition.trim()) {
      return reply.badRequest('edition is required');
    }

    if (!athletes.length) {
      return reply.send({ patchedathletes: [] });
    }

    // Build $3, $4, $5... placeholders for the IN clause
    const placeholders = athletes.map((_, i) => `$${i + 3}`).join(', ');

    const { rows } = await pool.query(
      `SELECT
         athletes.raceno,
         athletes.name,
         athletes.info,
         athletes.id,
         athletes.athlete_id,
         athletes.country_name  AS country,
         athletes.disRaceNo,
         athletes.extra,
         athletes.contest,
         athletes.profile_image,
         COALESCE(aa.athlete_details, athletes.athlete_details) AS athlete_details
       FROM athletes
       LEFT JOIN athlete_additional aa
         ON aa.raceno = athletes.raceno AND aa.race_id = athletes.race_id
       WHERE athletes.race_id = $1
         AND athletes.edition  = $2
         AND athletes.athlete_id IN (${placeholders})`,
      [race_id, edition, ...athletes]
    );

    return reply.send({
      patchedathletes: rows.map(mapAthlete),
    });
  });
}

// ---------------------------------------------------------------------------
// Shared athlete row → response object mapper
// Mirrors the CF id/raceno/TBC logic exactly
// ---------------------------------------------------------------------------
function mapAthlete(row) {
  const athlete = {};

  // id: use athlete_id unless it equals raceno, then fall back to raceno
  athlete.id     = row.athlete_id !== row.raceno ? row.athlete_id : row.raceno;
  athlete.name   = row.name;
  athlete.number = row.raceno;
  athlete.disRaceNo = row.disraceno || row.raceno;
  athlete.contest   = row.contest;

  if (row.extra)    athlete.extra         = row.extra;
  if (row.info)     athlete.info          = `${row.info} `;  // CF adds trailing space
  if (row.country)  athlete.country       = row.country;
  if (row.profile_image) athlete.profile_image = row.profile_image;

  if (row.athlete_details) {
    try {
      athlete.athlete_details = typeof row.athlete_details === 'string'
        ? JSON.parse(row.athlete_details)
        : row.athlete_details;
    } catch (_) { /* omit if unparseable */ }
  }

  if (row.raceno === 'TBC') {
    athlete.can_follow = false;
  }

  return athlete;
}

module.exports = athletesRoutes;
