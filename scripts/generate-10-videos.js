/**
 * generate-10-videos.js
 *
 * Génère 10 vidéos d'exercices via Runway ML Gen-4.5 (image-to-video).
 *
 * Lot 1 — 5 exercices ATM prioritaires (IDs : 206, 207, 211, 213, 214)
 * Lot 2 — 5 exercices épaule supplémentaires (IDs : 4, 5, 7, 1, 2)
 *
 * Budget : 500 crédits Runway = 10 vidéos × 50 crédits/vidéo (5 s, 1280×720)
 *
 * Pipeline par vidéo (via services/runway.js) :
 *   1. Récupère image_url depuis la DB
 *   2. Soumet à Runway Gen-4.5 → obtient un task ID
 *   3. Poll jusqu'à SUCCEEDED (~1-3 min)
 *   4. Télécharge le MP4
 *   5. Upload sur R2 → exercise_{id}.mp4
 *   6. Insère dans exercise_videos + has_video=TRUE
 *
 * Usage :
 *   node scripts/generate-10-videos.js
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { Pool } = require('pg');
const runway = require('../services/runway');

// ── Exercise list ──────────────────────────────────────────────────────────────

const EXERCISES = [
  // Lot 1 — ATM (5 exercices prioritaires)
  { id: 211, label: 'ATM - Ouverture mandibulaire contrôlée' },
  { id: 207, label: 'ATM - Diduction mandibulaire (latéralité)' },
  { id: 213, label: 'ATM - Diduction avec résistance latérale' },
  { id: 214, label: 'ATM - Propulsion mandibulaire' },
  { id: 206, label: 'ATM - Ouverture mandibulaire avec résistance' },
  // Lot 2 — Épaule (5 exercices supplémentaires)
  { id: 4,   label: 'Épaule - Étirement capsulaire postérieur' },
  { id: 5,   label: 'Épaule - Renforcement rotation externe' },
  { id: 7,   label: 'Épaule - Élévation latérale avec élastique' },
  { id: 1,   label: 'Épaule - Pendulaire de Codman' },
  { id: 2,   label: 'Épaule - Élévation antérieure passive' },
];

// ── DB connection ──────────────────────────────────────────────────────────────

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Kinévia — Génération de 10 vidéos Runway ML');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Budget : 500 crédits (10 × 50 crédits/vidéo)`);
  console.log(`  Modèle : Gen-4 Turbo, 5 s, 1280×720`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  // Verify env
  if (!process.env.RUNWAY_API_KEY) {
    console.error('❌  RUNWAY_API_KEY manquant — arrêt.');
    process.exit(1);
  }
  if (!process.env.POLSIA_API_KEY && !process.env.POLSIA_API_TOKEN) {
    console.error('❌  POLSIA_API_KEY manquant — arrêt.');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('❌  DATABASE_URL manquant — arrêt.');
    process.exit(1);
  }

  const results = {
    success: [],
    failed:  [],
  };

  for (let i = 0; i < EXERCISES.length; i++) {
    const { id, label } = EXERCISES[i];

    console.log('');
    console.log(`─────────────────────────────────────────────────────────────`);
    console.log(`  [${i + 1}/${EXERCISES.length}] ${label} (ID #${id})`);
    console.log(`─────────────────────────────────────────────────────────────`);

    // Check if already has a video
    try {
      const check = await pool.query(
        'SELECT has_video FROM exercices WHERE id = $1',
        [id]
      );
      if (check.rows.length === 0) {
        console.warn(`  ⚠️  Exercice #${id} introuvable en DB — skipped.`);
        results.failed.push({ id, label, error: 'Exercice introuvable en DB' });
        continue;
      }
      if (check.rows[0].has_video) {
        console.log(`  ⏭️  Exercice #${id} a déjà une vidéo — skipped.`);
        results.success.push({ id, label, skipped: true });
        continue;
      }
    } catch (checkErr) {
      console.error(`  ❌  DB check error: ${checkErr.message}`);
      results.failed.push({ id, label, error: checkErr.message });
      continue;
    }

    try {
      const started = Date.now();
      const result = await runway.generateExerciseVideo(pool, id);
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);

      console.log(`  ✅  Vidéo générée en ${elapsed}s`);
      console.log(`       R2 URL  : ${result.r2Url}`);
      console.log(`       Taille  : ${(result.fileSize / 1024 / 1024).toFixed(1)} MB`);

      results.success.push({ id, label, r2Url: result.r2Url, elapsed });
    } catch (err) {
      console.error(`  ❌  ÉCHEC exercice #${id}: ${err.message}`);
      results.failed.push({ id, label, error: err.message });
      // Continue with next exercise — don't abort the whole run
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  RÉSUMÉ FINAL');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  ✅  Succès  : ${results.success.length}`);
  console.log(`  ❌  Échecs  : ${results.failed.length}`);

  if (results.success.length > 0) {
    console.log('');
    console.log('  Vidéos générées :');
    for (const r of results.success) {
      if (r.skipped) {
        console.log(`    · #${r.id} ${r.label} [déjà existante — skipped]`);
      } else {
        console.log(`    · #${r.id} ${r.label} (${r.elapsed}s) → ${r.r2Url}`);
      }
    }
  }

  if (results.failed.length > 0) {
    console.log('');
    console.log('  Exercices en échec :');
    for (const f of results.failed) {
      console.log(`    · #${f.id} ${f.label}: ${f.error}`);
    }
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  await pool.end();

  process.exit(results.failed.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  pool.end().finally(() => process.exit(2));
});
