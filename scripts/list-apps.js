require('dotenv').config();
const pool = require('../src/config/database');

async function listApps() {
  try {
    const { rows } = await pool.query('SELECT id, name FROM apps ORDER BY id LIMIT 10');
    console.log('\nAvailable Apps:');
    console.log('================');
    rows.forEach(app => {
      console.log(`ID: ${app.id} | Name: ${app.name}`);
    });
    console.log(`\nTotal: ${rows.length} apps found\n`);
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

listApps();
