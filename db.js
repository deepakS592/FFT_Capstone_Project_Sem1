const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: process.env.PGSSLMODE === 'disable' ? false : undefined,
});

pool.on('error', (error) => {
  console.error('Unexpected idle PostgreSQL client error:', error.message);
});

async function query(text, values) {
  return pool.query(text, values);
}

async function closeDatabase() {
  await pool.end();
}

module.exports = { pool, query, closeDatabase };
