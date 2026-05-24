#!/usr/bin/env node
/**
 * Generate DALL-E 3 images for ALL 22 ATM exercises and upload to R2
 * Then update image_url in the database
 * Generated: 2026-05-06
 */

const OpenAI = require('openai');
const fetch = require('node-fetch');
const FormData = require('form-data');
const { Pool } = require('pg');

const openai = new OpenAI();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const STYLE =
  'Flat 2D medical illustration, pure white background, clean clinical style. No shadows, no 3D rendering, no photorealism. Simple line art with flat color fills. Use colored arrows: GREEN (#22c55e) for correct movement direction, RED (#ef4444) for movement to avoid or resistance. Include concise French anatomical labels with small leader lines. Professional physiotherapy patient-education style, minimalist, precise.';

const EXERCISES = [
  {
    id: 206,
    nom: 'Ouverture mandibulaire avec résistance',
    prompt: `${STYLE} 3/4 front view of a head and shoulders. The right thumb is placed firmly under the chin (pointing upward), index finger rests on the front of the chin. Mouth open approximately 2 cm (gap between teeth visible). GREEN arrow pointing DOWN at the lower jaw (opening movement). RED arrow pointing UP at the thumb (isometric resistance). French labels: "Pouce (résistance)", "Index (guide)", "2 cm ouverture". Simple flat medical illustration.`,
  },
  {
    id: 207,
    nom: 'Diduction mandibulaire (latéralité)',
    prompt: `${STYLE} Front view of a face. Mouth slightly open (1-2 cm), teeth separated and visible. Lower jaw displaced clearly to the RIGHT, creating offset between upper and lower dental midlines. Large GREEN arrow pointing RIGHT at chin level. Vertical dashed center line on the face. Small secondary panel showing jaw displaced LEFT with another GREEN arrow. French labels: "Diduction droite", "Axe médian", "Diduction gauche", "Dents séparées". Flat 2D medical illustration.`,
  },
  {
    id: 208,
    nom: 'Auto-massage intra-buccal du ptérygoïdien médial',
    prompt: `${STYLE} Two panels side by side. LEFT: 3/4 front view, mouth wide open, right index finger inserted inside the right cheek behind the lower back molars. Small circular highlight on the inner cheek wall. French label: "Doigt derrière molaires inférieures, paroi interne". RIGHT: simplified anatomical cross-section of the open jaw showing upper palate, tongue, lower jaw with back molars labeled "Molaires inf.", and an orange-highlighted zone labeled "Ptérygoïdien médial" at the inner jaw wall. GREEN circular arrows showing small massage circles. Flat 2D medical illustration.`,
  },
  {
    id: 209,
    nom: 'Exercice de stabilisation mandibulaire (langue haut, yeux ouverts)',
    prompt: `${STYLE} Person seated facing a mirror, slight 3/4 angle showing both person and mirror reflection. Mouth opening slowly, lips parting vertically. Blue dashed vertical line from nose to chin on both person and reflection (ideal trajectory). Small tongue shape visible pressed against upper palate, label "Langue sur palais". Mirror reflection shows checkmark (✓) for correct vertical alignment. Small inset circle shows jaw deviating sideways with RED X (incorrect). French labels: "Ouverture verticale sans déviation", "Miroir biofeedback". Flat 2D medical illustration.`,
  },
  {
    id: 210,
    nom: 'Correction posturale cervico-mandibulaire',
    prompt: `${STYLE} Side profile of person seated upright. Two simultaneous actions shown with numbered arrows: (1) GREEN horizontal arrow pointing BACKWARD at chin/neck level labeled "Rétraction cervicale". (2) GREEN downward arrow at jaw level labeled "Relâchement mandibulaire, dents séparées". Small tongue icon on palate labeled "Langue sur palais". Incorrect posture inset (red border): head tilting DOWN instead of chin retracting, with RED X. French labels: "1. Rétraction cervicale douce", "2. Mâchoire décontractée", "Dents séparées, lèvres fermées". Flat 2D medical illustration.`,
  },
  {
    id: 211,
    nom: 'Ouverture mandibulaire contrôlée',
    prompt: `${STYLE} Front view of a face showing two positions: faint silhouette (mouth closed, neutral) and solid drawing (mouth open, maximum amplitude without pain). Vertical dashed center line on face. Finger of one hand gently placed on side of chin to guide. GREEN straight vertical arrow downward (correct opening). RED diagonal arrow (incorrect deviation to avoid). French labels: "Langue sur palais", "Axe médian", "Doigt guide", "Amplitude max sans douleur", "Sans déviation". Flat 2D medical illustration.`,
  },
  {
    id: 212,
    nom: 'Fermeture mandibulaire résistée',
    prompt: `${STYLE} 3/4 front view of head. Mouth open approximately 2 cm. Index and middle fingers placed on the lower back molars applying gentle downward pressure. RED arrow pointing DOWN from fingers (resistance force). GREEN arrow pointing UP at lower jaw (closing movement against resistance). Small timer icon showing "5 secondes isométrique". French labels: "Doigts sur molaires inférieures", "Résistance vers le bas", "Fermeture contre résistance", "Muscles élévateurs (masséters, temporaux)". Flat 2D medical illustration.`,
  },
  {
    id: 213,
    nom: 'Diduction avec résistance latérale',
    prompt: `${STYLE} Front view of a face, split into two mirrored panels. LEFT panel: finger on RIGHT side of chin. GREEN arrow pointing RIGHT (jaw push). RED arrow pointing LEFT at finger (resistance). RIGHT panel: finger on LEFT side of chin with mirrored arrows. French labels: "Doigt résistance", "Poussée mandibulaire", "Isométrique 5s", "Répéter autre côté", "Ptérygoïdien latéral (renforcement)". Flat 2D medical illustration.`,
  },
  {
    id: 214,
    nom: 'Propulsion mandibulaire',
    prompt: `${STYLE} Side profile of a head showing two positions overlaid: faint (neutral, incisors aligned) and solid (lower incisors slightly in front of upper incisors). GREEN horizontal arrow pointing FORWARD at lower jaw level. Small reference lines showing incisor positions at neutral vs. protruded. French labels: "Position neutre", "Propulsion complète", "Incisives inf. en avant", "Translation condylienne antérieure", "Ptérygoïdien latéral". Flat 2D medical illustration.`,
  },
  {
    id: 215,
    nom: 'Rétropulsion mandibulaire douce',
    prompt: `${STYLE} Side profile of a head showing two positions: faint (neutral) and solid (jaw retracted backward). GREEN horizontal arrow pointing BACKWARD at lower jaw. Mouth slightly open. Small timer "3 secondes". French labels: "Position neutre", "Rétropulsion douce", "Recentrage condylien", "Étirement ptérygoïdien latéral". Flat 2D medical illustration.`,
  },
  {
    id: 216,
    nom: 'Étirement des masséters (massage transverse)',
    prompt: `${STYLE} Front view of a face. Both hands schematized (thumbs or index fingers) placed on both sides of the jaw over the masseter muscles. Masseter region highlighted in soft orange on both sides. GREEN vertical arrows pointing DOWN on each side (downward transverse pressure). French labels: "Masséter (serrer les dents pour localiser)", "Pression transversale vers le bas", "30 secondes", "Zones les plus tendues". Flat 2D medical illustration.`,
  },
  {
    id: 217,
    nom: 'Auto-étirement du masséter en ouverture',
    prompt: `${STYLE} 3/4 front view of a head with both thumbs under the chin and both index fingers on the cheeks over the masseter muscles. Mouth wide open (maximum aperture). GREEN downward arrows on index fingers (external massage direction). GREEN downward arrow under chin (mouth opening). French labels: "Pouces sous le menton", "Index sur masséters", "Pression externe vers le bas", "Bouche ouverte au maximum", "20 secondes". Flat 2D medical illustration.`,
  },
  {
    id: 218,
    nom: 'Étirement ptérygoïdien latéral (propulsion forcée)',
    prompt: `${STYLE} Side profile of a head. Jaw in maximum protruded position (lower incisors clearly in front of upper incisors). Fingers of one hand on the chin adding slight forward pressure. GREEN arrow pointing FORWARD on the jaw. Additional GREEN arrow from hand indicating added pressure. French labels: "Propulsion maximale", "Pression manuelle légère", "Ptérygoïdien latéral (étiré)", "20 secondes", "Douceur essentielle". Flat 2D medical illustration.`,
  },
  {
    id: 219,
    nom: 'Étirement ptérygoïdien médial (bouche ouverte latéralisée)',
    prompt: `${STYLE} Front view of a face. Mouth open mid-range, lower jaw shifted clearly to the RIGHT. Left inner jaw region highlighted in orange (ptérygoïdien médial gauche being stretched). GREEN arrow pointing RIGHT at lower jaw level. French labels: "Mi-ouverture", "Latéralité droite", "Ptérygoïdien médial gauche (étiré en orange)", "Angle interne mâchoire gauche", "20 secondes". Flat 2D medical illustration.`,
  },
  {
    id: 220,
    nom: 'Massage du temporal',
    prompt: `${STYLE} Front view of a face. Both palms of hands placed on the temporal regions (sides of head, above ears). Temporal muscle area highlighted in soft yellow-orange on both sides. GREEN circular arrows on both sides showing slow circular movements. French labels: "Région temporale", "Paume de la main", "Mouvements circulaires lents", "30 secondes", "Zone souvent hypertonique (bruxisme, stress)". Flat 2D medical illustration.`,
  },
  {
    id: 221,
    nom: 'Étirement du temporal (bouche ouverte)',
    prompt: `${STYLE} Side profile of a head. Mouth open to maximum aperture. Fingertips placed on the temporal region above the ear. Temporal muscle highlighted in orange. GREEN downward arrow at jaw level (opening). Small lung/breath icon with label "Respiration abdominale lente". French labels: "Bouche ouverte maximum", "Doigts sur temporal", "Muscle temporal (relâchement progressif)", "30 secondes". Flat 2D medical illustration.`,
  },
  {
    id: 222,
    nom: 'Position de repos mandibulaire',
    prompt: `${STYLE} Sagittal cross-section profile of a head, neutral relaxed position. Lips slightly apart (2-3mm gap visible). Tongue flat on palate, tip just behind upper incisors. Visible gap between upper and lower teeth (no contact). Small nose icon with GREEN arrow indicating nasal breathing. French labels: "Langue sur palais (pointe derrière incisives sup.)", "Dents séparées (pas de contact)", "Lèvres légèrement ouvertes 2-3mm", "Respiration nasale", "Position de repos ATM". Flat 2D anatomical cross-section medical illustration.`,
  },
  {
    id: 223,
    nom: 'Respiration nasale diaphragmatique anti-bruxisme',
    prompt: `${STYLE} Side view of person lying on their back. One hand on the abdomen. Partial cross-section showing ribcage and diaphragm. Three sequential phases shown with timers: Phase 1 — nose with GREEN arrow IN, abdomen rises, timer "4s Inspiration". Phase 2 — pause icon, timer "2s Blocage". Phase 3 — nose with GREEN arrow OUT, abdomen falls, timer "6s Expiration". French labels: "Main sur ventre", "Inspiration nasale (ventre gonfle)", "Pause", "Expiration nasale (ventre rentre)", "Mâchoire décontractée, dents séparées". Flat 2D medical illustration.`,
  },
  {
    id: 224,
    nom: 'Auto-massage points trigger masséter',
    prompt: `${STYLE} Front view of a face. Masseter region with 3 orange-red trigger point dots marked. One thumb applying sustained circular pressure on the most sensitive trigger point. GREEN arrow indicating constant maintained pressure. Timer icon showing "60-90 secondes". French labels: "Points trigger masséter (orange)", "Pression constante", "Ischémie-reperfusion", "Serrer les dents pour localiser le masséter", "2-3 points". Flat 2D medical illustration.`,
  },
  {
    id: 225,
    nom: 'Massage crâne et région temporale (auto-drainage)',
    prompt: `${STYLE} Rear/side view of a head. Both hands with fingertips making small circular movements on the scalp. GREEN arrows tracing path from the nape upward toward the temporal regions. Temporal area highlighted in soft orange. French labels: "Bouts des doigts", "De la nuque vers les tempes", "Petits cercles", "Région temporale (orange)", "2 minutes", "Fascias crâniens". Flat 2D medical illustration.`,
  },
  {
    id: 226,
    nom: 'Exercice de coordination lingua-palatine',
    prompt: `${STYLE} Sagittal cross-section profile of a head. Mouth closed. Tongue flat, pressed upward against the palate (suction position). GREEN upward arrow on tongue (suction force against palate). Visible small gap between teeth (no contact). Timer "5 secondes". French labels: "Langue à plat sur palais (aspiration)", "Palais dur", "Dents sans contact", "Tonus lingual correct", "Répéter rythme régulier". Flat 2D anatomical cross-section medical illustration.`,
  },
  {
    id: 227,
    nom: 'Claquement contrôlé de langue (coordination)',
    prompt: `${STYLE} Two side-by-side sagittal cross-section panels. LEFT panel: tongue flat on palate (high position), jaw slightly open. Label "Position initiale : langue sur palais". RIGHT panel: jaw dropping rapidly downward while tongue STAYS on palate. GREEN arrow pointing DOWN on the lower jaw. RED crossed arrow on tongue (tongue must NOT descend). Sound icon (claquement). French labels: "Mandibule s'abaisse rapidement", "Langue reste sur palais (ne descend pas)", "Claquement = bonne dissociation", "Dissociation lingua-mandibulaire". Flat 2D medical illustration.`,
  },
];

