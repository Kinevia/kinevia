#!/usr/bin/env node
/**
 * Generate DALL-E 3 images for 15 most-prescribed exercises (Batch 2)
 * Batch 1 covered: Pendulaire Codman, Rotation externe épaule ×2, Quadriceps chaise,
 *   Étirement ischio-jambiers, Squat mural, Gainage planche + latéral + bird-dog,
 *   Pont fessier, Abduction hanche, Étirement mollet, Flexion-extension cervicale,
 *   Rotation cervicale, Chin tuck.
 * Batch 2 targets the next 15 most-prescribed exercises without images.
 * Generated: 2026-05-10
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
    id: 157,
    nom: 'Nageur couché (Superman)',
    prompt: `${STYLE} Person lying face-down (prone) on a mat. Both arms extended overhead and both legs straight. Simultaneously, both arms lift upward and both legs lift upward off the mat, arching the back gently (superman flying position). GREEN upward arrows on both arms and both legs showing the lift direction. Small dashed outline shows the starting flat position. French labels: "Décubitus ventral", "Bras tendus devant", "Jambes tendues", "Élévation simultanée bras+jambes", "Maintien 3-5 secondes", "Extenseurs du rachis (renforcement)". Flat 2D medical illustration.`,
  },
  {
    id: 162,
    nom: 'Mobilisation thoracique en rotation assise',
    prompt: `${STYLE} Person seated on a chair or stool, upright posture, arms crossed over chest (hands on opposite shoulders). Two overlaid positions: faint (facing forward) and solid (trunk rotated to the RIGHT ~45°). GREEN curved arrow showing rightward rotation at thoracic level. Lumbar spine area marked with "Bas du dos stable" with small lock icon. Green arrow also shows mirror rotation to the left in a secondary dashed panel. French labels: "Bras croisés sur épaules", "Rotation thoracique droite puis gauche", "Rachis lombaire stabilisé", "Ampleur progressive", "Retour lent". Flat 2D medical illustration.`,
  },
  {
    id: 163,
    nom: 'Extension thoracique sur rouleau',
    prompt: `${STYLE} Person lying on their back (supine) on a mat. A foam roller (cylindrical, shown in cross-section) is positioned horizontally under the thoracic spine at mid-back level. Arms loosely folded over chest or extended overhead. Back extending gently over the roller, creating a gentle thoracic extension. GREEN downward curved arrow showing back relaxing over the roller. Dashed line showing neutral spine vs. extended position. French labels: "Rouleau en mousse", "Zone thoracique (T4-T8)", "Extension gravitaire douce", "Bras croisés ou derrière tête", "30 secondes par segment", "Mobilisation thoracique passive". Flat 2D medical illustration.`,
  },
  {
    id: 165,
    nom: 'Gainage latéral genoux au sol',
    prompt: `${STYLE} Person in modified side plank position. Bottom knee bent at 90° touching the ground, bottom elbow on ground directly below shoulder. Body forms a diagonal straight line from bent knee to head. Top arm along the body or on hip. Hips lifted off the ground. GREEN upward arrow at hip level showing lift direction. Correct body alignment shown with a straight dashed diagonal line. French labels: "Appui coude-avant-bras", "Genou fléchi au sol", "Hanches soulevées", "Corps aligné", "Grand fessier + moyen fessier + obliques", "30 secondes". Flat 2D medical illustration.`,
  },
  {
    id: 166,
    nom: 'Cat-Cow thoracique ciblé',
    prompt: `${STYLE} Two side-by-side panels showing quadruped position (hands and knees). LEFT panel labeled "Chat (flexion)": spine rounds upward, head drops, thoracic spine prominently arched UP — GREEN upward curved arrow on thoracic spine, blue label "Expiration". RIGHT panel labeled "Vache (extension)": thoracic spine extends downward with a gentle arch, head neutral — GREEN downward curved arrow on thoracic spine, blue label "Inspiration". Both panels show hips stable. French labels: "Position 4 appuis", "Mouvement thoracique ciblé", "Rachis lombaire neutre", "Chat : expiration + flexion thoracique", "Vache : inspiration + extension thoracique". Flat 2D medical illustration.`,
  },
  {
    id: 168,
    nom: 'Dead bug',
    prompt: `${STYLE} Person lying on their back (supine), lower back pressed against the mat (lumbar spine flat). Both arms pointing straight up toward the ceiling and both knees raised with hips and knees at 90°. Movement shown: RIGHT arm extends overhead (GREEN downward arrow) while LEFT leg extends out straight (GREEN forward arrow) — simultaneously, both approaching the mat level. Contralateral coordination. RED crossed arrow on lumbar spine showing "ne pas décoller le dos". French labels: "Bras vers le plafond", "Genoux à 90°", "Dos plaqué au sol", "Extension bras/jambe opposés", "Coordination contralaterale", "Transverse de l'abdomen". Flat 2D medical illustration.`,
  },
  {
    id: 184,
    nom: 'Terminal extension du genou (TKE)',
    prompt: `${STYLE} Person standing, side view. An elastic resistance band looped around the back of the bent knee (approximately 30° of knee flexion). The person extends the knee to full extension against the band resistance. GREEN arrow showing knee moving to full extension. RED arrow showing band resistance pulling knee back into flexion. Small detail circle showing the band placement behind the knee. French labels: "Élastique derrière le genou", "Extension terminale (30° → 0°)", "Résistance élastique", "Vaste interne (VMO)", "Contraction isométrique finale 2s", "Genou chaud, pas de douleur". Flat 2D medical illustration.`,
  },
  {
    id: 185,
    nom: 'Step-up latéral',
    prompt: `${STYLE} Person standing sideways next to a low step (15-20cm high). Leading leg steps up sideways onto the step: sequence shown in two positions — standing beside step (faint silhouette) and foot fully planted on step with opposite leg lifting clear of the ground (solid). GREEN upward arrow on leading leg. Correct hip and knee alignment shown with dashed vertical line. Pelvis level maintained — small pelvis icon with level symbol. French labels: "Marche latérale 15-20 cm", "Pied entier sur la marche", "Genou dans l'axe du pied (pas en dedans)", "Moyen fessier + quadriceps", "Descente contrôlée (excentrique)". Flat 2D medical illustration.`,
  },
  {
    id: 186,
    nom: 'Renforcement du vaste interne (VMO)',
    prompt: `${STYLE} Person seated on edge of chair or bench. Leg extended, foot slightly turned outward (10-15°). Towel roll under knee for slight flexion (~10°). Thigh muscles contracting: vastus medialis (VMO) area highlighted in orange on inner thigh above knee. GREEN arrow showing leg extending/lifting slightly. Dashed line showing VMO muscle belly outline. Small timer "5 secondes contraction + 5s relâche". French labels: "Position assise, jambe en extension", "Pied légèrement en rotation externe", "Vaste interne oblique (VMO, orange)", "Contraction isométrique 5s", "Rouleau sous le genou", "Genou à 10°-20°". Flat 2D medical illustration.`,
  },
  {
    id: 187,
    nom: 'Pont fessier unilatéral sur balle',
    prompt: `${STYLE} Person lying on their back (supine). Both heels resting on a Swiss ball/exercise ball. One leg bent at ~45° with foot on ball, the other leg raised straight in the air. Hips lifting off the mat via one-leg bridge. GREEN upward arrow at hip level. RED arrow on raised leg indicating it stays lifted. Body forms a diagonal from shoulder to working knee. French labels: "Talons sur ballon suisse", "Pont unijambiste", "Une jambe en extension dans les airs", "Grand fessier + ischio-jambiers", "Hanches alignées (ne pas basculer)", "Maintien 3s, 10 répétitions". Flat 2D medical illustration.`,
  },
  {
    id: 190,
    nom: 'Renforcement des extenseurs du dos en position genoux-mains',
    prompt: `${STYLE} Person in quadruped position (hands and knees on mat). Neutral spine maintained. Movement: RIGHT arm extends forward (horizontal) and LEFT leg extends backward (horizontal) simultaneously — bird-dog variation. GREEN arrow on extended arm (forward direction) and GREEN arrow on extended leg (backward direction). Small level indicator on pelvis showing pelvis must stay level. Incorrect version (small inset, red border): leg raising too high, lumbar spine hyperextending — RED X. French labels: "Position 4 appuis, dos neutre", "Extension bras opposé + jambe opposée", "Bassin horizontal (ne pas tourner)", "Extenseurs lombaires + fessiers", "Maintien 5 secondes", "Retour lent et contrôlé". Flat 2D medical illustration.`,
  },
  {
    id: 191,
    nom: 'Étirement du piriforme (sciatique)',
    prompt: `${STYLE} Two panels. LEFT panel: Person lying on back, both legs flat. Right knee bent and pulled toward chest, right ankle crossed over left knee (figure-4 position / pigeon stretch). Hands either behind left thigh pulling it toward chest or both hands interlaced. Right hip region highlighted in orange (piriformis). GREEN arrow showing right knee being pushed gently away and left thigh pulling toward chest. French label: "Cheville droite sur genou gauche (figure 4)". RIGHT panel: Alternative seated chair version — same figure-4 position while seated. French labels overall: "Piriforme droit (orange)", "Pression douce genou extérieur", "Tirer la cuisse vers la poitrine", "30 secondes", "Nerf sciatique soulagé". Flat 2D medical illustration.`,
  },
  {
    id: 195,
    nom: 'Renforcement serratus anterior (push-up plus)',
    prompt: `${STYLE} Two-panel side view. LEFT panel: Standard push-up position (hands and toes, arms straight). RIGHT panel: From the locked-out push-up, the thoracic spine rounds FURTHER upward — scapulas spreading wide (protraction). Small RED scapular outlines showing starting position vs. final protracted position. GREEN upward arrow on thoracic spine showing the extra "plus" push. Serratus anterior muscle highlighted in orange on the side of the ribcage. French labels: "Position pompe bras tendus", "Phase 'plus': poussée scapulaire supplémentaire", "Scapulas s'écartent (protraction)", "Serratus anterior (orange, côtés des côtes)", "Maintien 2 secondes au sommet", "Décollement scapulaire évité". Flat 2D medical illustration.`,
  },
  {
    id: 196,
    nom: 'Abduction de hanche latérale debout avec élastique',
    prompt: `${STYLE} Person standing, one hand on wall or chair for balance. An elastic resistance band looped around both ankles. One leg (working leg) abducts outward to the side — approximately 30-40° of hip abduction. Supporting leg remains planted. GREEN arrow showing working leg moving outward. RED arrow showing band resistance pulling leg back inward. Gluteus medius area highlighted in orange on the working hip. French labels: "Élastique aux chevilles", "Abduction de hanche (30-45°)", "Appui latéral main au mur", "Moyen fessier (orange)", "Genou en légère flexion, dos droit", "15 répétitions, 3 séries". Flat 2D medical illustration.`,
  },
  {
    id: 200,
    nom: 'Rétraction cervicale (chin tuck)',
    prompt: `${STYLE} Side profile of a person seated or standing upright. Two positions: faint (head in forward-head posture, chin jutting forward) and solid (chin tucked back, creating a gentle double-chin, back of head aligns over shoulders). GREEN horizontal backward arrow at chin level showing retraction direction. Small dashed vertical line showing ideal ear-over-shoulder alignment. Incorrect position (faint) labeled "Avant: tête projetée en avant". Correct position (solid) labeled "Après: rétraction cervicale". Small circles showing deep cervical flexors activation at the front of neck. French labels: "Rétraction cervicale (chin tuck)", "Oreille au-dessus de l'épaule", "Fléchisseurs cervicaux profonds", "10 répétitions, 10 secondes maintien", "Ne pas incliner la tête (rétraction pure)". Flat 2D medical illustration.`,
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
  console.log('=== Exercise Image Generation — Batch 2 (15 exercises) ===\n');

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
      const filename = `exercice-batch2-${exercise.id}-${Date.now()}.png`;
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

    // Delay to respect DALL-E rate limits
    await new Promise(r => setTimeout(r, 2500));
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
}

main().catch(err => {
  console.error('Fatal error:', err);
  pool.end().catch(() => {});
  process.exit(1);
});
