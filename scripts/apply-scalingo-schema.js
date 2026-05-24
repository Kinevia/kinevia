// apply-scalingo-schema.js
// Applies schema.sql to a target PostgreSQL database.
// Run locally: DATABASE_URL=REDACTED/dbname node scripts/apply-scalingo-schema.js

'use strict';

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('ERROR: DATABASE_URL is required');
  console.error('Usage: DATABASE_URL=postgresql://... node scripts/apply-scalingo-schema.js');
  process.exit(1);
}

const schemaPath = path.join(__dirname, '..', 'schema.sql');
if (!fs.existsSync(schemaPath)) {
  console.error('ERROR: schema.sql not found at', schemaPath);
  process.exit(1);
}

const sql = fs.readFileSync(schemaPath, 'utf8');

async function apply() {
  const client = new Client({
    connectionString: url,
    ssl: url.includes('localhost') || url.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false },
  });

  try {
    console.log('Connecting to database...');
    await client.connect();

    const { rows } = await client.query('SELECT current_database(), version()');
    console.log(`Connected: ${rows[0].current_database} — ${rows[0].version.split(' ').slice(0, 2).join(' ')}`);

    console.log('Applying schema.sql...');
    await client.query('BEGIN');

    try {
      await client.query(sql);
      await client.query('COMMIT');
      console.log('✅ Schema applied successfully.');
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.message.includes('already exists')) {
        console.error('❌ Schema already partially applied. Drop existing objects first or use IF NOT EXISTS.');
        console.error('   Error:', err.message);
      } else {
        console.error('❌ Schema application failed:', err.message);
      }
      throw err;
    }

    // Verify table count
    const { rows: tables } = await client.query(
      "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
    );
    console.log(`Tables in public schema: ${tables[0].count}`);

    if (parseInt(tables[0].count) < 30) {
      console.warn('⚠️  Expected 35 tables, found', tables[0].count, '— verify schema manually.');
    } else {
      console.log('✅ Table count looks correct.');
    }

  } finally {
    await client.end();
  }
}

apply().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
