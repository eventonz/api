require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pool = require('./database');
const redis = require('./redis');

async function test() {
  // PostgreSQL
  try {
    const { rows } = await pool.query('SELECT current_database(), current_user, version()');
    console.log('✓ PostgreSQL connected');
    console.log('  database:', rows[0].current_database);
    console.log('  user:    ', rows[0].current_user);
  } catch (err) {
    console.error('✗ PostgreSQL failed:', err.message);
  }

  // Redis
  try {
    await redis.ping();
    console.log('✓ Redis connected');
    const info = await redis.info('server');
    const version = info.match(/redis_version:(.+)/)?.[1]?.trim();
    if (version) console.log('  version:', version);
  } catch (err) {
    console.error('✗ Redis failed:', err.message);
  }

  await pool.end();
  redis.disconnect();
}

test();
