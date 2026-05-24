/**
 * Recommendation engine — services/recommendations.js
 *
 * Owns: AI-powered exercise recommendation from patient bilan + pathology data.
 * Does NOT own: exercise CRUD, patient management, bilan storage, chat AI.
 *
 * Uses Polsia AI proxy (never direct OpenAI/Anthropic) via lib/polsia-ai.js.
 * Single-shot JSON prompt: one AI call, structured response_format to avoid retries.
 * Results cached in exercise_recommendations table — keyed by patient_id + bilan_id.
 */

const { chat } = require('../lib/polsia-ai');

// Timeout for the single AI call. 55s to stay under Render's 60s request limit.
const AI_TIMEOUT_MS = 55000;
const DB_TIMEOUT_MS = 5000;

// ── Error classification (mirrors chatAI.js pattern) ─────────────────────────

const RecommendationErrorType = {
  TIMEOUT: 'TIMEOUT',
  RATE_LIMIT: 'RATE_LIMIT',
  NO_BILAN: 'NO_BILAN',
  PARSE_ERROR: 'PARSE_ERROR',
  GENERIC: 'GENERIC',
};

function classifyError(err) {
  const msg = (err.message || '').toLowerCase();
  const status = err.status || err.statusCode;
  if (msg === 'timeout') return RecommendationErrorType.TIMEOUT;
  if (status === 429 || msg.includes('rate limit') || msg.includes('quota') || msg.includes('overloaded') || msg.includes('daily_limit') || msg.includes('daily token limit')) {
    return RecommendationErrorType.RATE_LIMIT;
  }
  return RecommendationErrorType.GENERIC;
}

// ── Exercise pre-filtering ───────────────────────────────────────────────────
// Why: Sending all 319 exercises to the AI burns ~9,000 tokens per call.
// The Polsia AI proxy enforces a 100k daily token limit — at 9k/call the quota
// is exhausted after ~7 recommendation requests. Pre-filtering to ~40 relevant
// exercises cuts input tokens by ~80%, allowing ~35+ calls/day.

const MAX_EXERCISES_IN_PROMPT = 50;

/**
 * Score and filter exercises by relevance to the patient's pathology and zone.
 * Returns at most MAX_EXERCISES_IN_PROMPT exercises, sorted by relevance.
 */
