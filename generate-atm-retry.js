#!/usr/bin/env node
/**
 * Retry for exercises 206, 209, 212 with safer prompts
 */

const OpenAI = require('openai');
const fetch = require('node-fetch');
const FormData = require('form-data');

const openai = new OpenAI();
const POLSIA_API_KEY = process.env.POLSIA_API_KEY;
const R2_URL = 'https://polsia.com/api/proxy/r2/upload';

const exercises = [
  {
    id: 206,
    nom: 'Ouverture mandibulaire avec résistance',
    prompt: `Flat 2D medical diagram, white background, clinical educational style.
A schematic side-view illustration of a human head showing jaw exercise technique.
One hand positioned below the chin providing upward resistance, another hand on chin front.
The jaw is slightly open showing controlled movement.
Movement arrows: green downward arrow (jaw opening), red upward arrow (resistance force).
Labels in French: "Résistance isométrique", "Ouverture contrôlée 2cm", "Maintien 5 secondes".
Simple flat line art, no shading, anatomical diagram style like a physiotherapy textbook.`
  },
  {
    id: 209,
    nom: 'Exercice de stabilisation mandibulaire',
    prompt: `Flat 2D medical educational diagram, white background, clinical style.
Schematic front-view illustration of a human face showing controlled jaw opening exercise.
The diagram shows: mouth opening in a straight vertical line (green arrow pointing down), a dotted line indicating correct straight trajectory, and a small X mark showing deviation to avoid.
Inside mouth diagram shows tongue position on palate indicated by a small dot.
A simple mirror outline in corner symbolizes self-monitoring.
Labels in French: "Ouverture verticale", "Pas de déviation", "Langue sur palais".
Simple anatomical line art style, flat colors, educational physiotherapy diagram.`
  },
  {
    id: 212,
    nom: 'Fermeture mandibulaire résistée',
    prompt: `Flat 2D medical educational diagram, white background, clinical style.
Schematic front-view illustration of human jaw exercise for physiotherapy.
The diagram shows a slightly open mouth (2cm gap) with fingers depicted symbolically as rectangles on lower teeth area.
Red downward arrows indicate resistance force direction on lower jaw.
Green upward arrow shows jaw closing direction against resistance.
Labels in French: "Doigts sur molaires inférieures", "Résistance vers le bas", "Isométrique 5 sec", "Muscles élévateurs".
Simple flat line art, educational diagram style, no photorealism, anatomical textbook style.`
  }
];

async function downloadImage(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download: ${response.status}`);
  return await response.buffer();
}

async function uploadToR2(imageBuffer, filename) {
  const formData = new FormData();
  formData.append('file', imageBuffer, { filename, contentType: 'image/png' });

  const response = await fetch(R2_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${POLSIA_API_KEY}`,
      ...formData.getHeaders(),
    },
    body: formData,
  });

  const result = await response.json();
  if (!result.success) throw new Error(result.error?.message || 'Upload failed');
  return result.file.url;
}

async function main() {
  const results = [];

  for (const exercise of exercises) {
    console.log(`\n[${exercise.id}] Generating: ${exercise.nom}`);
    try {
      const image = await openai.images.generate({
        model: 'dall-e-3',
        prompt: exercise.prompt,
        size: '1024x1024',
        quality: 'standard',
      });

      const imageUrl = image.data[0].url;
      console.log(`  ✓ Generated`);

      const buf = await downloadImage(imageUrl);
      console.log(`  ✓ Downloaded ${buf.length} bytes`);

      const r2Url = await uploadToR2(buf, `atm-exercice-${exercise.id}.png`);
      console.log(`  ✓ Uploaded: ${r2Url}`);

      results.push({ id: exercise.id, url: r2Url });
    } catch (err) {
      console.error(`  ✗ Error: ${err.message}`);
      results.push({ id: exercise.id, url: null, error: err.message });
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('\n=== RESULTS ===');
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);
