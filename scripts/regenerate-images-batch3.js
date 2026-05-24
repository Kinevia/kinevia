#!/usr/bin/env node
/**
 * Generate DALL-E 3 images for 15 most-prescribed exercises (Batch 3)
 * Batch 1 covered: Pendulaire Codman, Rotation externe épaule ×2, Quadriceps chaise,
 *   Étirement ischio-jambiers, Squat mural, Gainage planche + latéral + bird-dog,
 *   Pont fessier, Abduction hanche, Étirement mollet, Flexion-extension cervicale,
 *   Rotation cervicale, Chin tuck.
 * Batch 2 targeted: IDs 157,162,163,165,166,168,184,185,186,187,190,191,195,196,200.
 * Batch 3 targets the next 15 most-prescribed exercises without images.
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
    id: 164,
    nom: 'Étirements en ouverture thoracique',
    prompt: `${STYLE} Person standing in a doorway frame (two vertical posts visible on left and right). Both arms raised to shoulder height, elbows bent at 90°, forearms resting against the door posts (cactus arm position). Chest opening forward with GREEN forward arrow at sternum level. Dashed vertical alignment line showing chest protruding through the doorway. Pectoral/chest region highlighted with orange shading. French labels: "Cadre de porte", "Bras en U à 90°", "Avant-bras sur le chambranle", "Ouverture pectorale + thoracique", "Légèrement en avant (poids du corps)", "30 secondes, respiration profonde". Flat 2D medical illustration.`,
  },
  {
    id: 167,
    nom: 'Rotation thoracique en décubitus latéral',
    prompt: `Flat 2D medical illustration, pure white background, clinical diagram style. Schematic side-view anatomical diagram. Figure shown lying on their side on a mat. Both knees stacked and bent at 90° (knees remain stacked). Top arm sweeps in a large arc from resting over the bottom arm (faint outline) to opening out to the opposite side (solid position), creating thoracic rotation. GREEN curved arc arrow showing the arm's rotation path. Spine area at thoracic level highlighted teal with small rotation symbol. French labels: "Décubitus latéral", "Genoux fléchis superposés", "Bras supérieur en rotation", "Arc de mouvement thoracique", "Hanches restent en place", "30 secondes à la limite". Anatomical schematic diagram.`,
  },
  {
    id: 169,
    nom: 'Gainage latéral avec élévation de hanche',
    prompt: `${STYLE} Person in full side plank position (elbow on floor, feet stacked or slightly offset). Two overlaid positions: faint showing hips lowered toward floor, solid showing hips elevated back to full side plank alignment. GREEN upward arc arrow at hip showing the elevation movement. Dashed diagonal alignment line from feet through hip to shoulder. Oblique abdominal region on the working side highlighted in orange. French labels: "Planche latérale complète", "Appui pied + avant-bras", "Hanches s'abaissent légèrement", "Élévation hanche (retour)", "Obliques externes + internes (orange)", "10 répétitions × 3 séries". Flat 2D medical illustration.`,
  },
  {
    id: 170,
    nom: 'Stabilisation lombopelvienne en position quadrupède',
    prompt: `${STYLE} Person in quadruped position (on hands and knees, neutral spine). Stable position with all 4 contact points shown — both hands and both knees on mat. Small bubble-level icon over the pelvis showing horizontal alignment. Lumbar spine neutral curve highlighted with dotted curve. Arrows: GREEN double-headed arrows at transverse abdominis region showing abdominal bracing. RED downward arrow below navel labeled "Ne pas creuser/bomber". Core activation dots at transversus abdominis level. French labels: "Position 4 appuis neutre", "Gainage abdominal doux (non maximal)", "Rachis lombaire neutre", "Transversus abdominaux actif", "Pelvis horizontal", "Respiration continue". Flat 2D medical illustration.`,
  },
  {
    id: 171,
    nom: 'Crunch isométrique abdominal profond',
    prompt: `Flat 2D medical illustration, pure white background, clinical diagram style. Schematic sagittal cross-section diagram of the lumbar spine and abdomen. Simple outline showing the lumbar vertebrae, pelvis, and layered abdominal muscles. Transversus abdominis muscle layer highlighted in orange, drawn as a horizontal band encircling the lower abdomen. Small arrows showing muscle activation inward (like a corset tightening). Anterior tilt vs. neutral pelvis shown with dashed pelvic angle comparison. French labels: "Transversus abdominis (orange, activation)", "Contraction douce 30% effort max", "Pas de retenue de souffle", "Rachis en position neutre", "Plancher pelvien co-activé", "5 secondes, 10 répétitions". Anatomical diagram, flat 2D.`,
  },
  {
    id: 172,
    nom: 'Relevé de buste sur Swiss ball oblique',
    prompt: `${STYLE} Person performing an oblique crunch movement on an exercise ball. The ball is positioned under the lower back/hip area. Person is reclined back at about 45°, then shown in two positions: reclined (faint) and lifted/rotated (solid) with the right shoulder rotating toward the left knee. GREEN curved diagonal arrow showing the oblique rotation movement. Swiss ball shown as a large circle. External oblique abdominal muscle highlighted in orange on the working side. French labels: "Ballon sous bas du dos/hanche", "Légère rotation oblique", "Obliques externes (orange)", "Expiration à la montée", "Descente lente et contrôlée", "Amplitude modérée". Flat 2D medical illustration.`,
  },
  {
    id: 173,
    nom: 'Flexion du coude excentrique contre résistance',
    prompt: `${STYLE} Side view schematic of the elbow and forearm. Two-panel diagram. LEFT panel: Forearm raised (elbow flexed ~120°), holding a dumbbell or weight. Biceps brachii muscle highlighted in orange. GREEN arrow showing arm in lowered position. RIGHT panel: Arm slowly lowering the weight (eccentric phase) from 120° to full extension. RED dagger/slow arrow indicating controlled slow lowering "3-4 secondes". Dashed arc showing the range of motion 120° to 0°. French labels: "Phase excentrique (descente)", "Fléchisseurs du coude (orange)", "Résistance faible à modérée", "Descente 3-4 secondes", "Remonter avec le bras non blessé ou les deux", "Épicondylite latérale / tendinopathie biceps". Flat 2D medical illustration.`,
  },
  {
    id: 174,
    nom: 'Étirements fléchisseurs avant-bras (épitrochléite)',
    prompt: `${STYLE} Front and side view of arm and forearm stretching position. Person's arm extended forward, elbow straight, palm facing UP (supinated). Other hand gently pressing the fingers/palm of the extended arm downward (wrist extension). GREEN downward arrow on the extended hand showing the stretch direction. Forearm flexor muscles highlighted in orange on the medial forearm/inner elbow area. Small anatomy inset showing medial epicondyle of humerus with red dot labeled "Épitrochlea". French labels: "Coude tendu", "Paume vers le haut (supination)", "Doigts étirés vers le bas", "Fléchisseurs avant-bras (orange)", "Épitrochléite (coude intérieur)", "30 secondes × 3, modéré". Flat 2D medical illustration.`,
  },
  {
    id: 175,
    nom: 'Mobilisation neuro-méningée du nerf médian',
    prompt: `Flat 2D medical illustration, pure white background, clinical diagram style. Full upper limb nerve mobilization diagram (neurodynamic test schematic). Schematic outline of the arm and hand. The median nerve path highlighted in yellow from neck/shoulder down through the arm, through the carpal tunnel, to the palm and fingers. Two-panel progressive sequence: LEFT panel — arm relaxed at side (starting position). RIGHT panel — arm abducted 90°, elbow extended, wrist extended/supinated (median nerve sensitized position). GREEN tension arrows along nerve pathway. French labels: "Nerf médian (jaune)", "Abduction épaule 90°", "Extension poignet + supination", "Mise en tension progressive", "S'arrêter à la gêne neurologique", "Mobilisation neuromécanique douce". Nerve anatomy diagram, flat 2D.`,
  },
  {
    id: 176,
    nom: 'Renforcement des supinateurs avec élastique',
    prompt: `${STYLE} Close-up view of forearm and hand in two positions. LEFT (starting): Forearm in pronation position (palm facing down), elastic band looped around the palm/hand, other end fixed. RIGHT (ending): Forearm rotated to full supination (palm facing up) against elastic resistance. GREEN curved rotation arrow showing supination direction. RED arrow showing elastic resistance force. Supinator muscle region and biceps brachii highlighted in orange on the forearm/upper arm. Small anatomical cross-section inset showing radius and ulna rotation. French labels: "Position départ: pronation (paume bas)", "Rotation vers supination (paume haut)", "Supinateurs + biceps brachii (orange)", "Résistance élastique", "Mouvement lent et contrôlé", "10-15 répétitions". Flat 2D medical illustration.`,
  },
  {
    id: 177,
    nom: 'Mobilisation du tunnel carpien',
    prompt: `${STYLE} Diagram of the wrist and hand showing carpal tunnel mobilization exercises. Two positions shown side by side. LEFT: Wrist in neutral/straight position — tunnel cross-section schematic showing median nerve (yellow circle) and tendons within the tunnel. RIGHT: Wrist gently extended (bent backward) and flexed (bent forward) — two small dashed arc arrows showing the oscillatory mobilization. Small anatomy inset: cross-section of the carpal tunnel showing the flexor retinaculum (highlighted teal), 9 flexor tendons, and median nerve (yellow). GREEN gentle arrows on wrist. French labels: "Canal carpien (vue en coupe)", "Rétinaculum des fléchisseurs (teal)", "Nerf médian (jaune)", "Mobilisation oscillatoire douce", "Flexion-extension poignet (amplitude modérée)", "Soulagement de la compression". Flat 2D medical illustration.`,
  },
  {
    id: 178,
    nom: 'Exercice du tendon glissant (tendon gliding)',
    prompt: `${STYLE} Multi-position hand diagram showing the 5-step tendon gliding sequence for the fingers. Five side-profile hand positions shown in a horizontal row, each labeled: 1) "Doigts tendus" (straight fingers, hand open flat), 2) "Crochet" (MCP straight, PIP + DIP flexed — hook fist), 3) "Poing table" (MCP flexed, PIP + DIP straight — tabletop position), 4) "Poing complet" (full fist), 5) "Extension complète" (return to full open). Each transition has a small GREEN arrow between positions. Finger tendons highlighted as thin orange lines through the finger joints. French labels under each position. Title label: "Glissement tendineux - séquence complète". Flat 2D medical illustration.`,
  },
  {
    id: 179,
    nom: 'Renforcement des muscles thénar',
    prompt: `${STYLE} Close-up front-view diagram of the hand focusing on thumb muscles. Three-panel sequence showing thumb opposition exercises. LEFT panel: Hand open, thumb pointing upward — thenar eminence (base of thumb) highlighted in orange showing muscle bulk. MIDDLE panel: Thumb touching tip of index finger (pinch). RIGHT panel: Thumb touching tip of little finger (opposition). GREEN curved arrows showing thumb's opposition arc movement. Small anatomy inset: top-down view of thenar muscles (abductor pollicis brevis, flexor pollicis brevis, opponens pollicis) labeled in orange. French labels: "Éminence thénar (orange)", "Opposition pouce-index", "Opposition pouce-auriculaire", "Abducteur court + opposant du pouce", "10 répétitions, 3 séries", "Prise en pince + cylindrique". Flat 2D medical illustration.`,
  },
  {
    id: 180,
    nom: 'Mobilisation du poignet post-immobilisation',
    prompt: `${STYLE} Side-view and top-view diagram of the wrist showing post-immobilization mobility exercises. Four-panel movement sequence showing: 1) Flexion (wrist bending toward palm) with GREEN downward arc arrow, 2) Extension (wrist bending backward) with GREEN upward arc arrow, 3) Radial deviation (wrist tilting toward thumb) with GREEN arrow, 4) Ulnar deviation (wrist tilting toward little finger) with GREEN arrow. Each panel shows the wrist at end-range with dashed range-of-motion arc and current ROM angle noted (e.g., "45°"). Stiff/limited range noted with orange shading at joint. French labels: "Flexion palmaire", "Extension dorsale", "Déviation radiale", "Déviation ulnaire", "Amplitude progressive", "Pas de douleur vive". Flat 2D medical illustration.`,
  },
  {
    id: 181,
    nom: 'Renforcement supinateurs du pied (doming)',
    prompt: `${STYLE} Close-up side-view and top-view of the foot showing arch-doming exercise. TOP VIEW: Foot flat on floor, then foot forming an arch dome — the toes stay flat on the ground but the arch rises upward. GREEN upward arc arrow under the medial arch. The intrinsic foot muscles (short flexors) highlighted in orange in the arch region. SIDE VIEW inset: showing the arch height before (flat) and after (domed) with dashed line comparison. French labels: "Pied à plat sur le sol", "Orteils restent posés (ne pas les recroqueviller)", "Coupole plantaire (doming)", "Muscles intrinsèques du pied (orange)", "Voûte plantaire renforcée", "10 répétitions, tenir 3s". Flat 2D medical illustration.`,
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
  console.log('=== Exercise Image Generation — Batch 3 (15 exercises) ===\n');

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
      const filename = `exercice-batch3-${exercise.id}-${Date.now()}.png`;
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