function filterExercises(exerciseList, context) {
  const pathologie = (context.pathologie || '').toLowerCase().trim();
  const zone = (context.zone || '').toLowerCase().trim();

  if (!pathologie && !zone) {
    // No filtering possible — take a random sample to stay within budget
    return exerciseList.slice(0, MAX_EXERCISES_IN_PROMPT);
  }

  // Build search terms from pathology (e.g. "tendinite épaule" → ["tendinite", "épaule"])
  const pathTerms = pathologie.split(/[\s,;/]+/).filter(t => t.length > 2);

  const scored = exerciseList.map(ex => {
    let score = 0;
    const exPathologies = (ex.pathologies || '').toLowerCase();
    const exZone = (ex.zone_corporelle || '').toLowerCase();
    const exNom = (ex.nom || '').toLowerCase();
    const exMuscles = (ex.muscles || '').toLowerCase();

    // Pathology match (strongest signal)
    for (const term of pathTerms) {
      if (exPathologies.includes(term)) score += 3;
      if (exNom.includes(term)) score += 2;
      if (exMuscles.includes(term)) score += 1;
    }

    // Zone match
    if (zone && exZone === zone) score += 2;
    if (zone && exZone.includes(zone)) score += 1;

    // Cross-match: pathology terms in zone
    for (const term of pathTerms) {
      if (exZone.includes(term)) score += 2;
    }

    return { exercise: ex, score };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Take top-scoring exercises, fill remaining slots with unscored for diversity
  const topScored = scored.filter(s => s.score > 0).slice(0, MAX_EXERCISES_IN_PROMPT);

  if (topScored.length < MAX_EXERCISES_IN_PROMPT) {
    const remaining = scored.filter(s => s.score === 0);
    const fillCount = MAX_EXERCISES_IN_PROMPT - topScored.length;
    topScored.push(...remaining.slice(0, fillCount));
  }

  return topScored.map(s => s.exercise);
}

// ── Prompt construction ───────────────────────────────────────────────────────

/**
 * Build the AI prompt from patient/bilan context.
 * Exercises are pre-filtered to ~50 relevant ones to stay within token budget.
 */
function buildPrompt(context, exerciseList) {
  const { pathologie, douleur, objectifs, notes, mobilite, donneesCliniques, functionalScale, patientAge, patientSexe } = context;

  // Summarise donnees_cliniques sections if present
  let clinicalSummary = '';
  if (donneesCliniques && typeof donneesCliniques === 'object') {
    const fields = [];
    if (donneesCliniques.histoire_maladie) fields.push(`Anamnèse: ${donneesCliniques.histoire_maladie}`);
    if (donneesCliniques.symptomes) fields.push(`Symptômes: ${donneesCliniques.symptomes}`);
    if (donneesCliniques.limitations) fields.push(`Limitations: ${donneesCliniques.limitations}`);
    if (donneesCliniques.traitements_anterieurs) fields.push(`Traitements antérieurs: ${donneesCliniques.traitements_anterieurs}`);
    clinicalSummary = fields.slice(0, 4).join(' | ');
  }

  // Serialize exercise library: id, nom, zone, muscles, pathologies, niveau
  // Keep rows compact to stay within token budget
  const exercisesText = exerciseList.map(e =>
    `${e.id}|${e.nom}|${e.zone_corporelle}|${e.muscles || ''}|${e.pathologies || ''}|${e.niveau_difficulte || 'moyen'}`
  ).join('\n');

  return `Tu es un assistant kinésithérapeute expert. Analyse le profil clinique du patient et sélectionne 8 à 12 exercices adaptés depuis la bibliothèque fournie.

## Profil patient
- Pathologie principale : ${pathologie || 'non précisée'}
- Douleur (EVA 1-10) : ${douleur != null ? douleur : 'non renseignée'}
- Mobilité : ${mobilite || 'non renseignée'}
- Échelle fonctionnelle (0-10) : ${functionalScale != null ? functionalScale : 'non renseignée'}
- Âge : ${patientAge || 'non renseigné'}
- Sexe : ${patientSexe || 'non renseigné'}
- Objectifs : ${objectifs || 'non précisés'}
- Notes cliniques : ${notes || 'aucune'}
${clinicalSummary ? `- Données cliniques : ${clinicalSummary}` : ''}

## Bibliothèque d'exercices (format: id|nom|zone|muscles|pathologies_indiquées|niveau)
${exercisesText}

## Instructions
1. Sélectionne 8 à 12 exercices depuis la bibliothèque (IDs ci-dessus uniquement — ne fabrique pas d'ID)
2. Priorise les exercices dont les pathologies_indiquées correspondent à la pathologie du patient
3. Adapte au niveau de douleur : EVA > 6 → exercices faciles uniquement ; EVA 4-6 → facile + moyen ; EVA < 4 → tous niveaux
4. Assure une progression logique (mobilisation → renforcement → fonctionnel)
5. Pour chaque exercice, donne une justification courte (max 15 mots) en français

Réponds UNIQUEMENT avec un JSON valide (pas de texte avant/après) dans ce format exact :
{
  "exercices": [
    { "id": <number>, "score": <1-10>, "justification": "<string max 15 mots>" },
    ...
  ],
  "resume": "<2-3 phrases décrivant la logique du programme recommandé>"
}`;
}

// ── Core AI call ──────────────────────────────────────────────────────────────

/**
 * Call AI with timeout. Returns parsed JSON object.
 */
async function callAI(prompt, subscriptionId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { type: 'timeout' })), AI_TIMEOUT_MS);

    chat(prompt, {
      maxTokens: 2000,
      subscriptionId: subscriptionId || undefined,
    })
      .then(text => {
        clearTimeout(timer);
        // Strip markdown code fences if present
        const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        try {
          resolve(JSON.parse(clean));
        } catch (e) {
          const err = new Error('PARSE_ERROR: ' + e.message);
          err.type = RecommendationErrorType.PARSE_ERROR;
          err.rawText = text;
          reject(err);
        }
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

// ── DB helpers ────────────────────────────────────────────────────────────────

/**
 * Fetch a cached recommendation by patient + bilan.
 * Returns null if not found or DB unavailable.
 */
async function getCachedRecommendation(pool, patientId, bilanId) {
  try {
    const clause = bilanId
      ? 'patient_id = $1 AND bilan_id = $2'
      : 'patient_id = $1 AND bilan_id IS NULL';
    const params = bilanId ? [patientId, bilanId] : [patientId];

    const result = await Promise.race([
      pool.query(
        `SELECT id, exercises, pathologie, created_at
         FROM exercise_recommendations
         WHERE ${clause}
         ORDER BY created_at DESC
         LIMIT 1`,
        params
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB_TIMEOUT')), DB_TIMEOUT_MS)),
    ]);
    return result.rows[0] || null;
  } catch {
    return null;
  }
}

/**
 * Save a new recommendation. Non-blocking — failure here should not block response.
 */
async function saveRecommendation(pool, { kineId, patientId, bilanId, exercises, pathologie }) {
  try {
    await Promise.race([
      pool.query(
        `INSERT INTO exercise_recommendations (kine_id, patient_id, bilan_id, exercises, pathologie)
         VALUES ($1, $2, $3, $4, $5)`,
        [kineId, patientId, bilanId || null, JSON.stringify(exercises), pathologie || null]
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB_TIMEOUT')), DB_TIMEOUT_MS)),
    ]);
  } catch {
    // Non-fatal: cache miss is acceptable
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate or retrieve cached exercise recommendations for a patient.
 *
 * @param {object} pool           - pg Pool
 * @param {object} opts
 * @param {number} opts.kineId    - Authenticated kiné ID
 * @param {number} opts.patientId - Target patient ID
 * @param {number|null} opts.bilanId - Bilan ID (optional, for caching key)
 * @param {boolean} opts.forceRefresh - Skip cache and regenerate
 * @param {object} opts.patientData - Decrypted patient row { pathologie, age, sexe }
 * @param {object|null} opts.bilanData - Decrypted bilan row or null
 * @param {object[]} opts.exerciceList - Array of exercice rows from DB
 * @param {string|null} opts.subscriptionId - Stripe subscription ID for tracking
 * @returns {Promise<{
 *   exercises: Array<{id, nom, zone_corporelle, score, justification}>,
 *   resume: string,
 *   cached: boolean,
 *   recommendationId: number|null
 * }>}
 */
async function getRecommendations(pool, opts) {
  const { kineId, patientId, bilanId = null, forceRefresh = false, patientData, bilanData, exerciceList, subscriptionId } = opts;

  // ── 1. Check cache (unless forced refresh) ─────────────────────────────
  if (!forceRefresh) {
    const cached = await getCachedRecommendation(pool, patientId, bilanId);
    if (cached) {
      const parsed = typeof cached.exercises === 'string'
        ? JSON.parse(cached.exercises)
        : cached.exercises;
      // Hydrate with exercise metadata
      const hydrated = hydrateExercises(parsed.exercices || parsed, exerciceList);
      return {
        exercises: hydrated,
        resume: parsed.resume || '',
        cached: true,
        recommendationId: cached.id,
        cachedAt: cached.created_at,
      };
    }
  }

  // ── 2. Build context from patient + bilan data ─────────────────────────
  const context = {
    pathologie: patientData?.pathologie || null,
    patientAge: patientData?.age || null,
    patientSexe: patientData?.sexe || null,
    douleur: bilanData?.douleur_initiale || null,
    mobilite: bilanData?.mobilite_initiale || null,
    objectifs: bilanData?.objectifs || null,
    notes: bilanData?.notes || null,
    donneesCliniques: bilanData?.donnees_cliniques || null,
    functionalScale: bilanData?.functional_scale || null,
  };

  if (!context.pathologie && !bilanData) {
    throw Object.assign(new Error('Aucun bilan ou pathologie disponible pour ce patient'), {
      type: RecommendationErrorType.NO_BILAN,
    });
  }

  // ── 3. Pre-filter exercises and build prompt ─────────────────────────
  // Why: full 319-exercise list burns ~9k tokens per call; filtering to ~50
  // relevant ones cuts that by ~80% and prevents daily token exhaustion.
  const filteredExercises = filterExercises(exerciceList, {
    pathologie: context.pathologie,
    zone: bilanData?.zone_corporelle || patientData?.zone || null,
  });
  const prompt = buildPrompt(context, filteredExercises);
  let aiResponse;
  try {
    aiResponse = await callAI(prompt, subscriptionId);
  } catch (err) {
    const errType = classifyError(err);
    const typedErr = new Error(err.message);
    typedErr.recommendationErrorType = errType;
    throw typedErr;
  }

  // ── 4. Validate returned IDs against actual exercise library ──────────
  const validIds = new Set(exerciceList.map(e => e.id));
  const validatedExercises = (aiResponse.exercices || []).filter(e => validIds.has(Number(e.id)));

  // ── 5. Hydrate with exercise metadata ─────────────────────────────────
  const hydrated = hydrateExercises(validatedExercises, exerciceList);

  // ── 6. Cache the result (fire-and-forget) ─────────────────────────────
  const toCache = { exercices: validatedExercises, resume: aiResponse.resume || '' };
  saveRecommendation(pool, {
    kineId,
    patientId,
    bilanId,
    exercises: toCache,
    pathologie: context.pathologie,
  });

  return {
    exercises: hydrated,
    resume: aiResponse.resume || '',
    cached: false,
    recommendationId: null,
  };
}

/**
 * Merge AI exercise selections (id + score + justification)
 * with full exercise metadata from the library.
 */
function hydrateExercises(selections, exerciceList) {
  const byId = new Map(exerciceList.map(e => [e.id, e]));
  return selections
    .map(sel => {
      const ex = byId.get(Number(sel.id));
      if (!ex) return null;
      return {
        id: ex.id,
        nom: ex.nom,
        zone_corporelle: ex.zone_corporelle,
        muscles: ex.muscles || '',
        description: ex.description || '',
        image_url: ex.image_url || null,
        niveau_difficulte: ex.niveau_difficulte || 'moyen',
        series_recommandees: ex.series_recommandees || 3,
        repetitions_recommandees: ex.repetitions_recommandees || '10',
        pathologies: ex.pathologies || '',
        score: sel.score || 5,
        justification: sel.justification || '',
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

module.exports = {
  getRecommendations,
  RecommendationErrorType,
};
