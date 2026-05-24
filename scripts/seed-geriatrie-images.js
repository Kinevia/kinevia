/**
 * Seed images for geriatrie exercises (migration 051)
 * Generates DALL-E 3 images and uploads to R2, then updates DB.
 *
 * Usage: node scripts/seed-geriatrie-images.js
 */

require('dotenv').config();
const OpenAI = require('openai');
const { Pool } = require('pg');

const openai = new OpenAI();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// R2 upload helper (same pattern as other seed scripts)
async function uploadToR2(imageUrl, filename) {
  const r2Base = process.env.POLSIA_R2_BASE_URL;
  if (!r2Base) throw new Error('POLSIA_R2_BASE_URL not set');

  // Fetch the DALL-E temp URL
  const imgResp = await fetch(imageUrl);
  if (!imgResp.ok) throw new Error('Failed to fetch image from OpenAI: ' + imgResp.status);
  const blob = await imgResp.arrayBuffer();

  const formData = new FormData();
  formData.append('file', new Blob([blob], { type: 'image/png' }), filename);

  const uploadResp = await fetch(`${r2Base}/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.POLSIA_R2_API_KEY || process.env.POLSIA_API_KEY || ''}` },
    body: formData,
  });

  if (!uploadResp.ok) {
    const text = await uploadResp.text();
    throw new Error('R2 upload failed: ' + uploadResp.status + ' — ' + text);
  }

  const data = await uploadResp.json();
  // Per skill: extract data.file.url NOT data.url
  return data.file?.url || data.url;
}

const exercises = [
  {
    nom: 'Appui unipodal yeux ouverts',
    prompt: 'Flat medical illustration, clean white background. Elderly person (70s) standing on one foot next to a chair for safety support. Side view, stable balanced posture, looking forward at a fixed point. Minimalist style, teal and white color scheme, no text, professional physiotherapy illustration.',
  },
  {
    nom: 'Appui unipodal yeux fermés',
    prompt: 'Flat medical illustration, clean white background. Elderly person (70s) standing on one foot with eyes closed, hands slightly raised for balance, near a wall. Calm focused expression. Minimalist style, teal and white color scheme, no text, professional physiotherapy illustration.',
  },
  {
    nom: 'Marche talon-pointe en ligne droite',
    prompt: 'Flat medical illustration, clean white background. Elderly person (70s) walking heel-to-toe along a straight line on the floor, arms slightly out for balance, looking forward. Top or 3/4 view showing the tandem foot placement. Minimalist style, teal and white color scheme, no text, professional physiotherapy illustration.',
  },
  {
    nom: 'Marche en tandem le long d\'un mur',
    prompt: 'Flat medical illustration, clean white background. Elderly person (70s) walking tandem (heel-to-toe) along a wall, fingertips lightly touching the wall for security. Side view. Minimalist style, teal and white color scheme, no text, professional physiotherapy illustration.',
  },
  {
    nom: 'Transfert assis-debout (Sit-to-Stand x5)',
    prompt: 'Flat medical illustration, clean white background. Sequence showing elderly person (70s) rising from a chair without using armrests: leaning forward then standing upright. Side view, two-phase illustration. Minimalist style, teal and white color scheme, no text, professional physiotherapy illustration.',
  },
  {
    nom: 'Transfert assis-debout avec pause debout (équilibre)',
    prompt: 'Flat medical illustration, clean white background. Elderly person (70s) standing upright next to a chair, maintaining balance with hands free, pausing after standing up. Confident posture. Minimalist style, teal and white color scheme, no text, professional physiotherapy illustration.',
  },
  {
    nom: 'Montée de marche adaptée (step-up bas)',
    prompt: 'Flat medical illustration, clean white background. Elderly person (70s) stepping up onto a low step (15cm), one foot on the step, holding a handrail for safety. Side view, controlled movement. Minimalist style, teal and white color scheme, no text, professional physiotherapy illustration.',
  },
  {
    nom: 'Step-up latéral avec pause d\'équilibre',
    prompt: 'Flat medical illustration, clean white background. Elderly person (70s) performing a lateral step-up onto a low platform, pausing in single-leg balance at the top. Front view. Minimalist style, teal and white color scheme, no text, professional physiotherapy illustration.',
  },
  {
    nom: 'Debout sur coussin de mousse (bipodal)',
    prompt: 'Flat medical illustration, clean white background. Elderly person (70s) standing on a foam pad/cushion with both feet, arms slightly out for balance, near a wall. Side view, stable posture. Minimalist style, teal and white color scheme, no text, professional physiotherapy illustration.',
  },
  {
    nom: 'Appui unipodal sur coussin de mousse',
    prompt: 'Flat medical illustration, clean white background. Elderly person (70s) standing on one foot on a foam balance pad, near a wall for safety. Concentrated posture. Minimalist style, teal and white color scheme, no text, professional physiotherapy illustration.',
  },
  {
    nom: 'Enjambement d\'obstacles au sol (cônes/bouteilles)',
    prompt: 'Flat medical illustration, clean white background. Elderly person (70s) stepping over small cones placed on the floor, lifting knee high, walking through an obstacle course. Side view. Minimalist style, teal and white color scheme, no text, professional physiotherapy illustration.',
  },
  {
    nom: 'Parcours de marche avec changements de direction',
    prompt: 'Flat medical illustration, clean white background. Elderly person (70s) making a 180-degree turn during a walking exercise, with floor markers visible. Top-down view showing the path. Minimalist style, teal and white color scheme, no text, professional physiotherapy illustration.',
  },
  {
    nom: 'Relevé du sol avec appui (technique sécurisée)',
    prompt: 'Flat medical illustration, clean white background. Step-by-step sequence: elderly person rolling from lying on the floor, kneeling, then using a chair to stand up safely. Three phases shown. Side view. Minimalist style, teal and white color scheme, no text, professional physiotherapy illustration.',
  },
  {
    nom: 'Relevé du sol sans appui (technique avancée)',
    prompt: 'Flat medical illustration, clean white background. Sequence showing elderly person getting up from the floor without assistance: rolling to side, going to all-fours, lunging up to standing. Side view multi-phase. Minimalist style, teal and white color scheme, no text, professional physiotherapy illustration.',
  },
  {
    nom: 'Marche avec double tâche verbale (comptage régressif)',
    prompt: 'Flat medical illustration, clean white background. Elderly person (70s) walking in a corridor while counting aloud, thought bubble showing numbers. Dual-task concept. Slightly 3/4 view. Minimalist style, teal and white color scheme, no text, professional physiotherapy illustration.',
  },
  {
    nom: 'Équilibre debout avec double tâche cognitive',
    prompt: 'Flat medical illustration, clean white background. Elderly person (70s) standing in semi-tandem balance position while a physiotherapist asks questions. Dual attention concept illustrated. Minimalist style, teal and white color scheme, no text, professional physiotherapy illustration.',
  },
  {
    nom: 'Marche avec double tâche motrice (plateau/verre)',
    prompt: 'Flat medical illustration, clean white background. Elderly person (70s) walking carefully while holding a tray with a glass of water, focused expression. Side view. Minimalist style, teal and white color scheme, no text, professional physiotherapy illustration.',
  },
  {
    nom: 'Renforcement du tibial antérieur en position assise (heel raises)',
    prompt: 'Flat medical illustration, clean white background. Elderly person (70s) seated on a chair, lifting toes and forefoot upward (dorsiflexion) while heels stay on floor. Side view, showing ankle movement detail. Minimalist style, teal and white color scheme, no text, professional physiotherapy illustration.',
  },
  {
    nom: 'Renforcement fessier moyen debout (abduction hanche)',
    prompt: 'Flat medical illustration, clean white background. Elderly person (70s) standing next to a chair, lifting one leg sideways (hip abduction) in a controlled motion. Side/front 3/4 view showing hip and glute activation. Minimalist style, teal and white color scheme, no text, professional physiotherapy illustration.',
  },
  {
    nom: 'Exercice de Romberg et Romberg sensibilisé',
    prompt: 'Flat medical illustration, clean white background. Elderly person (70s) standing with feet together, arms crossed on chest, eyes closed (Romberg test position). Calm, concentrated posture. Minimalist style, teal and white color scheme, no text, professional physiotherapy illustration.',
  },
  {
    nom: 'Transfert de poids latéral (poids d\'un pied à l\'autre)',
    prompt: 'Flat medical illustration, clean white background. Elderly person (70s) shifting weight side to side between feet in a standing position, slightly lifting one foot, hands lightly on a chair. Front view showing weight shift arrows. Minimalist style, teal and white color scheme, no text, professional physiotherapy illustration.',
  },
];

