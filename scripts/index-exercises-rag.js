#!/usr/bin/env node
/**
 * scripts/index-exercises-rag.js
 *
 * Indexes the full Kinévia exercise library (324 exercises, 16 zones) into
 * the RAG vector store for semantic search in Chat AI.
 *
 * Each exercise becomes one RAG document (category: 'exercice') with:
 *   - Structured text content optimized for semantic retrieval
 *   - Metadata: exercise_id, zone, muscles
 *
 * Usage:
 *   DATABASE_URL=... OPENAI_BASE_URL=... OPENAI_API_KEY=... node scripts/index-exercises-rag.js
 *
 * Safe to re-run: skips exercises already indexed (checks metadata.exercise_id).
 * Add --force to re-index all (deletes existing, re-embeds from scratch).
 *
 * Estimated time: ~3–5 min for 324 exercises (batched embeddings, 5 concurrent).
 */

require('dotenv').config();

const { Pool } = require('pg');
const { ingestDocument, listDocuments, deleteDocument } = require('../services/ragService');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Zone labels (French, readable for LLM context) ──────────────────────────

const ZONE_LABELS = {
  epaule:                      'Épaule',
  genou:                       'Genou',
  dos:                         'Dos / Rachis lombaire',
  hanche:                      'Hanche',
  cheville:                    'Cheville',
  poignet:                     'Poignet / Main',
  cou:                         'Cou / Cervical',
  pied:                        'Pied',
  coude:                       'Coude',
  abdominaux:                  'Abdominaux',
  atm:                         'ATM (Articulation Temporo-Mandibulaire)',
  rachis_thoracique:           'Rachis thoracique',
  geriatrie:                   'Gériatrie — Équilibre & Mobilité',
  geriatrie_renforcement:      'Gériatrie — Renforcement',
  muscles_profonds_gainage:    'Muscles profonds — Gainage',
  muscles_profonds_plancher:   'Plancher pelvien — Muscles profonds',
};

// ── Build document text from exercise fields ─────────────────────────────────

/**
 * Formats one exercise row into a natural-language document for embedding.
 * Designed so that queries like "renforcement quadriceps", "étirement ischio",
 * "exercice épaule rotation externe" return relevant results.
 */
function buildExerciseContent(ex) {
  const zone = ZONE_LABELS[ex.zone_corporelle] || ex.zone_corporelle;
  const muscles = ex.muscles && ex.muscles.trim()
    ? ex.muscles.trim()
    : 'non spécifiés';
  const reps = ex.repetitions_recommandees || '10';
  const series = ex.series_recommandees || 3;

  return `# ${ex.nom}

**Zone corporelle :** ${zone}
**Muscles ciblés :** ${muscles}
**Dosage recommandé :** ${series} séries × ${reps} répétitions

## Description et consignes

${ex.description || 'Aucune description disponible.'}
`.trim();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const forceReindex = process.argv.includes('--force');

  console.log('🏃 Exercise RAG Indexer — Kinévia');
  console.log(`   Mode: ${forceReindex ? 'FORCE (re-index all)' : 'incremental (skip already indexed)'}`);
  console.log('');

  // 1. Fetch all library exercises (non-custom)
  const { rows: exercises } = await pool.query(`
    SELECT
      id,
      nom,
      zone_corporelle,
      description,
      muscles,
      series_recommandees,
      repetitions_recommandees
    FROM exercices
    WHERE est_personnalise = false
    ORDER BY zone_corporelle, nom
  `);

  console.log(`📚 Found ${exercises.length} exercises in library`);

  // 2. Fetch already-indexed exercise IDs
  let alreadyIndexedIds = new Set();

  if (!forceReindex) {
    const existing = await listDocuments();
    const exerciceDocs = existing.filter(d => d.category === 'exercice');

    for (const doc of exerciceDocs) {
      const meta = doc.metadata || {};
      if (meta.exercise_id) {
        alreadyIndexedIds.add(meta.exercise_id);
      }
    }
    console.log(`✅ Already indexed: ${alreadyIndexedIds.size} exercises`);
  } else {
    // Force mode: delete all existing exercice documents first
    const existing = await listDocuments();
    const exerciceDocs = existing.filter(d => d.category === 'exercice');
    if (exerciceDocs.length > 0) {
      console.log(`🗑️  Deleting ${exerciceDocs.length} existing exercise documents...`);
      for (const doc of exerciceDocs) {
        await deleteDocument(doc.id);
      }
    }
  }

  // 3. Filter to exercises needing indexing
  const toIndex = forceReindex
    ? exercises
    : exercises.filter(ex => !alreadyIndexedIds.has(ex.id));

  if (toIndex.length === 0) {
    console.log('✨ All exercises already indexed. Nothing to do.');
    await pool.end();
    return;
  }

  console.log(`⚙️  Indexing ${toIndex.length} exercises...\n`);

  // 4. Index in batches of 10 (concurrent) to stay within API rate limits
  const BATCH_SIZE = 10;
  let indexed = 0;
  let failed = 0;

  for (let i = 0; i < toIndex.length; i += BATCH_SIZE) {
    const batch = toIndex.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (ex) => {
      try {
        const content = buildExerciseContent(ex);
        const zone = ZONE_LABELS[ex.zone_corporelle] || ex.zone_corporelle;

        await ingestDocument({
          title: `${ex.nom} — ${zone}`,
          category: 'exercice',
          source_type: 'internal',
          content,
          metadata: {
            exercise_id: ex.id,
            zone_corporelle: ex.zone_corporelle,
            zone_label: zone,
            muscles: ex.muscles || '',
            series: ex.series_recommandees,
            repetitions: ex.repetitions_recommandees,
            source: 'Kinévia Exercise Library',
          },
        });

        indexed++;
        process.stdout.write(`\r   ${indexed}/${toIndex.length} indexed...`);
      } catch (err) {
        failed++;
        console.error(`\n❌ Failed: ${ex.nom} (id=${ex.id}): ${err.message}`);
      }
    }));
  }

  console.log(`\n`);
  console.log('─'.repeat(50));
  console.log(`✅ Done!`);
  console.log(`   Indexed : ${indexed}`);
  if (failed > 0) {
    console.log(`   Failed  : ${failed}`);
  }

  // 5. Final stats
  const { rows: stats } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM rag_documents WHERE category = 'exercice') AS doc_count,
      (SELECT COUNT(*) FROM rag_chunks rc
       JOIN rag_documents rd ON rc.document_id = rd.id
       WHERE rd.category = 'exercice') AS chunk_count
  `);
  const s = stats[0];
  console.log(`   Documents: ${s.doc_count} exercice docs in RAG store`);
  console.log(`   Chunks   : ${s.chunk_count} embedded chunks`);
  console.log('─'.repeat(50));

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
