// server/db.js — PostgreSQL via la lib "pg"
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Helper : query avec paramètres ($1, $2, ...)
async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res;
  } finally {
    client.release();
  }
}

// Helper : renvoie toutes les lignes
async function all(sql, params = []) {
  const res = await query(sql, params);
  return res.rows;
}

// Helper : renvoie la première ligne (ou null)
async function get(sql, params = []) {
  const res = await query(sql, params);
  return res.rows[0] || null;
}

// Helper : INSERT et renvoie la ligne insérée (via RETURNING *)
async function run(sql, params = []) {
  const res = await query(sql, params);
  return res.rows[0] || null;
}

module.exports = { query, all, get, run, pool };
