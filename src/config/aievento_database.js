/**
 * Second PostgreSQL pool for the `aievento` database.
 *
 * Used by /v1/assistant routes for the Assistant + langchain_pg_embedding
 * (pgvector) tables. Same DO cluster as `evento_pool` but a different
 * database and port.
 *
 * Env vars (fall back to AIEVENTO_* with PG_HOST as the host default):
 *   AIEVENTO_HOST     (default: PG_HOST)
 *   AIEVENTO_PORT     (default: 25060)
 *   AIEVENTO_DATABASE (default: aievento)
 *   AIEVENTO_USER     (default: PG_USER)
 *   AIEVENTO_PASSWORD (default: PG_PASSWORD)
 *   AIEVENTO_SSL      (default: PG_SSL)
 */

const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.AIEVENTO_HOST     || process.env.PG_HOST,
  port:     Number(process.env.AIEVENTO_PORT || 25060),
  database: process.env.AIEVENTO_DATABASE || 'aievento',
  user:     process.env.AIEVENTO_USER     || process.env.PG_USER,
  password: process.env.AIEVENTO_PASSWORD || process.env.PG_PASSWORD,
  ssl:      (process.env.AIEVENTO_SSL ?? process.env.PG_SSL) === 'true'
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('aievento PG pool error:', err.message);
});

module.exports = pool;
