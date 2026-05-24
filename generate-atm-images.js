#!/usr/bin/env node
/**
 * DALL-E 3 Image Generation for ATM Exercises (IDs 206-216)
 * Generates improved medical flat-illustration images and uploads to R2
 */

const OpenAI = require('openai');
const fetch = require('node-fetch');
const FormData = require('form-data');

const openai = new OpenAI();

const POLSIA_API_KEY = process.env.POLSIA_API_KEY;
const R2_URL = 'https://polsia.com/api/proxy/r2/upload';

// First 11 ATM exercises with carefully crafted DALL-E 3 prompts
const exercises = [
  {
    id: 206,
    nom: 'Ouverture mandibulaire avec résistance',
    prompt: `Flat 2D medical illustration, white background, clinical style.
Front view of a patient's face and upper torso in profile (3/4 view).
The patient has their thumb placed under the chin (pushing upward) and index finger on the chin front.
The mouth is open approximately 2 cm.
A green arrow shows the downward jaw opening direction.
A red arrow shows the upward resistance direction of the thumb.
French anatomical labels: "Pouce (résistance vers le haut)", "Index sur le menton", "Ouverture 2 cm".
Bold outlined figures, clean medical illustration style, no shading, flat colors: blue for patient outline, green for correct movement arrows, red for resistance arrows. No text except labels.`
  },
  {
    id: 207,
    nom: 'Diduction mandibulaire (latéralité)',
    prompt: `Flat 2D medical illustration, white background, clinical style.
Front view of a simplified face showing the jaw (mandible) moving laterally.
The illustration shows two positions: neutral (center, in light gray) and displaced right and left (in blue).
The mouth is slightly open 1-2 cm.
Green double-headed horizontal arrow showing lateral movement (latéralité droite ↔ latéralité gauche).
French anatomical labels: "Position neutre", "Diduction droite", "Diduction gauche", "Dents séparées".
Bold outlines, flat medical illustration style, no photorealism, clean and clinical.`
  },
  {
    id: 208,
    nom: 'Auto-massage intra-buccal du ptérygoïdien médial',
    prompt: `Flat 2D medical illustration, white background, clinical style.
Side profile view of a patient with mouth wide open (bâillement/yawn position).
The right index finger is shown entering the cheek on the inside, behind the lower molars.
A small circular arrow (green) indicates the circular massage motion on the inner cheek wall.
A highlighted zone in orange shows the location of the ptérygoïdien médial muscle inside the cheek.
French anatomical labels: "Index droit (intérieur joue)", "Ptérygoïdien médial", "Petits cercles", "Derrière les molaires inférieures".
Bold outlines, flat colors, clinical and clean medical illustration.`
  },
  {
    id: 209,
    nom: 'Exercice de stabilisation mandibulaire (langue haut, yeux ouverts)',
    prompt: `Flat 2D medical illustration, white background, clinical style.
Front-facing head illustration showing mouth open vertically with a straight vertical green arrow indicating correct straight jaw opening trajectory.
A red X arrow shows sideways deviation to avoid.
Inside the mouth, the tongue is shown touching the palate (roof of mouth) just behind the upper incisors, indicated by a blue dot and dashed line.
A small mirror icon in the corner symbolizes watching your reflection.
French anatomical labels: "Langue sur le palais", "Trajectoire verticale", "Pas de déviation", "Ouverture contrôlée".
Bold outlines, flat 2D colors, simple and clean clinical illustration.`
  },
  {
    id: 210,
    nom: 'Correction posturale cervico-mandibulaire',
    prompt: `Flat 2D medical illustration, white background, clinical style.
Side profile of a seated patient showing two simultaneous actions:
1) A green curved arrow at the neck showing gentle cervical retraction (chin pulled slightly back, not downward)
2) A relaxed jaw shown with a small gap between teeth (dents séparées)
The tongue is shown on the palate (blue dot).
The posture is upright in a chair.
French anatomical labels: "Rétraction cervicale douce", "Mâchoire relâchée", "Dents séparées (2mm)", "Langue sur palais", "10 secondes".
Bold outlines, flat colors, clean medical style.`
  },
  {
    id: 211,
    nom: 'Ouverture mandibulaire contrôlée',
    prompt: `Flat 2D medical illustration, white background, clinical style.
Front view of a face showing jaw opening straight down with a guide finger on the chin for alignment.
A green straight vertical arrow shows the correct downward trajectory.
The tongue is shown pressed against the palate (blue marker).
A small dashed outline shows the maximum opening position reached.
French anatomical labels: "Doigt guide sur le menton", "Langue sur le palais", "Trajectoire centrale", "Amplitude maximale sans douleur", "2 secondes".
Bold outlines, flat 2D medical illustration, clean and clinical.`
  },
  {
    id: 212,
    nom: 'Fermeture mandibulaire résistée',
    prompt: `Flat 2D medical illustration, white background, clinical style.
Front view of a patient with mouth open approximately 2 cm.
Fingers are placed on the lower molars applying downward pressure (red downward arrows showing resistance).
A green upward arrow shows the jaw closing direction against resistance.
French anatomical labels: "Doigts sur molaires inférieures", "Résistance vers le bas", "Fermeture (isométrique)", "5 secondes", "Muscles élévateurs".
Bold outlines, flat colors, clinical medical illustration, no photorealism.`
  },
  {
    id: 213,
    nom: 'Diduction avec résistance latérale',
    prompt: `Flat 2D medical illustration, white background, clinical style.
Front view of a face with a finger pressing on the side of the chin.
A green horizontal arrow shows the jaw pushing toward the resisting finger.
A red arrow shows the finger resistance direction (opposite).
Two panels shown side by side: left panel (résistance droite) and right panel (résistance gauche).
French anatomical labels: "Doigt sur côté menton", "Résistance latérale", "Diduction contre résistance (isométrique)", "5 secondes", "Ptérygoïdien latéral".
Bold outlines, flat 2D illustration, clean clinical style.`
  },
  {
    id: 214,
    nom: 'Propulsion mandibulaire',
    prompt: `Flat 2D medical illustration, white background, clinical style.
Side profile view showing two jaw positions:
1) Neutral jaw position (light gray outline)
2) Protruded jaw position where lower incisors protrude beyond upper incisors (blue solid)
A green horizontal forward arrow shows the propulsion movement direction.
French anatomical labels: "Position neutre", "Propulsion (avancée de la mâchoire)", "Incisives inférieures en avant", "2 secondes", "Ptérygoïdien latéral".
Bold outlines, flat 2D colors, clean clinical medical illustration.`
  },
  {
    id: 215,
    nom: 'Rétropulsion mandibulaire douce',
    prompt: `Flat 2D medical illustration, white background, clinical style.
Side profile view showing jaw retraction movement.
Two positions: neutral (light gray) and retracted jaw position (blue solid, chin slightly pulled back).
A green horizontal backward arrow (pointing toward the ear/posterior) shows the retraction direction.
Upright seated posture, mouth slightly open.
French anatomical labels: "Position neutre", "Rétropulsion douce", "Mâchoire reculée", "3 secondes", "Recentrage condylien".
Bold outlines, flat 2D medical illustration, clinical and clean style.`
  },
  {
    id: 216,
    nom: 'Étirement des masséters (massage transverse)',
    prompt: `Flat 2D medical illustration, white background, clinical style.
Front view of a face with both masseter muscles highlighted in orange on each cheek (prominent jaw muscle areas).
Thumbs or index fingers pressing on each masseter with downward transverse arrows showing the massage direction.
Small circular arrows indicate the masseter location and pressure direction.
French anatomical labels: "Masséter (droit)", "Masséter (gauche)", "Pression transverse (haut→bas)", "30 secondes", "Zone hypertonique".
Bold outlines, flat 2D colors, clean clinical medical illustration.`
  }
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

  const response = await fetch(R2_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${POLSIA_API_KEY}`,
      ...formData.getHeaders(),
    },
    body: formData,
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error?.message || 'Upload failed');
  }
  return result.file.url;
}

async function generateAndUpload(exercise) {
  console.log(`\n[${exercise.id}] Generating: ${exercise.nom}`);

  try {
    // Generate with DALL-E 3
    const image = await openai.images.generate({
      model: 'dall-e-3',
      prompt: exercise.prompt,
      size: '1024x1024',
      quality: 'standard',
    });

    const imageUrl = image.data[0].url;
    console.log(`  ✓ Generated image URL`);

    // Download the image
    const imageBuffer = await downloadImage(imageUrl);
    console.log(`  ✓ Downloaded ${imageBuffer.length} bytes`);

    // Upload to R2
    const r2Url = await uploadToR2(imageBuffer, `atm-exercice-${exercise.id}.png`);
    console.log(`  ✓ Uploaded to R2: ${r2Url}`);

    return { id: exercise.id, url: r2Url, prompt: exercise.prompt };
  } catch (err) {
    console.error(`  ✗ Error for exercise ${exercise.id}: ${err.message}`);
    return { id: exercise.id, url: null, error: err.message };
  }
}

async function main() {
  if (!POLSIA_API_KEY) {
    throw new Error('POLSIA_API_KEY is required');
  }

  console.log(`Starting ATM image generation for ${exercises.length} exercises...`);

  const results = [];

  // Process one at a time to avoid rate limits
  for (const exercise of exercises) {
    const result = await generateAndUpload(exercise);
    results.push(result);
    // Small delay to be kind to the API
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Print summary
  console.log('\n=== RESULTS ===');
  const successes = results.filter(r => r.url);
  const failures = results.filter(r => !r.url);

  console.log(`Success: ${successes.length}/${results.length}`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  ID ${f.id}: ${f.error}`));
  }

  // Output JSON for DB update script
  console.log('\n=== DB UPDATE DATA ===');
  console.log(JSON.stringify(successes.map(r => ({ id: r.id, url: r.url })), null, 2));

  // Output prompts for prompts.md
  console.log('\n=== PROMPTS.MD CONTENT ===');
  results.forEach(r => {
    const ex = exercises.find(e => e.id === r.id);
    console.log(`\n### Exercice ${r.id}: ${ex.nom}`);
    console.log(`**Status:** ${r.url ? '✅ Success' : '❌ Failed'}`);
    if (r.url) console.log(`**Image URL:** ${r.url}`);
    console.log(`**Prompt:**\n\`\`\`\n${ex.prompt}\n\`\`\``);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
