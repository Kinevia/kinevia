/**
 * Demo seed script — populates 10 demo kiné accounts with realistic patients.
 *
 * Inserts for each demo kiné (kine1-10@demo.kinevia.pro, IDs 8-17):
 *   - 3-5 patients with French names, realistic ages, varied pathologies
 *   - 1 active programme per patient with 4-6 exercises from the seeded library
 *   - 6 weeks of historical séances with varied adherence profiles
 *   - 1-2 bilans (initial assessment) for 2-3 patients per kiné
 *   - A conversation thread with 3-4 message exchanges per patient
 *
 * Run via: POST /api/admin/seed-demo-patients (POLSIA_API_KEY auth)
 * or: node scripts/seed-demo-patients.js (requires DATABASE_URL env)
 *
 * Idempotent: checks for existing patients before inserting.
 */

'use strict';

const { Pool } = require('pg');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Pool setup — works both as standalone script (DATABASE_URL) and as
// module called from admin route (pool injected via run(pool))
// ---------------------------------------------------------------------------
let standalonePool = null;

function getPool(injectedPool) {
  if (injectedPool) return injectedPool;
  if (!standalonePool) {
    standalonePool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require')
        ? { rejectUnauthorized: false } : false,
    });
  }
  return standalonePool;
}

// ---------------------------------------------------------------------------
// Demo kine IDs — verified in production Clever Cloud DB
// ---------------------------------------------------------------------------
const KINE_IDS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17];

// ---------------------------------------------------------------------------
// Exercise pools by pathology — IDs from seeded library
// ---------------------------------------------------------------------------
const EXERCISES = {
  lombaire: [15, 16, 17, 18, 19, 20, 21, 51, 52, 53, 54, 55],
  cheville: [28, 29, 30, 31, 32, 33],
  genou: [8, 9, 10, 11, 12, 13, 14],
  epaule: [1, 2, 3, 4, 5, 6, 7],
  cervical: [39, 40, 41, 42, 43, 44],
  hanche: [22, 23, 24, 25, 26, 27],
  pied: [45, 46, 47, 48, 49, 50],
};

