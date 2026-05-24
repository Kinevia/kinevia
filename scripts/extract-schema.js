/**
 * Extract PostgreSQL schema (DDL only, no data) from a Neon DB.
 * Outputs schema.sql at repo root.
 */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Load .env manually (pg client won't auto-load it)
const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
for (const line of envContent.split('\n')) {
  const [key, ...rest] = line.split('=');
  if (key && rest.length) {
    process.env[key.trim()] = rest.join('=').trim();
  }
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function extractSchema() {
  const client = await pool.connect();

  try {
    const output = [];

    // 1. Header
    output.push('-- ============================================================');
    output.push('-- Kinévia PostgreSQL Schema — extracted from Neon');
    output.push('-- Generated: ' + new Date().toISOString());
    output.push('-- ============================================================');
    output.push('');

    // 2. Extensions
    const extRes = await client.query(`
      SELECT extname, extversion
      FROM pg_extension
      WHERE extname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY extname
    `);
    for (const ext of extRes.rows) {
      output.push(`CREATE EXTENSION IF NOT EXISTS "${ext.extname}";`);
    }
    if (extRes.rows.length) output.push('');

    // 3. ENUM types
    const enumRes = await client.query(`
      SELECT n.nspname, t.typname, string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) as labels
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
      GROUP BY n.nspname, t.typname
      ORDER BY t.typname
    `);
    for (const row of enumRes.rows) {
      output.push(`CREATE TYPE "${row.typname}" AS ENUM (${row.labels.split(', ').map(v => `'${v}'`).join(', ')});`);
    }
    if (enumRes.rows.length) output.push('');

    // 4. Get all tables in public schema
    const tablesRes = await client.query(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);
    const tables = tablesRes.rows.map(r => r.tablename);

    output.push('-- ============================================================');
    output.push('-- TABLES');
    output.push('-- ============================================================');
    output.push('');

    for (const table of tables) {
      // CREATE TABLE
      const colsRes = await client.query(`
        SELECT
          a.attname,
          pg_catalog.format_type(a.atttypid, a.atttypmod) as col_type,
          (SELECT 't' FROM pg_index WHERE indrelid = a.attrelid AND indrelid = a.attrelid AND a.attnum = ANY(procs) AND indisprimary) as is_primary,
          a.attnotnull,
          a.attdefault,
          col_description(a.attrelid, a.attnum) as comment
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
      `, [table]);

      const pkCols = colsRes.rows.filter(r => r.is_primary === 't').map(r => r.attname);

      output.push(`CREATE TABLE "${table}" (`);

      const colDefs = [];
      for (const col of colsRes.rows) {
        let def = `  "${col.attname}" ${col.col_type}`;
        if (col.attnotnull) def += ' NOT NULL';
        if (col.attdefault) def += ` DEFAULT ${col.attdefault}`;
        colDefs.push(def);
      }

      // Primary key
      if (pkCols.length > 0) {
        colDefs.push(`  PRIMARY KEY (${pkCols.map(c => `"${c}"`).join(', ')})`);
      }

      output.push(colDefs.join(',\n'));
      output.push(');');
      output.push('');
    }

    // 5. Constraints (foreign keys, unique, check)
    output.push('-- ============================================================');
    output.push('-- CONSTRAINTS (FK, UNIQUE, CHECK)');
    output.push('-- ============================================================');
    output.push('');

    const conRes = await client.query(`
      SELECT
        conname,
        contype,
        conrelid::regclass as tablename,
        pg_get_constraintdef(oid) as def
      FROM pg_constraint
      WHERE conrelid::regclass::text IN (${tables.map((_, i) => `$${i+1}::regclass`).join(', ')})
      AND contype IN ('f', 'u', 'c', 'x')
      ORDER BY conrelid, conname
    `, tables);

    for (const con of conRes.rows) {
      output.push(`ALTER TABLE "${con.tablename}" ADD CONSTRAINT "${con.conname}" ${con.def};`);
    }
    if (conRes.rows.length) output.push('');

    // 6. Indexes
    output.push('-- ============================================================');
    output.push('-- INDEXES');
    output.push('-- ============================================================');
    output.push('');

    const idxRes = await client.query(`
      SELECT
        schemaname,
        tablename,
        indexname,
        indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
      AND NOT indexname LIKE '%_pkey'
      AND NOT indexname LIKE '%_uuid'
      ORDER BY tablename, indexname
    `);

    for (const idx of idxRes.rows) {
      output.push(`${idx.indexdef};`);
    }
    if (idxRes.rows.length) output.push('');

    // 7. Sequences
    output.push('-- ============================================================');
    output.push('-- SEQUENCES');
    output.push('-- ============================================================');
    output.push('');

    const seqRes = await client.query(`
      SELECT sequence_name, start_value, minimum_value, maximum_value, increment_by, cycle
      FROM information_schema.sequences
      WHERE sequence_schema = 'public'
      ORDER BY sequence_name
    `);

    for (const seq of seqRes.rows) {
      output.push(`CREATE SEQUENCE "${seq.sequence_name}" START ${seq.start_value} INCREMENT ${seq.increment_by} MINVALUE ${seq.minimum_value} MAXVALUE ${seq.maximum_value}${seq.cycle ? ' CYCLE' : ''};`);
    }
    if (seqRes.rows.length) output.push('');

    const sql = output.join('\n');

    const outPath = path.join(__dirname, '..', 'schema.sql');
    fs.writeFileSync(outPath, sql, 'utf8');
    console.log(`Schema extracted to ${outPath} (${sql.split('\n').length} lines)`);

  } finally {
    client.release();
    await pool.end();
  }
}

extractSchema().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});