/**
 * Owns: /api/admin/schema-export — full DB schema export as downloadable SQL.
 * Does NOT own: auth middleware (passed via requireAdmin), pool management.
 *
 * Auth: SCHEMA_EXPORT_KEY query param fallback (no session required).
 * Reconstructs schema via information_schema queries — NOT pg_dump.
 * Endpoint is TEMPORARY — remove after Scalingo migration completes.
 *
 * Usage: app.use('/api/admin', require('./routes/admin-schema-export')(pool, requireAdmin));
 */

const express = require('express');

module.exports = function mountAdminSchemaExport(pool, requireAdmin) {
  const router = express.Router();

  // GET /api/admin/schema-export — download full schema as schema.sql
  router.get('/schema-export', async (req, res) => {
    // Key-based auth: SCHEMA_EXPORT_KEY query param overrides session
    const providedKey = req.query.key;
    const expectedKey = process.env.SCHEMA_EXPORT_KEY;

    if (expectedKey && providedKey !== expectedKey) {
      // If key is configured, reject invalid/missing key
      return res.status(403).json({ error: 'Clé invalide ou manquante' });
    }

    if (!expectedKey && !req.session.kineId) {
      // If no key configured, fall back to session auth
      return res.status(401).json({ error: 'Non authentifié' });
    }

    const startTime = Date.now();
    console.log(`[schema-export] Starting schema export ip=${req.ip}`);

    try {
      const schemaSql = await buildSchema(pool);

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename=schema.sql');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('X-Accel-Buffering', 'no');

      res.write(schemaSql);
      res.end();

      const elapsed = Date.now() - startTime;
      console.log(`[schema-export] Completed elapsed=${elapsed}ms size=${schemaSql.length}`);

    } catch (err) {
      console.error(`[schema-export] FAILED: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Erreur export schema', detail: err.message });
      } else {
        res.end();
      }
    }
  });

  return router;
};

// Build full CREATE TABLE + constraints + indexes + sequences + enums SQL
async function buildSchema(pool) {
  const lines = [];

  // 1. Header
  lines.push('-- ============================================================');
  lines.push('-- Kinévia Database Schema');
  lines.push(`-- Generated: ${new Date().toISOString()}`);
  lines.push('-- ============================================================');
  lines.push('');

  // 2. Enums (must be created before tables that use them)
  const enums = await pool.query(`
    SELECT t.typname AS enum_name, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    JOIN pg_namespace n ON t.typnamespace = n.oid
    WHERE n.nspname = 'public'
    GROUP BY t.typname
    ORDER BY t.typname
  `);

  if (enums.rows.length > 0) {
    lines.push('-- ── ENUMS ─────────────────────────────────────────────────────');
    for (const row of enums.rows) {
      const labels = row.labels.filter(Boolean).map(l => `'${l}'`).join(', ');
      lines.push(`CREATE TYPE ${row.enum_name} AS ENUM (${labels});`);
    }
    lines.push('');
  }

  // 3. Sequences
  const seqs = await pool.query(`
    SELECT s.relname AS sequence_name
    FROM pg_class s
    JOIN pg_namespace n ON s.relnamespace = n.oid
    WHERE s.relkind = 'S' AND n.nspname = 'public'
    ORDER BY s.relname
  `);

  if (seqs.rows.length > 0) {
    lines.push('-- ── SEQUENCES ─────────────────────────────────────────────────');
    for (const row of seqs.rows) {
      lines.push(`CREATE SEQUENCE ${row.sequence_name};`);
    }
    lines.push('');
  }

  // 4. Tables
  const tables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);

  for (const tbl of tables.rows) {
    lines.push(`-- ── TABLE: ${tbl.table_name} ──────────────────────────────────────────`);

    // Columns
    const cols = await pool.query(`
      SELECT
        column_name,
        data_type,
        character_maximum_length,
        numeric_precision,
        numeric_scale,
        is_nullable,
        column_default,
        is_generated
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `, [tbl.table_name]);

    const colDefs = [];
    for (const c of cols.rows) {
      let def = `  ${c.column_name} ${formatType(c)}`;

      if (c.is_nullable === 'NO') {
        def += ' NOT NULL';
      }

      if (c.column_default && c.is_generated !== 'ALWAYS') {
        def += ` DEFAULT ${c.column_default}`;
      }

      colDefs.push(def);
    }

    // Primary key
    const pk = await pool.query(`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.table_name = $1
        AND tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = 'public'
      ORDER BY kcu.ordinal_position
    `, [tbl.table_name]);

    if (pk.rows.length > 0) {
      colDefs.push(`  PRIMARY KEY (${pk.rows.map(r => r.column_name).join(', ')})`);
    }

    lines.push(`CREATE TABLE ${tbl.table_name} (`);
    lines.push(colDefs.join(',\n'));
    lines.push(');');
    lines.push('');

    // Foreign keys
    const fks = await pool.query(`
      SELECT
        tc.constraint_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.table_name = $1
        AND tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
    `, [tbl.table_name]);

    for (const fk of fks.rows) {
      lines.push(
        `ALTER TABLE ${tbl.table_name} ADD CONSTRAINT ${fk.constraint_name} ` +
        `FOREIGN KEY (${fk.column_name}) REFERENCES ${fk.foreign_table_name}(${fk.foreign_column_name});`
      );
    }

    // Unique constraints
    const uniqs = await pool.query(`
      SELECT tc.constraint_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.table_name = $1
        AND tc.constraint_type = 'UNIQUE'
        AND tc.table_schema = 'public'
      ORDER BY tc.constraint_name, kcu.ordinal_position
    `, [tbl.table_name]);

    // Group unique constraints by name
    const uniqMap = {};
    for (const u of uniqs.rows) {
      if (!uniqMap[u.constraint_name]) uniqMap[u.constraint_name] = [];
      uniqMap[u.constraint_name].push(u.column_name);
    }
    for (const [name, cols_list] of Object.entries(uniqMap)) {
      lines.push(`ALTER TABLE ${tbl.table_name} ADD CONSTRAINT ${name} UNIQUE (${cols_list.join(', ')});`);
    }

    // Check constraints
    const checks = await pool.query(`
      SELECT cc.constraint_name, cc.check_clause
      FROM information_schema.table_constraints tc
      JOIN information_schema.check_constraints cc
        ON tc.constraint_name = cc.constraint_name AND tc.table_schema = cc.constraint_schema
      WHERE tc.table_name = $1 AND tc.constraint_type = 'CHECK' AND tc.table_schema = 'public'
    `, [tbl.table_name]);

    for (const ch of checks.rows) {
      lines.push(`ALTER TABLE ${tbl.table_name} ADD CONSTRAINT ${ch.constraint_name} CHECK (${ch.check_clause});`);
    }

    // Indexes (excluding those created by PK/UNIQUE — handled above)
    const pkUniqNames = new Set([
      ...pk.rows.map(r => r.constraint_name),
      ...Object.keys(uniqMap),
    ]);

    const idxs = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = $1
      ORDER BY indexname
    `, [tbl.table_name]);

    for (const idx of idxs.rows) {
      // Skip auto-created indexes from PK/UNIQUE constraints
      if (pkUniqNames.has(idx.indexname)) continue;
      lines.push(`${idx.indexdef};`);
    }

    lines.push('');
  }

  // 5. Comments (if any stored in pg_description)
  lines.push('-- ============================================================');
  lines.push('-- END OF SCHEMA');
  lines.push('-- ============================================================');

  return lines.join('\n');
}

// Format PostgreSQL column type with precision/length
function formatType(col) {
  const dt = col.data_type.toUpperCase();

  // Map PostgreSQL types to standard SQL type names
  switch (dt) {
    case 'CHARACTER VARYING': return `VARCHAR${col.character_maximum_length ? `(${col.character_maximum_length})` : ''}`;
    case 'CHARACTER': return `CHAR${col.character_maximum_length ? `(${col.character_maximum_length})` : ''}`;
    case 'NUMERIC': return col.numeric_precision
      ? `NUMERIC(${col.numeric_precision},${col.numeric_scale ?? 0})`
      : 'NUMERIC';
    case 'USER-DEFINED': return col.column_default?.includes('enum_') ? dt : dt;
    default: return dt;
  }
}