// ---------------------------------------------------------------------------
// Patient profiles — varied across kine accounts for diversity
// ---------------------------------------------------------------------------
const PATIENT_POOL = [
  { prenom: 'Marie', nom: 'Dupont', age: 45, pathologie: 'Lombalgie chronique', zone: 'lombaire', douleur_initiale: 7, objectifs: 'Reprendre le jardinage sans douleur, améliorer la mobilité lombaire', notes: 'Sédentaire, télétravail 5j/sem. Antécédents: hernie discale L4-L5 (2019).' },
  { prenom: 'Jean', nom: 'Martin', age: 62, pathologie: 'Prothèse totale de genou (PTG) gauche', zone: 'genou', douleur_initiale: 5, objectifs: 'Récupérer flexion >120°, marcher 2km sans aide', notes: 'PTG posée il y a 6 semaines. Bon moral, très motivé.' },
  { prenom: 'Sophie', nom: 'Bernard', age: 32, pathologie: 'Entorse de cheville grade II', zone: 'cheville', douleur_initiale: 6, objectifs: 'Reprendre la course à pied dans 8 semaines', notes: 'Entorse lors d\'un match de basket. IRM: lésion partielle LLE.' },
  { prenom: 'Pierre', nom: 'Leroy', age: 55, pathologie: 'Cervicalgie avec irradiation C5-C6', zone: 'cervical', douleur_initiale: 8, objectifs: 'Réduire les douleurs nocturnes, améliorer rotation cervicale', notes: 'Chauffeur routier. Posture en antéflexion chronique.' },
  { prenom: 'Isabelle', nom: 'Moreau', age: 38, pathologie: 'Épaule douloureuse — tendinopathie coiffe', zone: 'epaule', douleur_initiale: 6, objectifs: 'Reprendre le tennis, récupérer élévation complète', notes: 'Pratique tennis 3x/sem. IRM: tendinopathie sus-épineux sans rupture.' },
  { prenom: 'François', nom: 'Simon', age: 70, pathologie: 'Gonarthrose bilatérale stade II', zone: 'genou', douleur_initiale: 5, objectifs: 'Maintenir autonomie, réduire douleurs à la marche', notes: 'Retraité actif. Pas d\'indication chirurgicale pour l\'instant.' },
  { prenom: 'Catherine', nom: 'Laurent', age: 29, pathologie: 'Lombalgie aiguë post-efforts', zone: 'lombaire', douleur_initiale: 8, objectifs: 'Reprendre le travail (infirmière), prévenir récidives', notes: 'Épisode déclenché au travail (manutention patient). 2e épisode en 1 an.' },
  { prenom: 'Michel', nom: 'Thomas', age: 48, pathologie: 'Luxation antérieure épaule récidivante', zone: 'epaule', douleur_initiale: 4, objectifs: 'Renforcer rotateurs internes, éviter 3e luxation', notes: '2 luxations en 18 mois. A refusé la chirurgie. Kinésithérapie intensive.' },
  { prenom: 'Nathalie', nom: 'Robert', age: 52, pathologie: 'Coxarthrose droite débutante', zone: 'hanche', douleur_initiale: 5, objectifs: 'Maintenir périmètre de marche, renforcer moyen fessier', notes: 'Radios: pincement articulaire modéré. Bonne compliance attendue.' },
  { prenom: 'Alain', nom: 'Petit', age: 41, pathologie: 'Syndrome rotulien bilatéral', zone: 'genou', douleur_initiale: 6, objectifs: 'Reprendre la course après 3 mois d\'arrêt', notes: 'Coureur amateur (semi-marathon). Douleur antérieure du genou à la descente.' },
  { prenom: 'Valérie', nom: 'Richard', age: 67, pathologie: 'Fracture cheville opérée (ostéosynthèse)', zone: 'cheville', douleur_initiale: 7, objectifs: 'Récupérer appui complet, stabilité à la marche', notes: 'Fracture bi-malléolaire suite à une chute. Opérée il y a 8 semaines.' },
  { prenom: 'Bruno', nom: 'Durand', age: 36, pathologie: 'Tendinite patellaire (genou sauteur)', zone: 'genou', douleur_initiale: 7, objectifs: 'Reprendre le volleyball, renforcement excentrique', notes: 'Volleyeur de club. Arrêt sport depuis 6 semaines. Test Jump-landing positif.' },
  { prenom: 'Sandrine', nom: 'Lefevre', age: 44, pathologie: 'Fascite plantaire gauche', zone: 'pied', douleur_initiale: 6, objectifs: 'Marcher sans douleur le matin, reprendre la randonnée', notes: 'Douleur matinale classique. IMC 27. Orthèses plantaires prescrites.' },
  { prenom: 'David', nom: 'Mercier', age: 59, pathologie: 'Après rupture coiffe des rotateurs opérée', zone: 'epaule', douleur_initiale: 5, objectifs: 'Récupérer force et amplitude, reprendre natation', notes: 'Chirurgie il y a 4 mois. Phase de renforcement actif.' },
  { prenom: 'Hélène', nom: 'Girard', age: 31, pathologie: 'Entorse ACL — reprise sportive progressive', zone: 'genou', douleur_initiale: 3, objectifs: 'Retour au rugby en compétition dans 3 mois', notes: 'Reconstruction LCA il y a 9 mois. Critères de retour sport presque atteints.' },
  { prenom: 'Thierry', nom: 'Bonnet', age: 53, pathologie: 'Névralgie cervico-brachiale C7', zone: 'cervical', douleur_initiale: 8, objectifs: 'Calmer les douleurs brachiales, reprendre le travail', notes: 'Informaticien. Irradiation 3e doigt main droite. IRM: hernie C6-C7.' },
  { prenom: 'Stéphanie', nom: 'Roux', age: 27, pathologie: 'Lombalgies de grossesse (3e trimestre)', zone: 'lombaire', douleur_initiale: 5, objectifs: 'Soulager les douleurs lombaires et pelviennes', notes: 'Grossesse 32 SA. Douleurs aggravées la nuit. Ceinture de soutien prescrite.' },
  { prenom: 'Patrick', nom: 'Vincent', age: 65, pathologie: 'Maladie de Parkinson — physiothérapie neurologique', zone: 'hanche', douleur_initiale: 3, objectifs: 'Maintenir équilibre, prévenir chutes, entretenir souplesse', notes: 'Stade 2 Hoehn & Yahr. Suivi pluridisciplinaire. Séances 3x/sem.' },
  { prenom: 'Lucie', nom: 'Bertrand', age: 22, pathologie: 'Scoliose idiopathique — rééducation posturale', zone: 'lombaire', douleur_initiale: 4, objectifs: 'Correction posturale, stabiliser la courbure, éviter l\'évolution', notes: 'Cobb 28°. Port de corset 20h/j. Très assidue.' },
  { prenom: 'René', nom: 'Morel', age: 72, pathologie: 'Réhabilitation après PTH (prothèse hanche droite)', zone: 'hanche', douleur_initiale: 4, objectifs: 'Récupérer force quadriceps et fessiers, marche normale', notes: 'PTH il y a 3 semaines. Excellent moral. Fait ses exercices le matin seul.' },
  { prenom: 'Aurélie', nom: 'Lambert', age: 39, pathologie: 'Syndrome du canal carpien bilatéral', zone: 'pied', douleur_initiale: 5, objectifs: 'Réduire paresthésies, récupérer force préhension', notes: 'Caissière de supermarché. EMG confirmé. Opération côté droit il y a 6 semaines.' },
  { prenom: 'Sébastien', nom: 'Michel', age: 34, pathologie: 'Épicondylite latérale (tennis elbow)', zone: 'pied', douleur_initiale: 7, objectifs: 'Reprendre le badminton, travailler sans douleur', notes: 'Informaticien + badminton 2x/sem. Test de Cozen positif. Infiltration inefficace.' },
  { prenom: 'Monique', nom: 'Dupuis', age: 68, pathologie: 'Déconditionnement général post-COVID long', zone: 'lombaire', douleur_initiale: 4, objectifs: 'Récupérer capacité physique, lutter contre la fatigue', notes: 'COVID il y a 8 mois. Dyspnée d\'effort. Suivi cardio-respiratoire en parallèle.' },
  { prenom: 'Julien', nom: 'Fontaine', age: 26, pathologie: 'Lombalgie du sportif — pubalalgie', zone: 'lombaire', douleur_initiale: 6, objectifs: 'Reprendre le football en compétition, stabilisation pelvi-lombaire', notes: 'Footballeur amateur. Douleurs pubo-inguinales bilatérales. Écho: atteinte pubien.' },
  { prenom: 'Chantal', nom: 'Gautier', age: 57, pathologie: 'Syndrome de la bandelette ilio-tibiale', zone: 'hanche', douleur_initiale: 6, objectifs: 'Reprendre la course longue distance sans douleur latérale du genou', notes: 'Marathonienne. Douleur 5km après le départ. Test de Ober positif.' },
];

