/**
 * Owns: /api/admin/export-db — full database export endpoint.
 * Does NOT own: auth middleware (passed via requireAdmin), pool management.
 *
 * Auth: requireAdmin session check + ADMIN_EXPORT_TOKEN env var fallback.
 * Exports all 35 tables as streaming JSON with schema metadata.
 * Encrypted columns are exported as raw ciphertext — encryption intact.
 * Endpoint is TEMPORARY — remove after Scalingo migration completes.
 *
 * Usage: app.use('/api/admin', require('./routes/admin-export')(pool, requireAdmin));
 */

const express = require('express');
const { Transform } = require('stream');
const { fetchAllTables, getTableNames } = require('../db/admin-export');

module.exports = function mountAdminExport(pool, requireAdmin) {
  const router = express.Router();

  // POST /api/admin/export-db — download full DB export as JSON
  router.get('/export-db', requireAdmin, async (req, res) => {
    // Token override: ADMIN_EXPORT_TOKEN env var enables non-session auth
    if (process.env.ADMIN_EXPORT_TOKEN) {
      const headerToken = req.headers['x-admin-export-token'];
      if (headerToken && headerToken === process.env.ADMIN_EXPORT_TOKEN) {
        // Token auth accepted — skip session check for programmatic access
      } else if (!req.session.kineId) {
        return res.status(401).json({ error: 'Non authentifié' });
      }
    } else if (!req.session.kineId) {
      return res.status(401).json({ error: 'Non authentifié' });
    }

    const startTime = Date.now();
    const exportToken = `export_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    console.log(`[export] Starting DB export — token=${exportToken} ip=${req.ip} ua="${req.headers['user-agent'] || 'unknown'}"`);

    try {
      const tables = await fetchAllTables(pool);
      const tableCount = tables.length;
      const totalRows = tables.reduce((acc, t) => acc + t.rows.length, 0);

      // Content-Type: application/json so the browser renders it as downloadable
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="kinevia-export-${exportToken}.json"`);
      res.setHeader('Transfer-Encoding', 'chunked');
      // Prevent proxies from buffering
      res.setHeader('X-Accel-Buffering', 'no');

      // Start JSON object: metadata + tables array
      const openMeta = {
        exported_at: new Date().toISOString(),
        exported_by: req.session.kineId || 'token_auth',
        export_token: exportToken,
        table_count: tableCount,
        total_rows: totalRows,
        tables: [],
      };

      res.write('{\n');
      res.write(`  "exported_at": "${openMeta.exported_at}",\n`);
      res.write(`  "export_token": "${exportToken}",\n`);
      res.write(`  "table_count": ${tableCount},\n`);
      res.write(`  "total_rows": ${totalRows},\n`);
      res.write(`  "tables": [\n`);

      // Stream each table as a JSON object
      for (let i = 0; i < tables.length; i++) {
        const { table, columns, rows } = tables[i];
        const tableObj = {
          table,
          columns: columns.map(c => ({
            name: c.column_name,
            data_type: c.data_type,
            nullable: c.is_nullable === 'YES',
            default: c.column_default,
          })),
          row_count: rows.length,
          rows: rows.map(row => sanitizeRow(row)),
        };

        const json = JSON.stringify(tableObj, null, 2);
        // Indent each line by 2 spaces to maintain valid JSON
        const indented = json.split('\n').map((l, idx) => idx === 0 ? `    ${l}` : `      ${l}`).join('\n');

        res.write(indented);
        if (i < tables.length - 1) res.write(',');
        res.write('\n');

        console.log(`[export] ${exportToken} table=${table} rows=${rows.length}`);
      }

      res.write('  ]\n');
      res.write('}\n');
      res.end();

      const elapsed = Date.now() - startTime;
      console.log(`[export] Completed — token=${exportToken} tables=${tableCount} rows=${totalRows} elapsed=${elapsed}ms`);

    } catch (err) {
      console.error(`[export] FAILED token=${exportToken}: ${err.message}`);
      // If headers not yet sent, send error JSON
      if (!res.headersSent) {
        res.status(500).json({ error: 'Erreur export', detail: err.message });
      } else {
        res.end(); // Already streaming — abort
      }
    }
  });

  // GET /api/admin/export-db/schema — quick schema check without data
  router.get('/export-db/schema', requireAdmin, async (req, res) => {
    try {
      const tables = await Promise.all(getTableNames().map(async (table) => {
        const cols = await pool.query(`
          SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
          ORDER BY ordinal_position
        `, [table]);
        const count = await pool.query(`SELECT COUNT(*) AS cnt FROM ${table}`);
        return {
          table,
          columns: cols.rows,
          row_count: parseInt(count.rows[0].cnt, 10),
        };
      }));
      res.json({ tables, exported_at: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};

/**
 * Recursively walk an object/array and replace BigInt values with safe numbers.
 * PostgreSQL BIGINT columns map to BigInt in JS — JSON.stringify chokes on them.
 */
function sanitizeRow(row) {
  if (row === null) return null;
  if (typeof row !== 'object') return row;
  if (Array.isArray(row)) {
    return row.map(sanitizeRow);
  }
  const out = {};
  for (const [key, val] of Object.entries(row)) {
    if (typeof val === 'bigint') {
      // Safe integer range — keep as number; otherwise stringify
      out[key] = val <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(val) : String(val);
    } else if (val && typeof val === 'object' && val.constructor && val.constructor.name === 'Object') {
      out[key] = sanitizeRow(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}