/**
 * scripts/backfill-encrypt.js
 *
 * One-off script to encrypt existing plaintext health data.
 * Run this manually if ENCRYPTION_KEY was not set when migration 102 ran,
 * or to verify/repair the encryption state.
 *
 * Usage:
 *   ENCRYPTION_KEY=<64-hex-chars> node scripts/backfill-encrypt.js
 *
 * Safe to run multiple times — skips already-encrypted rows.
 */

require('dotenv').config();
const { Pool } = require('pg');
const crypto = require('crypto');

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is required');
  process.exit(1);
}

if (!process.env.ENCRYPTION_KEY) {
  console.error('ERROR: ENCRYPTION_KEY is required (64 hex chars)');
  process.exit(1);
}

if (process.env.ENCRYPTION_KEY.length !== 64) {
  console.error('ERROR: ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
  process.exit(1);
}

const KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');

function encrypt(value) {
  if (value === null || value === undefined) return null;
  const str = String(value);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function backfill() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── patients ────────────────────────────────────────────────────────────
    {
      const { rows } = await client.query(
        `SELECT id, pathologie, notes FROM patients
         WHERE (pathologie_enc IS NULL AND pathologie IS NOT NULL)
            OR (notes_enc IS NULL AND notes IS NOT NULL)`
      );
      console.log(`patients: ${rows.length} rows to encrypt`);
      for (const row of rows) {
        await client.query(
          `UPDATE patients
           SET pathologie_enc = COALESCE($1, pathologie_enc),
               notes_enc      = COALESCE($2, notes_enc)
           WHERE id = $3`,
          [row.pathologie ? encrypt(row.pathologie) : null,
           row.notes ? encrypt(row.notes) : null,
           row.id]
        );
      }
      console.log(`patients: done`);
    }

    // ── seances ─────────────────────────────────────────────────────────────
    {
      const { rows } = await client.query(
        `SELECT id, douleur_score, notes_patient, difficulte FROM seances
         WHERE (douleur_score_enc IS NULL AND douleur_score IS NOT NULL)
            OR (notes_patient_enc IS NULL AND notes_patient IS NOT NULL)
            OR (difficulte_enc IS NULL AND difficulte IS NOT NULL)`
      );
      console.log(`seances: ${rows.length} rows to encrypt`);
      for (const row of rows) {
        await client.query(
          `UPDATE seances
           SET douleur_score_enc  = COALESCE($1, douleur_score_enc),
               notes_patient_enc  = COALESCE($2, notes_patient_enc),
               difficulte_enc     = COALESCE($3, difficulte_enc)
           WHERE id = $4`,
          [row.douleur_score != null ? encrypt(String(row.douleur_score)) : null,
           row.notes_patient ? encrypt(row.notes_patient) : null,
           row.difficulte ? encrypt(row.difficulte) : null,
           row.id]
        );
      }
      console.log(`seances: done`);
    }

    // ── bilans ───────────────────────────────────────────────────────────────
    {
      const { rows } = await client.query(
        `SELECT id, douleur_initiale, mobilite_initiale, objectifs, notes, observations, mesures FROM bilans
         WHERE (douleur_initiale_enc IS NULL AND douleur_initiale IS NOT NULL)
            OR (mobilite_initiale_enc IS NULL AND mobilite_initiale IS NOT NULL)
            OR (objectifs_enc IS NULL AND objectifs IS NOT NULL)
            OR (notes_enc IS NULL AND notes IS NOT NULL)
            OR (observations_enc IS NULL AND observations IS NOT NULL)
            OR (mesures_enc IS NULL AND mesures IS NOT NULL)`
      );
      console.log(`bilans: ${rows.length} rows to encrypt`);
      for (const row of rows) {
        await client.query(
          `UPDATE bilans
           SET douleur_initiale_enc  = COALESCE($1, douleur_initiale_enc),
               mobilite_initiale_enc = COALESCE($2, mobilite_initiale_enc),
               objectifs_enc         = COALESCE($3, objectifs_enc),
               notes_enc             = COALESCE($4, notes_enc),
               observations_enc      = COALESCE($5, observations_enc),
               mesures_enc           = COALESCE($6, mesures_enc)
           WHERE id = $7`,
          [row.douleur_initiale != null ? encrypt(String(row.douleur_initiale)) : null,
           row.mobilite_initiale ? encrypt(row.mobilite_initiale) : null,
           row.objectifs ? encrypt(row.objectifs) : null,
           row.notes ? encrypt(row.notes) : null,
           row.observations ? encrypt(row.observations) : null,
           row.mesures ? encrypt(row.mesures) : null,
           row.id]
        );
      }
      console.log(`bilans: done`);
    }

    await client.query('COMMIT');
    console.log('\nBackfill complete. All sensitive health data is now encrypted at rest.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Backfill failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

backfill();
