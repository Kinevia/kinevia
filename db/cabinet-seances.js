/**
 * Owns: DB queries for cabinet_seances and cabinet_seance_exercices.
 * Does NOT own: session validation, HTTP auth middleware.
 *
 * All functions accept the pool as first argument so they can be called from
 * any route without creating a second connection pool.
 */

/**
 * Verify a kiné owns a patient. Returns true/false.
 * Used in routes to gate all mutations.
 */
async function checkPatientOwnership(pool, kineId, patientId) {
  const result = await pool.query(
    `SELECT 1 FROM patients WHERE id = $1 AND kine_id = $2`,
    [patientId, kineId]
  );
  return result.rowCount > 0;
}

/**
 * List all cabinet sessions for a patient, newest first.
 * Each row includes the session data + JSON-aggregated exercise entries.
 */
async function listSeancesForPatient(pool, kineId, patientId, { limit = 20, offset = 0 } = {}) {
  const result = await pool.query(
    `SELECT
       cs.id,
       cs.seance_date,
       cs.notes,
       cs.created_at,
       cs.updated_at,
       COALESCE(
         json_agg(
           json_build_object(
             'id',             cse.id,
             'exercice_id',    cse.exercice_id,
             'exercice_nom',   COALESCE(e.nom, cse.exercice_libre),
             'exercice_libre', cse.exercice_libre,
             'charge_kg',      cse.charge_kg,
             'series',         cse.series,
             'repetitions',    cse.repetitions,
             'notes',          cse.notes,
             'ordre',          cse.ordre
           ) ORDER BY cse.ordre ASC, cse.id ASC
         ) FILTER (WHERE cse.id IS NOT NULL),
         '[]'::json
       ) AS exercices
     FROM cabinet_seances cs
     LEFT JOIN cabinet_seance_exercices cse ON cse.seance_id = cs.id
     LEFT JOIN exercices e ON e.id = cse.exercice_id
     WHERE cs.kine_id = $1
       AND cs.patient_id = $2
     GROUP BY cs.id, cs.seance_date, cs.notes, cs.created_at, cs.updated_at
     ORDER BY cs.seance_date DESC, cs.id DESC
     LIMIT $3 OFFSET $4`,
    [kineId, patientId, limit, offset]
  );
  return result.rows;
}

/**
 * Count total cabinet sessions for a patient (for pagination).
 */
async function countSeancesForPatient(pool, kineId, patientId) {
  const result = await pool.query(
    `SELECT COUNT(*) AS total FROM cabinet_seances WHERE kine_id = $1 AND patient_id = $2`,
    [kineId, patientId]
  );
  return parseInt(result.rows[0].total, 10);
}

/**
 * Get a single session with its exercises.
 * Returns null if not found or does not belong to this kine.
 */
async function getSeance(pool, kineId, seanceId) {
  const result = await pool.query(
    `SELECT
       cs.id,
       cs.patient_id,
       cs.seance_date,
       cs.notes,
       cs.created_at,
       cs.updated_at,
       COALESCE(
         json_agg(
           json_build_object(
             'id',             cse.id,
             'exercice_id',    cse.exercice_id,
             'exercice_nom',   COALESCE(e.nom, cse.exercice_libre),
             'exercice_libre', cse.exercice_libre,
             'charge_kg',      cse.charge_kg,
             'series',         cse.series,
             'repetitions',    cse.repetitions,
             'notes',          cse.notes,
             'ordre',          cse.ordre
           ) ORDER BY cse.ordre ASC, cse.id ASC
         ) FILTER (WHERE cse.id IS NOT NULL),
         '[]'::json
       ) AS exercices
     FROM cabinet_seances cs
     LEFT JOIN cabinet_seance_exercices cse ON cse.seance_id = cs.id
     LEFT JOIN exercices e ON e.id = cse.exercice_id
     WHERE cs.kine_id = $1 AND cs.id = $2
     GROUP BY cs.id, cs.patient_id, cs.seance_date, cs.notes, cs.created_at, cs.updated_at`,
    [kineId, seanceId]
  );
  return result.rows[0] || null;
}

/**
 * Create a new cabinet session with its exercise entries in one transaction.
 *
 * exercices: Array of { exercice_id?, exercice_libre?, charge_kg?, series?, repetitions?, notes?, ordre? }
 */