async function main() {
  console.log(`[geriatrie-images] Starting image generation for ${exercises.length} exercises...`);

  // First check which ones already have images
  const client = await pool.connect();
  try {
    const existing = await client.query(
      `SELECT nom, image_url FROM exercices WHERE zone_corporelle = 'geriatrie'`
    );
    const withImages = new Set(existing.rows.filter(r => r.image_url).map(r => r.nom));
    const withoutImages = exercises.filter(e => !withImages.has(e.nom));

    console.log(`[geriatrie-images] ${withImages.size} already have images, ${withoutImages.length} need generation`);

    for (let i = 0; i < withoutImages.length; i++) {
      const ex = withoutImages[i];
      console.log(`[geriatrie-images] [${i + 1}/${withoutImages.length}] Generating: ${ex.nom}`);

      try {
        // Generate image
        const image = await openai.images.generate({
          model: 'dall-e-3',
          prompt: ex.prompt,
          size: '1024x1024',
        });
        const tempUrl = image.data[0].url;

        // Upload to R2
        const slug = ex.nom
          .toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .substring(0, 60);
        const filename = `exercise-geriatrie-${slug}-${Date.now()}.png`;
        const r2Url = await uploadToR2(tempUrl, filename);

        // Update DB
        await client.query(
          `UPDATE exercices SET image_url = $1 WHERE nom = $2 AND zone_corporelle = 'geriatrie'`,
          [r2Url, ex.nom]
        );
        console.log(`[geriatrie-images]   -> OK: ${r2Url}`);

        // Small delay to avoid rate limits
        if (i < withoutImages.length - 1) {
          await new Promise(r => setTimeout(r, 1200));
        }
      } catch (err) {
        console.error(`[geriatrie-images]   -> ERROR for "${ex.nom}":`, err.message);
      }
    }

    // Final count
    const final = await client.query(
      `SELECT COUNT(*) as total, COUNT(image_url) as with_images FROM exercices WHERE zone_corporelle = 'geriatrie'`
    );
    console.log(`[geriatrie-images] Done. ${final.rows[0].with_images}/${final.rows[0].total} exercises have images.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('[geriatrie-images] Fatal error:', err);
  process.exit(1);
});
