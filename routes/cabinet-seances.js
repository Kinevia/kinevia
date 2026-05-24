/**
 * Owns: /api/patients/:patientId/cabinet-seances — CRUD for kiné in-cabinet session journal.
 * Does NOT own: patient-side seances (seances table), programme logic, bilan logic.
 *
 * All routes require the kiné to be authenticated (requireAuth) AND to own the patient.
 * Patient ownership is verified via a lightweight DB check before every mutation.
 */

const express = require('express');
const router = express.Router({ mergeParams: true }); // mergeParams to get :patientId
const db = require('../db/cabinet-seances');

/**
 * Factory: call with (pool, requireAuth) so this module has no direct Pool reference.
 * Usage in server.js:
 *   app.use('/api/patients/:patientId/cabinet-seances',
 *           require('./routes/cabinet-seances')(pool, requireAuth));
 */
module.exports = function mountCabinetSeances(pool, requireAuth) {

  /**
   * Verify the authenticated kiné owns this patient.
   * Rejects with 403 if not. Used as a middleware in every route.
   */
  async function verifyPatientOwnership(req, res, next) {
    const kineId    = req.session.kineId;
    const patientId = parseInt(req.params.patientId, 10);
    if (!patientId || isNaN(patientId)) return res.status(400).json({ error: 'Patient ID invalide' });

    try {
      const owns = await db.checkPatientOwnership(pool, kineId, patientId);
      if (!owns) return res.status(403).json({ error: 'Accès refusé' });
      req.patientId = patientId;
      req.kineId    = kineId;
      next();
    } catch (err) {
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  /**
   * GET /api/patients/:patientId/cabinet-seances
   * List sessions for this patient, newest first. Paginated.
   * Query params: page (default 1), limit (default 20, max 50).
   */
  router.get('/', requireAuth, verifyPatientOwnership, async (req, res) => {
    try {
      const limit  = Math.min(parseInt(req.query.limit, 10) || 20, 50);
      const page   = Math.max(parseInt(req.query.page,  10) || 1,  1);
      const offset = (page - 1) * limit;

      const [seances, total] = await Promise.all([
        db.listSeancesForPatient(pool, req.kineId, req.patientId, { limit, offset }),
        db.countSeancesForPatient(pool, req.kineId, req.patientId),
      ]);

      res.json({ seances, total, page, limit });
    } catch (err) {
      console.error('[cabinet-seances] GET list error:', err);
      res.status(500).json({ error: 'Impossible de charger les séances' });
    }
  });

  /**
   * POST /api/patients/:patientId/cabinet-seances
   * Create a new session with its exercises.
   * Body: { seance_date, notes?, exercices: [{ exercice_id?, exercice_libre?, charge_kg?, series?, repetitions?, notes? }] }
   */
  router.post('/', requireAuth, verifyPatientOwnership, async (req, res) => {
    try {
      const { seance_date, notes, exercices = [] } = req.body;

      if (!seance_date) return res.status(400).json({ error: 'La date de séance est requise' });

      // Validate date format
      const dateVal = new Date(seance_date);
      if (isNaN(dateVal.getTime())) return res.status(400).json({ error: 'Date invalide' });

      // Validate exercises
      for (const ex of exercices) {
        if (!ex.exercice_id && !ex.exercice_libre) {
          return res.status(400).json({ error: 'Chaque exercice doit avoir un nom ou être sélectionné depuis la bibliothèque' });
        }
        if (ex.charge_kg != null && (isNaN(Number(ex.charge_kg)) || Number(ex.charge_kg) < 0)) {
          return res.status(400).json({ error: 'Charge invalide (doit être un nombre positif)' });
        }
        if (ex.series != null && (isNaN(Number(ex.series)) || Number(ex.series) <= 0)) {
          return res.status(400).json({ error: 'Nombre de séries invalide (doit être > 0)' });
        }
        if (ex.repetitions != null && (isNaN(Number(ex.repetitions)) || Number(ex.repetitions) <= 0)) {
          return res.status(400).json({ error: 'Nombre de répétitions invalide (doit être > 0)' });
        }
      }

      const seance = await db.createSeance(pool, {
        kineId:     req.kineId,
        patientId:  req.patientId,
        seanceDate: seance_date,
        notes:      notes || null,
        exercices,
      });

      res.status(201).json({ seance });
    } catch (err) {
      console.error('[cabinet-seances] POST create error:', err);
      res.status(500).json({ error: 'Impossible de créer la séance' });
    }
  });

  /**
   * GET /api/patients/:patientId/cabinet-seances/progression
   * Returns exercise load/sets/reps history across all sessions for charting.
   * Only exercises with >= 2 recorded data points are included.
   * IMPORTANT: must be registered before /:seanceId to avoid param capture.
   */
  router.get('/progression', requireAuth, verifyPatientOwnership, async (req, res) => {
    try {
      const rows = await db.getProgressionForPatient(pool, req.kineId, req.patientId);
      // Group by exercise name into { exerciceName: [{ date, charge_kg, series, repetitions }] }
      const grouped = {};
      for (const row of rows) {
        if (!grouped[row.exercise_name]) grouped[row.exercise_name] = [];
        grouped[row.exercise_name].push({
          date:         row.seance_date,
          charge_kg:    row.charge_kg != null ? parseFloat(row.charge_kg) : null,
          series:       row.series != null ? parseInt(row.series, 10) : null,
          repetitions:  row.repetitions != null ? parseInt(row.repetitions, 10) : null,
        });
      }
      res.json({ exercises: grouped });
    } catch (err) {
      console.error('[cabinet-seances] GET progression error:', err);
      res.status(500).json({ error: 'Impossible de charger les données de progression' });
    }
  });

  /**
   * GET /api/patients/:patientId/cabinet-seances/:seanceId
   * Get a single session with exercises.
   */
  router.get('/:seanceId', requireAuth, verifyPatientOwnership, async (req, res) => {
    try {
      const seanceId = parseInt(req.params.seanceId, 10);
      if (!seanceId || isNaN(seanceId)) return res.status(400).json({ error: 'ID de séance invalide' });

      const seance = await db.getSeance(pool, req.kineId, seanceId);
      if (!seance) return res.status(404).json({ error: 'Séance non trouvée' });

      res.json({ seance });
    } catch (err) {
      console.error('[cabinet-seances] GET single error:', err);
      res.status(500).json({ error: 'Impossible de charger la séance' });
    }
  });

  /**
   * PUT /api/patients/:patientId/cabinet-seances/:seanceId
   * Update a session (date, notes) and replace all its exercises.
   * Body: { seance_date?, notes?, exercices: [...] }
   */
  router.put('/:seanceId', requireAuth, verifyPatientOwnership, async (req, res) => {
    try {
      const seanceId = parseInt(req.params.seanceId, 10);
      if (!seanceId || isNaN(seanceId)) return res.status(400).json({ error: 'ID de séance invalide' });

      const { seance_date, notes, exercices = [] } = req.body;

      if (seance_date) {
        const dateVal = new Date(seance_date);
        if (isNaN(dateVal.getTime())) return res.status(400).json({ error: 'Date invalide' });
      }

      for (const ex of exercices) {
        if (!ex.exercice_id && !ex.exercice_libre) {
          return res.status(400).json({ error: 'Chaque exercice doit avoir un nom ou être sélectionné depuis la bibliothèque' });
        }
        if (ex.charge_kg != null && (isNaN(Number(ex.charge_kg)) || Number(ex.charge_kg) < 0)) {
          return res.status(400).json({ error: 'Charge invalide (doit être un nombre positif)' });
        }
        if (ex.series != null && (isNaN(Number(ex.series)) || Number(ex.series) <= 0)) {
          return res.status(400).json({ error: 'Nombre de séries invalide' });
        }
        if (ex.repetitions != null && (isNaN(Number(ex.repetitions)) || Number(ex.repetitions) <= 0)) {
          return res.status(400).json({ error: 'Nombre de répétitions invalide' });
        }
      }

      // Verify seance belongs to this kine first
      const existing = await db.getSeance(pool, req.kineId, seanceId);
      if (!existing) return res.status(404).json({ error: 'Séance non trouvée' });

      const [updated] = await Promise.all([
        db.updateSeance(pool, req.kineId, seanceId, { seanceDate: seance_date, notes }),
        db.replaceSeanceExercices(pool, seanceId, exercices),
      ]);

      // Re-fetch full seance with exercises
      const seance = await db.getSeance(pool, req.kineId, seanceId);
      res.json({ seance });
    } catch (err) {
      console.error('[cabinet-seances] PUT update error:', err);
      res.status(500).json({ error: 'Impossible de modifier la séance' });
    }
  });

  /**
   * DELETE /api/patients/:patientId/cabinet-seances/:seanceId
   * Delete a session (exercises cascade).
   */
  router.delete('/:seanceId', requireAuth, verifyPatientOwnership, async (req, res) => {
    try {
      const seanceId = parseInt(req.params.seanceId, 10);
      if (!seanceId || isNaN(seanceId)) return res.status(400).json({ error: 'ID de séance invalide' });

      const deleted = await db.deleteSeance(pool, req.kineId, seanceId);
      if (!deleted) return res.status(404).json({ error: 'Séance non trouvée' });

      res.json({ success: true });
    } catch (err) {
      console.error('[cabinet-seances] DELETE error:', err);
      res.status(500).json({ error: 'Impossible de supprimer la séance' });
    }
  });

  return router;
};
