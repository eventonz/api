/**
 * Generate a new API key and insert it into the database.
 *
 * Usage:
 *   node scripts/generate-key.js "Evento iOS App"
 *   node scripts/generate-key.js "Evento Android App" --app-id 7
 */
require('dotenv').config();
const crypto = require('crypto');
const pool   = require('../src/config/database');

async function generate() {
  const name  = process.argv[2];
  const appId = process.argv.includes('--app-id')
    ? process.argv[process.argv.indexOf('--app-id') + 1]
    : null;

  if (!name) {
    console.error('Usage: node scripts/generate-key.js "<name>" [--app-id <id>]');
    process.exit(1);
  }

  const token   = crypto.randomBytes(32).toString('hex'); // 64-char hex token
  const keyHash = crypto.createHash('sha256').update(token).digest('hex');

  await pool.query(
    `INSERT INTO api_keys (name, key_hash, app_id) VALUES ($1, $2, $3)`,
    [name, keyHash, appId || null]
  );

  console.log('\n--- API Key Generated ---');
  console.log(`Name:   ${name}`);
  if (appId) console.log(`App ID: ${appId}`);
  console.log(`Token:  ${token}`);
  console.log('\nAdd this to your mobile app as the Bearer token.');
  console.log('It is NOT stored in the database — only a hash is kept. Save it now.\n');

  await pool.end();
}

generate().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
