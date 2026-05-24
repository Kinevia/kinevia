/**
 * index-clinical-tests.js
 *
 * One-shot script to index all clinical tests from the DB into the RAG vector store.
 * Run: node index-clinical-tests.js
 * Run with force: node index-clinical-tests.js --force
 */

require('dotenv').config();
const ragService = require('./services/ragService');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const CATEGORY_LABELS = {
  epaule:       'Épaule',
  genou:        'Genou',
  coude:        'Coude',
  atm:          'ATM (Articulation Temporo-Mandibulaire)',
  cervicales:   'Cervicales',
  cervical:     'Cervicales',
  rachis:       'Rachis',
  hanche:       'Hanche',
  cheville:     'Cheville',
  douleur:      'Douleur',
  fonction:     'Fonction',
  equilibre:    'Équilibre',
  force:        'Force',
  mobilite:     'Mobilité',
  neurologique: 'Neurologique',
};

function buildClinicalTestContent(test) {
  const catLabel = CATEGORY_LABELS[test.category] || test.category;
  const parts = [
    `# ${test.name}`,
    '',
    `**Catégorie :** ${catLabel}`,
  ];

  if (test.description) {
    parts.push('');
    parts.push('## Description');
    parts.push(test.description);
  }

  if (test.instructions) {
    parts.push('');
    parts.push('## Protocole / Instructions');
    parts.push(test.instructions);
  }

  if (test.scoring_method) {
    parts.push('');
    parts.push('## Méthode de cotation');
    parts.push(test.scoring_method);
  }

  if (test.interpretation_guide) {
    parts.push('');
    parts.push('## Interprétation des scores');
    parts.push(test.interpretation_guide);
  }

  if (test.evidence_level) {
    parts.push('');
    parts.push(`**Niveau de preuve :** ${test.evidence_level}`);
  }

  if (test.source_reference) {
    parts.push(`**Référence :** ${test.source_reference}`);
  }

  return parts.join('\n').trim();
}

async function run() {
  const forceReindex = process.argv.includes('--force');

  console.log(`[rag-clinical] Starting clinical tests indexer... (force=${forceReindex})`);

  const { rows: tests } = await pool.query(`
    SELECT id, name, description, category, scoring_method,
           instructions, interpretation_guide, evidence_level, source_reference
    FROM clinical_tests
    ORDER BY category, name
  `);
  console.log(`[rag-clinical] Found ${tests.length} clinical tests`);

  // Build set of already-indexed test IDs
  let alreadyIndexedIds = new Set();
  if (!forceReindex) {
    const existing = await ragService.listDocuments();
    for (const doc of existing) {
      if (doc.category === 'test_clinique' && doc.metadata && doc.metadata.test_id) {
        alreadyIndexedIds.add(Number(doc.metadata.test_id));
      }
    }
    console.log(`[rag-clinical] Already indexed: ${alreadyIndexedIds.size}`);
  } else {
    const existing = await ragService.listDocuments();
    const toDelete = existing.filter(d => d.category === 'test_clinique');
    console.log(`[rag-clinical] Force mode — deleting ${toDelete.length} existing docs`);
    for (const doc of toDelete) {
      await ragService.deleteDocument(doc.id);
    }
  }

  const toIndex = forceReindex
    ? tests
    : tests.filter(t => !alreadyIndexedIds.has(t.id));

  if (toIndex.length === 0) {
    console.log('[rag-clinical] Nothing to index — all clinical tests already in RAG store');
    await pool.end();
    return;
  }

  console.log(`[rag-clinical] Indexing ${toIndex.length} clinical tests...`);

  let indexed = 0;
  let failed = 0;
  const BATCH_SIZE = 5;

  for (let i = 0; i < toIndex.length; i += BATCH_SIZE) {
    const batch = toIndex.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (test) => {
      try {
        const catLabel = CATEGORY_LABELS[test.category] || test.category;
        await ragService.ingestDocument({
          title: `${test.name} — ${catLabel}`,
          category: 'test_clinique',
          source_type: 'internal',
          content: buildClinicalTestContent(test),
          metadata: {
            test_id: test.id,
            category: test.category,
            category_label: catLabel,
            evidence_level: test.evidence_level || '',
            source: 'Kinévia Clinical Tests Library',
          },
        });
        indexed++;
        console.log(`  ✓ ${test.name}`);
      } catch (err) {
        failed++;
        console.error(`  ✗ ${test.name} (id=${test.id}): ${err.message}`);
      }
    }));

    console.log(`[rag-clinical] Progress: ${Math.min(i + BATCH_SIZE, toIndex.length)}/${toIndex.length}`);
  }

  console.log(`\n[rag-clinical] Done — indexed: ${indexed}, failed: ${failed}`);

  // Final stats
  const existing = await ragService.listDocuments();
  const clinicalDocs = existing.filter(d => d.category === 'test_clinique');
  console.log(`[rag-clinical] Total test_clinique docs in RAG: ${clinicalDocs.length}`);

  await pool.end();
}

run().catch(err => {
  console.error('[rag-clinical] Fatal:', err.message);
  process.exit(1);
});