async function downloadImage(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);
  return await response.buffer();
}

async function uploadToR2(imageBuffer, filename) {
  const formData = new FormData();
  formData.append('file', imageBuffer, {
    filename,
    contentType: 'image/png',
  });

  const response = await fetch('https://polsia.com/api/proxy/r2/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.POLSIA_API_KEY}`,
      ...formData.getHeaders(),
    },
    body: formData,
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error?.message || 'R2 upload failed');
  }
  return result.file.url;
}

async function main() {
  console.log('=== ATM Exercise Image Generation (22 exercises) ===\n');

  const results = [];

  for (const exercise of EXERCISES) {
    console.log(`\n[${exercise.id}] ${exercise.nom}`);

    try {
      // 1. Generate with DALL-E 3
      console.log('  → DALL-E 3...');
      const imageResponse = await openai.images.generate({
        model: 'dall-e-3',
        prompt: exercise.prompt,
        size: '1024x1024',
        quality: 'standard',
        n: 1,
      });

      const dalleUrl = imageResponse.data[0].url;
      console.log(`  ✓ Generated`);

      // 2. Download
      console.log('  → Downloading...');
      const imageBuffer = await downloadImage(dalleUrl);
      console.log(`  ✓ Downloaded (${Math.round(imageBuffer.length / 1024)}KB)`);

      // 3. Upload to R2
      console.log('  → Uploading to R2...');
      const filename = `atm-exercice-${exercise.id}-${Date.now()}.png`;
      const r2Url = await uploadToR2(imageBuffer, filename);
      console.log(`  ✓ R2: ${r2Url}`);

      // 4. Update database
      await pool.query('UPDATE exercices SET image_url = $1 WHERE id = $2', [r2Url, exercise.id]);
      console.log(`  ✓ DB updated`);

      results.push({ id: exercise.id, nom: exercise.nom, url: r2Url, status: 'success' });

    } catch (err) {
      console.error(`  ✗ ERROR: ${err.message}`);
      results.push({ id: exercise.id, nom: exercise.nom, status: 'error', error: err.message });
    }

    // Delay to avoid DALL-E rate limits
    await new Promise(r => setTimeout(r, 2000));
  }

  await pool.end();

  console.log('\n\n=== RESULTS ===');
  for (const r of results) {
    const icon = r.status === 'success' ? '✅' : '❌';
    console.log(`${icon} [${r.id}] ${r.nom}`);
    if (r.url) console.log(`    URL: ${r.url}`);
    if (r.error) console.log(`    Error: ${r.error}`);
  }

  const successCount = results.filter(r => r.status === 'success').length;
  console.log(`\n${successCount}/${results.length} images generated and uploaded successfully.`);

  // Output JSON for prompts.md generation
  console.log('\n=== JSON (for prompts.md) ===');
  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error('Fatal error:', err);
  pool.end().catch(() => {});
  process.exit(1);
});