async function createSeance(pool, { kineId, patientId, seanceDate, notes, exercices = [] }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const seanceRes = await client.query(
      `INSERT INTO cabinet_seances (kine_id, patient_id, seance_date, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING id, seance_date, notes, created_at, updated_at`,
      [kineId, patientId, seanceDate, notes || null]
    );
    const seance = seanceRes.rows[0];

    const insertedExercices = [];
    for (let i = 0; i < exercices.length; i++) {
      const ex = exercices[i];
      const exRes = await client.query(
        `INSERT INTO cabinet_seance_exercices
           (seance_id, exercice_id, exercice_libre, charge_kg, series, repetitions, notes, ordre)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, exercice_id, exercice_libre, charge_kg, series, repetitions, notes, ordre`,
        [
          seance.id,
          ex.exercice_id || null,
          ex.exercice_libre || null,
          ex.charge_kg != null ? Number(ex.charge_kg) : null,
          ex.series    != null ? Number(ex.series)    : null,
          ex.repetitions != null ? Number(ex.repetitions) : null,
          ex.notes || null,
          ex.ordre != null ? Number(ex.ordre) : i
        ]
      );
      insertedExercices.push(exRes.rows[0]);
    }

    await client.query('COMMIT');
    return { ...seance, exercices: insertedExercices };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Update a cabinet session header (date + notes).
 * Does NOT update exercises — use replaceSeanceExercices for that.
 */
async function updateSeance(pool, kineId, seanceId, { seanceDate, notes }) {
  const result = await pool.query(
    `UPDATE cabinet_seances
     SET seance_date = COALESCE($3, seance_date),
         notes       = $4,
         updated_at  = NOW()
     WHERE kine_id = $1 AND id = $2
     RETURNING id, seance_date, notes, updated_at`,
    [kineId, seanceId, seanceDate || null, notes || null]
  );
  return result.rows[0] || null;
}

/**
 * Replace all exercise entries for a session (delete all + re-insert).
 * Called after editing a session's exercises.
 */
async function replaceSeanceExercices(pool, seanceId, exercices = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM cabinet_seance_exercices WHERE seance_id = $1`, [seanceId]);

    const inserted = [];
    for (let i = 0; i < exercices.length; i++) {
      const ex = exercices[i];
      const res = await client.query(
        `INSERT INTO cabinet_seance_exercices
           (seance_id, exercice_id, exercice_libre, charge_kg, series, repetitions, notes, ordre)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, exercice_id, exercice_libre, charge_kg, series, repetitions, notes, ordre`,
        [
          seanceId,
          ex.exercice_id || null,
          ex.exercice_libre || null,
          ex.charge_kg    != null ? Number(ex.charge_kg)    : null,
          ex.series       != null ? Number(ex.series)       : null,
          ex.repetitions  != null ? Number(ex.repetitions)  : null,
          ex.notes || null,
          ex.ordre != null ? Number(ex.ordre) : i
        ]
      );
      inserted.push(res.rows[0]);
    }

    await client.query('COMMIT');
    return inserted;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Delete a cabinet session (exercises cascade automatically).
 * Returns true if a row was deleted, false if not found / wrong kine.
 */
async function deleteSeance(pool, kineId, seanceId) {
  const result = await pool.query(
    `DELETE FROM cabinet_seances WHERE kine_id = $1 AND id = $2`,
    [kineId, seanceId]
  );
  return result.rowCount > 0;
}

/**
 * Load progression data for all exercises across all sessions for a patient.
 * Returns one row per (exercise_name, seance_date) with max charge recorded that day.
 * Sorted by exercise name then date ascending — ready to plot.
 *
 * Only exercises with at least 2 data points are returned (otherwise a line chart
 * is meaningless). Free-text and library exercises are unified by display name.
 */
async function getProgressionForPatient(pool, kineId, patientId) {
  const result = await pool.query(
    `WITH exercise_points AS (
       SELECT
         COALESCE(e.nom, cse.exercice_libre)  AS exercise_name,
         cs.seance_date::date                  AS seance_date,
         MAX(cse.charge_kg)                    AS charge_kg,
         MAX(cse.series)                       AS series,
         MAX(cse.repetitions)                  AS repetitions
       FROM cabinet_seances cs
       JOIN cabinet_seance_exercices cse ON cse.seance_id = cs.id
       LEFT JOIN exercices e ON e.id = cse.exercice_id
       WHERE cs.kine_id    = $1
         AND cs.patient_id = $2
         AND (cse.charge_kg IS NOT NULL OR cse.series IS NOT NULL OR cse.repetitions IS NOT NULL)
       GROUP BY exercise_name, cs.seance_date::date
     ),
     exercises_with_multiple_points AS (
       SELECT exercise_name
       FROM exercise_points
       GROUP BY exercise_name
       HAVING COUNT(*) >= 2
     )
     SELECT ep.*
     FROM exercise_points ep
     JOIN exercises_with_multiple_points em ON em.exercise_name = ep.exercise_name
     ORDER BY ep.exercise_name ASC, ep.seance_date ASC`,
    [kineId, patientId]
  );
  return result.rows;
}

module.exports = {
  checkPatientOwnership,
  listSeancesForPatient,
  countSeancesForPatient,
  getSeance,
  createSeance,
  updateSeance,
  replaceSeanceExercices,
  deleteSeance,
  getProgressionForPatient,
};