// ---------------------------------------------------------------------------
// Message templates — realistic kine-patient exchanges
// ---------------------------------------------------------------------------
const MESSAGE_TEMPLATES = [
  [
    { sender: 'kine', content: 'Bonjour ! Comment se passent vos exercices à la maison ? N\'hésitez pas si vous avez des questions.' },
    { sender: 'patient', content: 'Bonjour ! Ça se passe plutôt bien, j\'ai un peu de mal avec l\'exercice d\'équilibre mais je persévère.' },
    { sender: 'kine', content: 'Parfait, c\'est tout à fait normal au début. Appuyez-vous sur un mur si besoin pour l\'équilibre. On ajustera lors de la prochaine séance.' },
    { sender: 'patient', content: 'Merci pour le conseil ! À vendredi.' },
  ],
  [
    { sender: 'kine', content: 'Bonjour, je voulais prendre de vos nouvelles. Avez-vous pu faire vos exercices cette semaine ?' },
    { sender: 'patient', content: 'Oui, j\'en ai fait 3 sur 4 prévus. J\'ai eu une journée difficile mercredi avec plus de douleur. J\'ai préféré me reposer.' },
    { sender: 'kine', content: 'Vous avez bien fait d\'écouter votre corps. La douleur était de quel niveau sur 10 ?' },
    { sender: 'patient', content: '7/10 le matin mais ça s\'est calmé dans la journée. Aujourd\'hui c\'est revenu à 4/10.' },
    { sender: 'kine', content: 'OK, merci pour ce retour. Je note dans votre dossier. Si la douleur revient au-dessus de 7, reposez-vous et appelez-moi.' },
  ],
  [
    { sender: 'patient', content: 'Bonjour, petite question : est-ce que je peux faire mes exercices le soir plutôt que le matin ? Mon emploi du temps est chargé.' },
    { sender: 'kine', content: 'Tout à fait ! Le moment de la journée n\'a pas d\'importance. L\'essentiel c\'est la régularité. Soir ou matin, c\'est équivalent.' },
    { sender: 'patient', content: 'Super, merci ! Ça va m\'aider à être plus régulier.' },
  ],
  [
    { sender: 'kine', content: 'Bonjour ! Suite à notre séance d\'hier, je vous envoie un rappel : bien pensez à appliquer la glace 15 minutes après vos exercices pendant les 3 prochains jours.' },
    { sender: 'patient', content: 'Bien noté ! Combien de fois par jour ?' },
    { sender: 'kine', content: 'Une fois suffit, après votre séance d\'exercices. Enveloppez la glace dans un linge, jamais à même la peau.' },
    { sender: 'patient', content: 'Parfait, je ferai ça. Merci !' },
  ],
  [
    { sender: 'patient', content: 'Bonsoir, je voulais vous dire que j\'ai fait ma première marche de 30 minutes sans douleur aujourd\'hui ! C\'est la première fois depuis 2 mois !' },
    { sender: 'kine', content: 'Excellente nouvelle ! C\'est le signe que la rééducation porte ses fruits. Continuez sur cette lancée, bravo !' },
    { sender: 'patient', content: 'Merci à vous pour votre accompagnement. Je commence vraiment à y croire !' },
  ],
];

