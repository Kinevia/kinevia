/**
 * Owns: database export queries for the admin export endpoint.
 * Does NOT own: auth, file serving, encryption key management.
 *
 * All 35 public tables are exported as JSON with full schema metadata.
 * Encrypted columns (patients, bilans, seances via *_enc suffix) are exported
 * as raw ciphertext — encryption stays intact during export.
 *
 * Usage: const exp = require('./db/admin-export'); exp.fetchAllTables(pool);
 */

const TABLES = [
  '_migrations',
  'beta_signups',
  'bilans',
  'clinical_test_items',
  'clinical_tests',
  'conversations',
  'cookie_consents',
  'email_verification_tokens',
  'exercise_videos',
  'exercices',
  'health_access_logs',
  'kine_notification_prefs',
  'kine_subscription_events',
  'kines',
  'magic_link_tokens',
  'messages',
  'password_reset_tokens',
  'patient_email_prefs',
  'patient_health_consents',
  'patient_notification_prefs',
  'patient_push_subscriptions',
  'patients',
  'programme_exercices',
  'programme_rappels',
  'programmes',
  'protocols',
  'publications',
  'push_subscriptions',
  'rappel_logs',
  'seance_exercices',
  'seances',
  'session',
  'users',
  'video_feedback',
  'zones_corporelles',
];

/**
 * Fetches all table data + schema metadata.
 * Returns array of { table, columns, rows } objects in insertion order.
 */
async function fetchAllTables(pool) {
  const results = [];
  for (const table of TABLES) {
    const [schemaRows, dataRows] = await Promise.all([
      pool.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `, [table]),
      pool.query(`SELECT * FROM ${table}`),
    ]);
    results.push({
      table,
      columns: schemaRows.rows,
      rows: dataRows.rows,
    });
  }
  return results;
}

/**
 * Returns the full ordered list of table names exported.
 */
function getTableNames() {
  return [...TABLES];
}

module.exports = { fetchAllTables, getTableNames, TABLES };