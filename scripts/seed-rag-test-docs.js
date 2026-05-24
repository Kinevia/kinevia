#!/usr/bin/env node
/**
 * scripts/seed-rag-test-docs.js
 *
 * Seeds the RAG store with representative clinical documents for testing.
 * Run once after migration 070 deploys:
 *
 *   DATABASE_URL=... OPENAI_BASE_URL=... OPENAI_API_KEY=... node scripts/seed-rag-test-docs.js
 *
 * Documents chosen to cover the main categories in the chatAI system prompt:
 *   - anatomie
 *   - pathologie
 *   - protocole
 *   - nutrition
 *   - formation
 */

require('dotenv').config();
const { ingestDocument, getStats } = require('../services/ragService');

// ── Test documents ────────────────────────────────────────────────────────────

const TEST_DOCUMENTS = [
  {
    title: 'Anatomie de l\'épaule : coiffe des rotateurs',
    category: 'anatomie',
    source_type: 'internal',
    content: `## Coiffe des rotateurs — Anatomie fondamentale

La coiffe des rotateurs est composée de quatre muscles qui entourent l'articulation gléno-humérale et assurent sa stabilité dynamique.

### Les quatre muscles de la coiffe

**Sus-épineux (Supraspinatus)**
- Origine : fosse supra-épineuse de la scapula
- Insertion : tubercule majeur de l'humérus (facette supérieure)
- Innervation : nerf sus-scapulaire (C5-C6)
- Action principale : abduction de 0 à 30°, stabilisation de la tête humérale
- Zone critique : la partie distale du tendon (~1 cm de l'insertion) est la zone la plus souvent lésée — zone hypovasculaire dite "zone critique de Codman"

**Sous-épineux (Infraspinatus)**
- Origine : fosse infra-épineuse de la scapula
- Insertion : tubercule majeur (facette moyenne)
- Innervation : nerf sus-scapulaire (C5-C6)
- Action principale : rotation externe (60-70% de la force totale de RE)

**Petit rond (Teres minor)**
- Origine : bord latéral de la scapula
- Insertion : tubercule majeur (facette inférieure)
- Innervation : nerf axillaire / circonflexe (C5-C6)
- Action principale : rotation externe, adduction

**Sous-scapulaire (Subscapularis)**
- Origine : fosse sous-scapulaire (face antérieure de la scapula)
- Insertion : tubercule mineur de l'humérus
- Innervation : nerfs sous-scapulaires supérieur et inférieur (C5-C6-C7)
- Action principale : rotation interne (puissant antagoniste des trois autres muscles)

### Biomécanique du complexe gléno-huméral

Le mécanisme force-couple est fondamental : le sus-épineux génère l'abduction tandis que les rotateurs (sous-épineux, petit rond, sous-scapulaire) compriment et centrent la tête humérale dans la glène.

L'espace sous-acromial normal est de 7 à 14 mm. Un conflit sous-acromial survient quand cet espace diminue (position élevée du bras, épaississement bursal, déchirure partielle du tendon).

### Amplitudes physiologiques
- Abduction gléno-humérale : 120° (les 60° restants jusqu'à 180° viennent du rythme scapulo-huméral)
- Flexion : 0-180°
- Rotation externe (bras au corps) : 0-90°
- Rotation interne (bras au corps) : 0-90°`,
    metadata: { source: 'Kinévia Knowledge Base', version: '1.0' },
  },

  {
    title: 'Tendinopathie du sus-épineux : diagnostic et rééducation',
    category: 'pathologie',
    source_type: 'internal',
    content: `## Tendinopathie du sus-épineux

### Mécanisme et présentation clinique

La tendinopathie du sus-épineux est la pathologie de coiffe la plus fréquente (60-70% des douleurs d'épaule). Elle résulte d'une surcharge répétée du tendon, avec dégénérescence de la matrice collagénique.

**Symptômes typiques :**
- Douleur antérieure et latérale de l'épaule, irradiant vers la face latérale du bras (jusqu'au coude)
- Arc douloureux d'abduction entre 60 et 120°
- Douleur nocturne possible (position latérale sur l'épaule atteinte)
- Pas de déficit neurologique

**Tests cliniques validés :**
- Test de Jobe (Empty Can) : abduction à 90° dans le plan de la scapula, rotation interne, résistance manuelle. Positif si douleur et/ou faiblesse.
- Test de Neer : flexion passive forcée avec épaule en RI. Positif si douleur sous-acromiale.
- Test de Hawkins-Kennedy : flexion à 90°, RI forcée. Positif si douleur.
- Arc douloureux (60-120°) : sensibilité 70%, spécificité 66%

**Diagnostic différentiel :**
- Déchirure partielle ou transfixiante (IRM nécessaire si suspicion, douleur > 3 mois, déficit de force)
- Conflit sous-acromial (bursite sous-acromio-deltoïdienne)
- Arthrose acromio-claviculaire
- Instabilité gléno-humérale

### ⚠️ Contre-indications à vérifier avant application

**Absolues :** fracture de l'humérus non consolidée, infection locale, tumeur maligne.
**Relatives :** déchirure transfixiante complète avec déficit fonctionnel majeur (chirurgie à discuter), calcification volumineuse en phase aiguë.

### Protocole de rééducation

**Phase 1 — Antalgique (J0 à J21)**
Objectif : réduire la douleur et l'inflammation.
- Repos relatif (éviter les mouvements déclencheurs sans mise en décharge complète)
- Travail pendulaire de Codman (gravité déconditionne la tonicité)
- Renforcement des rotateurs scapulaires (trapèze moyen, rhomboïdes, dentelé antérieur) sans charge
- Cryothérapie 10-15 min post-séance
- Éducation : explication du modèle de la douleur, repositionnement de la tête humérale

**Phase 2 — Renforcement excentrique (J21 à J60)**
Objectif : stimuler la synthèse collagénique, restaurer la force.
- Renforcement excentrique du sus-épineux et des rotateurs :
  - Exercice de Jobe excentrique : 3 × 15 répétitions, 2×/jour, vitesse lente (3-4 sec descente)
  - Rotation externe avec élastique : 3 × 15 RI→RE, tempo 2:0:4
  - Seuil douloureux acceptable : ≤ 5/10 en EVA pendant l'exercice
- Renforcement dynamique du deltoid sous le seuil douloureux
- Rééducation proprioceptive scapulo-thoracique

**Phase 3 — Fonctionnelle (J60 à J90)**
Objectif : retour aux activités.
- Exercices en chaîne cinétique fermée (appuis muraux, pompes progressives)
- Travail spécifique au geste métier ou sportif
- Critère de passage : force RI/RE ≥ 90% du côté sain, arc douloureux < 3/10

**Résultats attendus :**
- 70-80% de succès conservateur à 3 mois
- Chirurgie (acromioplastie arthroscopique) si échec à 6 mois de traitement bien conduit`,
    metadata: { source: 'Kinévia Knowledge Base', version: '1.0' },
  },

  {
    title: 'Protocole de rééducation du LCA : phases et critères de retour au sport',
    category: 'protocole',
    source_type: 'internal',
    content: `## Rééducation post-plastie du LCA

### Phases de rééducation

La rééducation après reconstruction du ligament croisé antérieur (LCA) suit un protocole en 5 phases basé sur des critères cliniques plutôt que des délais fixes.

**⚠️ Contre-indications absolues :** défaut d'extension > 10°, épanchement important (> 20 ml) en l'absence de traitement, douleur > 8/10 au repos.

---

### Phase 1 — Contrôle inflammatoire et récupération de la mobilité (S0-S6)

**Objectifs :**
- Extension complète (objectif prioritaire absolu — un déficit persistant = complication grave)
- Flexion > 90° à S3, > 120° à S6
- Contrôle de l'inflammation et de l'épanchement
- Activation quadricipitale (contraction isométrique)

**Exercices clés :**
- Mobilisation passive en extension (gravity drop, heel prop)
- Glissements talon-fesse actifs assistés
- Contractions isométriques quadriceps à 0° et 60°
- Proprioception en charge partielle sur plateau de Freeman

**Critères de passage en phase 2 :**
- Extension complète ou < 5° de déficit
- Flexion ≥ 120°
- Marche sans boiterie
- Épanchement minimal

---

### Phase 2 — Renforcement musculaire et stabilisation (S6-S16)

**Objectifs :**
- Force quadriceps ≥ 60% côté sain (dynamomètre)
- Qualité du contrôle neuromusculaire
- Schéma de marche normal

**Exercices :**
- Presse à cuisses bilatérale puis unilatérale (0-90°)
- Leg extension évitée jusqu'à S12 (contrainte de cisaillement sur le greffon)
- Squats (0-60° de flexion, progression)
- Exercices proprioceptifs : balance board, perturbations externes
- Vélo (dès flexion > 110°), natation brasse évitée

---

### Phase 3 — Réathlétisation (S16-S24+)

**Objectifs :**
- Force quadriceps ≥ 80% côté sain
- Force ischio-jambiers ≥ 90% côté sain (ratio IJ/Q ≥ 55%)
- Contrôle atterrissage et pivots

**Tests de passage :**
- Single Leg Hop Test : ≥ 85% symétrie
- Triple Hop Test : ≥ 85% symétrie
- Y-Balance Test : dans les normes de genre et sport

**Retour au sport :** délai minimal 9 mois post-chirurgie (recommandation 2023, van Melick et al.)
- Risque de re-rupture × 2 si RTS < 9 mois
- Facteur psychologique : ACL-RSI score ≥ 56/100 recommandé

### Indicateurs de progression
- Échelle de Lysholm : > 95/100 pour RTS
- IKDC Subjectif : > 85/100
- EVA au repos : 0-1/10`,
    metadata: { source: 'Kinévia Knowledge Base', version: '1.0' },
  },

  {
    title: 'Nutrition et récupération musculaire en kinésithérapie sportive',
    category: 'nutrition',
    source_type: 'internal',
    content: `## Nutrition et récupération musculaire

### Apports protéiques recommandés

La synthèse des protéines musculaires (MPS) est le mécanisme clé de la récupération et de l'adaptation à l'entraînement.

**Apports recommandés selon l'objectif :**
- Patient sédentaire en rééducation : 1,2–1,4 g/kg/jour
- Athlète de loisir en rééducation : 1,6–2,0 g/kg/jour
- Sarcopénie et sujet âgé (> 65 ans) : 1,6–2,2 g/kg/jour
- Post-chirurgie orthopédique : 1,8–2,0 g/kg/jour (cicatrisation collagénique accrue)

**Qualité protéique :** privilégier les protéines à haute valeur biologique (score PDCAAS ≥ 1) :
- Whey (lactosérum), caséine, œufs (blanc), viandes maigres, légumineuses + céréales

**Timing :**
- Fenêtre anabolique post-exercice : 20-40 g de protéines dans les 2h post-séance
- Distribution régulière sur 4-5 prises/jour (stimulation MPS > repas unique important)

### Compléments scientifiquement validés

| Complément | Dose | Niveau de preuve | Indication |
|---|---|---|---|
| Créatine monohydrate | 3-5 g/j | A (Cochrane 2022) | Force, sarcopénie, rééducation post-opératoire |
| Vitamine D3 | 1000-4000 UI/j (adapter selon 25-OH-D) | A | Réduction fractures, fonctionnement musculaire |
| Collagène hydrolysé + Vit C | 15 g + 50 mg, 1h avant exercice | B | Tendinopathies, ligamentoplasties |
| Magnésium | 300-400 mg/j (forme bisglycinate) | B | Crampes, récupération neuromusculaire |
| Oméga-3 (EPA+DHA) | 2-3 g/j | B | Anti-inflammatoire, récupération |

### Alimentation anti-inflammatoire

**À favoriser :**
- Poissons gras (saumon, sardine, maquereau) : 2-3 fois/semaine — source EPA/DHA
- Fruits rouges (myrtilles, cerises) : polyphénols, anthocyanines anti-inflammatoires
- Curcuma + poivre noir : curcumine (biodisponibilité augmentée × 20 par la pipérine)
- Huile d'olive extra-vierge : oléocanthal (effet anti-COX similaire à l'ibuprofène faible dose)
- Crucifères (brocolis, chou) : sulforaphane, activation voie Nrf2

**À limiter lors d'une phase inflammatoire aiguë :**
- Acides gras trans, huiles de tournesol/maïs (ratio oméga-6/oméga-3 > 20:1)
- Sucres raffinés (pic glycémique → cascade pro-inflammatoire via IL-6, TNF-α)
- Alcool : inhibe la MPS de 24% post-exercice (Parr et al., 2014)

### Hydratation

- Besoins de base : 35 ml/kg/jour
- Majoration à l'effort : +500 ml par heure d'exercice modéré, +1L par heure d'effort intense
- Signes de déshydratation clinique : urines foncées (> grade 4 échelle PISSED), perte de poids corporel > 2%, baisse de force de préhension, tachycardie au repos
- Boisson de récupération dans les 30 min si effort > 90 min : glucides + protéines 3:1`,
    metadata: { source: 'Kinévia Knowledge Base', version: '1.0' },
  },

  {
    title: 'Méthode McKenzie : principes et application clinique',
    category: 'formation',
    source_type: 'internal',
    content: `## Méthode McKenzie (MDT — Mechanical Diagnosis and Therapy)

### Principes fondamentaux

La méthode McKenzie repose sur la classification des syndromes rachidiens et périphériques selon leur réponse mécanique aux mouvements répétés.

### Les trois syndromes

**1. Syndrome de dérangement**
Le plus fréquent (70-80% des douleurs lombaires mécaniques). Causé par une perturbation de la structure discale ou articulaire.
- Caractéristique : abolition/réduction des symptômes avec un mouvement répété dans une direction spécifique (centralisation)
- La centralisation est le principal indicateur pronostique positif : douleur qui se déplace de périphérique vers le centre (fesse → lombaire)
- Direction Préférentielle de Mouvement (DPM) identifiée lors du bilan : extension, flexion, ou latéroflexion

**2. Syndrome de dysfonctionnement**
- Causé par un tissu cicatriciel ou adaptatif raccourci
- Douleur reproductible en fin de course d'un mouvement, sans centralisation ni aggravation
- Traitement : étirements répétés et progressifs dans la direction limitée

**3. Syndrome de posture**
- Le moins fréquent. Douleur uniquement en position maintenue prolongée
- Traitement : correction posturale et éducation

### Bilan McKenzie — Procédure

**Anamnèse :**
- Comportement des symptômes (constant/intermittent, mécanique/non-mécanique)
- Mouvements aggravants et soulageants

**Tests de mouvement répété :**
1. Tester chaque direction (extension, flexion, latéroflexion D et G, parfois rotation)
2. Pour chaque direction : observer le comportement des symptômes distaux et proximaux
3. Documenter : centralisation, périphérisation, abolition, aggravation

**Interprétation :**
- Centralisation → direction préférentielle identifiée → syndrome de dérangement → bon pronostic
- Périphérisation → contre-indication formelle à cette direction
- Pas de changement → syndrome de dysfonctionnement ou posture, ou pathologie non mécanique

### Exercices types — Dérangement postérieur (le plus fréquent)

**Protocole d'extension (DPM = extension) :**
- Décubitus ventral 5 min (procubitus) → extension passive sur les coudes → extension sur les mains (press-up)
- Progression : extension en position assise → extension en position debout
- Fréquence : 10 répétitions toutes les 2h

**Critères d'arrêt d'une direction :**
- Périphérisation progressive
- Aggravation franche de la symptomatologie distale
- Signes neurologiques nouveaux

### Intégration en pratique

McKenzie s'intègre avec les autres techniques : une fois la DPM identifiée, les mobilisations de Maitland en grades III-IV dans la même direction amplifient les gains. Le renforcement lombaire (gainage, extension) est initié en phase de consolidation une fois la centralisation obtenue.`,
    metadata: { source: 'Kinévia Knowledge Base', version: '1.0' },
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌱 Seeding RAG store with test clinical documents...\n');

  for (const doc of TEST_DOCUMENTS) {
    process.stdout.write(`  → ${doc.title} (${doc.category})... `);
    try {
      const result = await ingestDocument(doc);
      console.log(`✅ doc_id=${result.document_id}, ${result.chunk_count} chunks`);
    } catch (err) {
      console.log(`❌ FAILED: ${err.message}`);
    }
  }

  console.log('\n📊 Final stats:');
  try {
    const stats = await getStats();
    console.log(`  Documents : ${stats.document_count}`);
    console.log(`  Chunks    : ${stats.chunk_count}`);
    console.log(`  Categories: ${JSON.stringify(stats.by_category, null, 2)}`);
  } catch (err) {
    console.error('Could not retrieve stats:', err.message);
  }

  console.log('\n✅ Seeding complete.');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