// ---------------------------------------------------------------------------
// Main seed function
// ---------------------------------------------------------------------------
async function run(injectedPool, log) {
  const pool = getPool(injectedPool);
  const logger = log || console.log;

  logger('[seed-demo] === Starting demo patient seeding ===');

  // Check if already properly seeded — require patients WITH pathologie set
  // (bare stubs from incomplete previous seeds have pathologie = null)
  const existingCheck = await pool.query(
    'SELECT COUNT(*) FROM patients WHERE kine_id = ANY($1) AND pathologie IS NOT NULL',
    [KINE_IDS]
  );
  const existingCount = parseInt(existingCheck.rows[0].count);
  if (existingCount > 0) {
    logger(`[seed-demo] Already seeded: ${existingCount} patients with pathologie found for demo kines. Skipping.`);
    return { skipped: true, existingCount };
  }

  // Shuffle patient pool for variety
  const shuffled = [...PATIENT_POOL].sort(() => Math.random() - 0.5);

  let patientIdx = 0;
  const results = { kines: [], totalPatients: 0, totalProgrammes: 0, totalSeances: 0, totalBilans: 0, totalMessages: 0 };

  for (const kineId of KINE_IDS) {
    // Each kine gets 3-5 patients (alternate pattern)
    const kineIndex = KINE_IDS.indexOf(kineId);
    const patientCount = [4, 3, 5, 4, 3, 5, 4, 3, 4, 5][kineIndex];

    logger(`[seed-demo] Kine ID ${kineId} — creating ${patientCount} patients...`);
    const kineResult = { kineId, patients: [] };

    for (let p = 0; p < patientCount; p++) {
      const profile = shuffled[patientIdx % shuffled.length];
      patientIdx++;

      // Generate unique patient link
      const lienUnique = crypto.randomBytes(16).toString('hex');

      // Realistic email (not real)
      const email = `${profile.prenom.toLowerCase()}.${profile.nom.toLowerCase()}${Math.floor(Math.random() * 90 + 10)}@patient.demo`;

      // Insert patient
      const patientRes = await pool.query(
        `INSERT INTO patients (kine_id, nom, prenom, email, telephone, pathologie, notes, lien_unique, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() - INTERVAL '${Math.floor(Math.random() * 60 + 10)} days')
         RETURNING id`,
        [
          kineId,
          profile.nom,
          profile.prenom,
          email,
          `06${Math.floor(Math.random() * 90000000 + 10000000)}`,
          profile.pathologie,
          profile.notes,
          lienUnique,
        ]
      );
      const patientId = patientRes.rows[0].id;
      results.totalPatients++;

      // --- Programme ---
      const progTitle = `Programme ${profile.pathologie.split(' ')[0]} — ${profile.prenom} ${profile.nom}`;
      const progRes = await pool.query(
        `INSERT INTO programmes (kine_id, patient_id, titre, date_debut, date_fin, notes, actif, frequence_semaine, duree_semaines, statut)
         VALUES ($1, $2, $3, NOW() - INTERVAL '6 weeks', NOW() + INTERVAL '6 weeks', $4, true, $5, 12, 'active')
         RETURNING id`,
        [
          kineId,
          patientId,
          progTitle,
          `Objectifs: ${profile.objectifs}`,
          [2, 3, 3, 4, 3][p % 5],
        ]
      );
      const progId = progRes.rows[0].id;
      results.totalProgrammes++;

      // --- Programme exercises (4-6 from relevant zone) ---
      const zoneExercises = EXERCISES[profile.zone] || EXERCISES.lombaire;
      const numExercises = 4 + (p % 3); // 4, 5, or 6
      const selectedExercises = zoneExercises.slice(0, numExercises);
      for (let e = 0; e < selectedExercises.length; e++) {
        await pool.query(
          `INSERT INTO programme_exercices (programme_id, exercice_id, series, repetitions, ordre)
           VALUES ($1, $2, $3, $4, $5)`,
          [progId, selectedExercises[e], 3, ['10', '12', '15', '30 sec', '45 sec'][e % 5], e + 1]
        );
      }

      // --- Historical séances (6 weeks back) ---
      // Adherence profiles: high (80-100%), medium (40-60%), low (10-30%)
      const adherenceProfiles = ['high', 'medium', 'low', 'high', 'medium'];
      const adherence = adherenceProfiles[p % 3 === 0 ? 0 : p % 3 === 1 ? 1 : 2];
      const freqPerWeek = [2, 3, 3, 4, 3][p % 5];

      for (let week = 6; week >= 1; week--) {
        const sessionsThisWeek = (() => {
          if (adherence === 'high') return freqPerWeek; // 100%
          if (adherence === 'medium') return Math.floor(freqPerWeek * 0.5); // ~50%
          return Math.random() < 0.3 ? 1 : 0; // low: ~1-2 per period
        })();

        for (let s = 0; s < sessionsThisWeek; s++) {
          const daysAgo = week * 7 - s * 2;
          const painScore = Math.max(0, profile.douleur_initiale - Math.floor(week * 0.8) + Math.floor(Math.random() * 2));
          await pool.query(
            `INSERT INTO seances (programme_id, patient_id, date, completee, douleur_score, difficulte, created_at)
             VALUES ($1, $2, NOW() - INTERVAL '${daysAgo} days', true, $3, $4, NOW() - INTERVAL '${daysAgo} days')`,
            [
              progId,
              patientId,
              Math.min(10, painScore),
              ['facile', 'modere', 'difficile'][Math.floor(Math.random() * 3)],
            ]
          );
          results.totalSeances++;
        }
      }

      // --- Bilans — first 2 patients per kine get a bilan ---
      if (p < 2) {
        await pool.query(
          `INSERT INTO bilans (kine_id, patient_id, douleur_initiale, objectifs, notes, type, date_bilan, created_at, functional_scale)
           VALUES ($1, $2, $3, $4, $5, 'initial', NOW() - INTERVAL '${Math.floor(Math.random() * 40 + 20)} days', NOW() - INTERVAL '${Math.floor(Math.random() * 40 + 20)} days', $6)`,
          [
            kineId,
            patientId,
            profile.douleur_initiale,
            profile.objectifs,
            `Bilan initial — ${profile.pathologie}. ${profile.notes}`,
            10 - profile.douleur_initiale, // functional scale inversely correlated
          ]
        );
        results.totalBilans++;
      }

      // --- Conversations + messages ---
      const convRes = await pool.query(
        `INSERT INTO conversations (kine_id, patient_id, created_at, updated_at)
         VALUES ($1, $2, NOW() - INTERVAL '${Math.floor(Math.random() * 20 + 5)} days', NOW() - INTERVAL '${Math.floor(Math.random() * 3 + 1)} days')
         ON CONFLICT (kine_id, patient_id) DO NOTHING
         RETURNING id`,
        [kineId, patientId]
      );

      if (convRes.rows.length > 0) {
        const convId = convRes.rows[0].id;
        const msgTemplate = MESSAGE_TEMPLATES[p % MESSAGE_TEMPLATES.length];

        for (let m = 0; m < msgTemplate.length; m++) {
          const msg = msgTemplate[m];
          const daysAgo = msgTemplate.length - m;
          await pool.query(
            `INSERT INTO messages (conversation_id, sender_type, sender_id, content, read_at, created_at)
             VALUES ($1, $2, $3, $4, NOW() - INTERVAL '${daysAgo - 1} days', NOW() - INTERVAL '${daysAgo} days')`,
            [
              convId,
              msg.sender,
              msg.sender === 'kine' ? kineId : patientId,
              msg.content,
            ]
          );
          results.totalMessages++;
        }
      }

      kineResult.patients.push({ patientId, prenom: profile.prenom, nom: profile.nom, pathologie: profile.pathologie });
    }

    results.kines.push(kineResult);
    logger(`[seed-demo] ✓ Kine ${kineId}: ${patientCount} patients, programmes, séances, bilans, messages done`);
  }

  logger(`[seed-demo] === DONE ===`);
  logger(`[seed-demo] Patients: ${results.totalPatients}`);
  logger(`[seed-demo] Programmes: ${results.totalProgrammes}`);
  logger(`[seed-demo] Séances: ${results.totalSeances}`);
  logger(`[seed-demo] Bilans: ${results.totalBilans}`);
  logger(`[seed-demo] Messages: ${results.totalMessages}`);

  return results;
}

// ---------------------------------------------------------------------------
// Standalone execution
// ---------------------------------------------------------------------------
if (require.main === module) {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is required');
    process.exit(1);
  }
  run(null, console.log)
    .then((r) => {
      console.log('Seed result:', JSON.stringify(r, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seed failed:', err.message);
      process.exit(1);
    });
}

module.exports = { run };
