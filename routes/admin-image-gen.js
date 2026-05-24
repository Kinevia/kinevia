/**
 * Temporary admin route for triggering batch image generation jobs.
 * Protected by POLSIA_API_KEY token.
 * REMOVE after all batch jobs complete.
 *
 * Usage: require('./routes/admin-image-gen')(pool)
 * Accepts the main app pool to avoid separate DB connection issues.
 */

const express = require('express');
const OpenAI = require('openai');
const fetch = require('node-fetch');
const FormData = require('form-data');

// router is created once; pool is injected at startup via module.exports factory
const router = express.Router();

const STYLE =
  'Flat 2D medical illustration, pure white background, clean clinical style. No shadows, no 3D rendering, no photorealism. Simple line art with flat color fills. Use colored arrows: GREEN (#22c55e) for correct movement direction, RED (#ef4444) for movement to avoid or resistance. Include concise French anatomical labels with small leader lines. Professional physiotherapy patient-education style, minimalist, precise.';

const BATCH2_EXERCISES = [
  {
    id: 157,
    nom: 'Nageur couché (Superman)',
    prompt: `${STYLE} Person lying face-down (prone) on a mat. Both arms extended overhead and both legs straight. Simultaneously, both arms lift upward and both legs lift upward off the mat, arching the back gently. GREEN upward arrows on both arms and both legs showing the lift direction. Small dashed outline shows the starting flat position. French labels: "Décubitus ventral", "Bras tendus devant", "Jambes tendues", "Élévation simultanée bras+jambes", "Maintien 3-5 secondes", "Extenseurs du rachis". Flat 2D medical illustration.`,
  },
  {
    id: 162,
    nom: 'Mobilisation thoracique en rotation assise',
    prompt: `${STYLE} Person seated on a stool, arms crossed over chest. Two overlaid positions: faint (facing forward) and solid (trunk rotated to the RIGHT ~45°). GREEN curved arrow showing rightward rotation at thoracic level. Small lock icon on lumbar region labeled "Bas du dos stable". Secondary dashed panel showing rotation to left. French labels: "Bras croisés sur épaules", "Rotation thoracique droite puis gauche", "Rachis lombaire stabilisé", "Ampleur progressive", "Retour lent". Flat 2D medical illustration.`,
  },
  {
    id: 163,
    nom: 'Extension thoracique sur rouleau',
    prompt: `${STYLE} Person lying on their back (supine) on a mat. A foam roller positioned horizontally under the thoracic spine at mid-back. Arms loosely folded over chest. Back extending gently over the roller. GREEN downward curved arrow showing back relaxing over the roller. Dashed line showing neutral spine vs. extended position. French labels: "Rouleau en mousse", "Zone thoracique T4-T8", "Extension gravitaire douce", "Bras croisés ou derrière tête", "30 secondes par segment". Flat 2D medical illustration.`,
  },
  {
    id: 165,
    nom: 'Gainage latéral genoux au sol',
    prompt: `${STYLE} Person in modified side plank. Bottom knee bent at 90° on the ground, bottom elbow on ground below shoulder. Body forms a diagonal from bent knee to head. Hips lifted. GREEN upward arrow at hip level. Correct alignment shown with dashed diagonal line. French labels: "Appui coude-avant-bras", "Genou fléchi au sol", "Hanches soulevées", "Corps aligné", "Grand fessier + obliques", "30 secondes". Flat 2D medical illustration.`,
  },
  {
    id: 166,
    nom: 'Cat-Cow thoracique ciblé',
    prompt: `${STYLE} Two side-by-side panels in quadruped position. LEFT "Chat (flexion)": spine rounds upward, thoracic spine arched UP, GREEN upward arrow, label "Expiration". RIGHT "Vache (extension)": thoracic spine extends downward gently, GREEN downward arrow, label "Inspiration". Both show stable hips. French labels: "Position 4 appuis", "Mouvement thoracique ciblé", "Rachis lombaire neutre", "Chat: expiration + flexion", "Vache: inspiration + extension". Flat 2D medical illustration.`,
  },
  {
    id: 168,
    nom: 'Dead bug',
    prompt: `${STYLE} Person lying on their back, lower back pressed against the mat. Both arms pointing straight up and both knees at 90°. Movement: RIGHT arm extends overhead (GREEN arrow) while LEFT leg extends out straight (GREEN arrow) simultaneously. RED crossed arrow on lumbar spine showing back must stay flat. French labels: "Bras vers le plafond", "Genoux à 90°", "Dos plaqué au sol", "Extension bras/jambe opposés", "Coordination contralaterale", "Transverse de l'abdomen". Flat 2D medical illustration.`,
  },
  {
    id: 184,
    nom: 'Terminal extension du genou (TKE)',
    prompt: `${STYLE} Person standing, side view. Elastic resistance band looped around back of bent knee (30° flexion). Person extends knee to full extension against the band. GREEN arrow showing knee extending. RED arrow showing band resistance. Small inset showing band placement. French labels: "Élastique derrière le genou", "Extension terminale 30° → 0°", "Résistance élastique", "Vaste interne VMO", "Contraction finale 2s", "Pas de douleur". Flat 2D medical illustration.`,
  },
  {
    id: 185,
    nom: 'Step-up latéral',
    prompt: `${STYLE} Person standing sideways next to a low step (15-20cm). Leading leg steps up sideways onto the step. Two positions shown: beside step (faint) and foot on step with opposite leg lifted (solid). GREEN upward arrow on leading leg. Dashed vertical line showing correct knee alignment. Pelvis level indicator. French labels: "Marche latérale 15-20 cm", "Pied entier sur la marche", "Genou dans l'axe du pied", "Moyen fessier + quadriceps", "Descente contrôlée excentrique". Flat 2D medical illustration.`,
  },
  {
    id: 186,
    nom: 'Renforcement du vaste interne (VMO)',
    prompt: `${STYLE} Person seated on edge of chair. Leg extended, foot slightly turned outward. Towel roll under knee for slight flexion. VMO area highlighted in orange on inner thigh above knee. GREEN arrow showing leg slightly lifting. Timer "5s contraction + 5s relâche". French labels: "Position assise, jambe en extension", "Pied légèrement en rotation externe", "Vaste interne oblique VMO (orange)", "Contraction isométrique 5s", "Rouleau sous genou 10-20°". Flat 2D medical illustration.`,
  },
  {
    id: 187,
    nom: 'Pont fessier unilatéral sur balle',
    prompt: `${STYLE} Person lying on their back. Both heels on a Swiss ball. One leg bent with foot on ball, other leg raised straight up. Hips lifting off mat via single-leg bridge. GREEN upward arrow at hip level. RED arrow indicating lifted leg stays up. French labels: "Talons sur ballon suisse", "Pont unijambiste", "Une jambe en extension levée", "Grand fessier + ischio-jambiers", "Hanches alignées ne pas basculer", "Maintien 3s". Flat 2D medical illustration.`,
  },
  {
    id: 190,
    nom: 'Renforcement des extenseurs du dos en position genoux-mains',
    prompt: `${STYLE} Quadruped position. RIGHT arm extends forward (horizontal) and LEFT leg extends backward (horizontal) simultaneously. GREEN arrow on arm (forward) and GREEN arrow on leg (backward). Level pelvis indicator. Small inset (red border): leg too high, lumbar hyperextension, RED X. French labels: "Position 4 appuis dos neutre", "Extension bras opposé + jambe opposée", "Bassin horizontal ne pas tourner", "Extenseurs lombaires + fessiers", "Maintien 5 secondes". Flat 2D medical illustration.`,
  },
  {
    id: 191,
    nom: 'Étirement du piriforme (sciatique)',
    prompt: `${STYLE} Two panels. LEFT: Person lying on back. Right ankle crossed over left knee (figure-4 position). Hands behind left thigh pulling toward chest. Right hip region highlighted in orange (piriformis). GREEN arrow pulling thigh toward chest. Label "Cheville droite sur genou gauche". RIGHT: Same figure-4 position seated on chair. French labels: "Piriforme droit (orange)", "Tirer la cuisse vers la poitrine", "30 secondes", "Nerf sciatique soulagé". Flat 2D medical illustration.`,
  },
  {
    id: 195,
    nom: 'Renforcement serratus anterior (push-up plus)',
    prompt: `${STYLE} Two-panel side view. LEFT: Standard push-up position arms straight. RIGHT: From locked-out push-up, thoracic spine rounds further upward, scapulas spreading wide (protraction). RED scapular outlines showing starting vs final position. GREEN upward arrow on thoracic spine. Serratus anterior highlighted in orange on ribcage sides. French labels: "Position pompe bras tendus", "Phase plus: poussée scapulaire", "Scapulas s'écartent protraction", "Serratus anterior (orange)", "Maintien 2 secondes". Flat 2D medical illustration.`,
  },
  {
    id: 196,
    nom: 'Abduction de hanche latérale debout avec élastique',
    prompt: `${STYLE} Person standing, one hand on wall. Elastic band around both ankles. Working leg abducts outward to the side (30-40°). Supporting leg planted. GREEN arrow showing working leg moving outward. RED arrow showing band resistance. Gluteus medius highlighted in orange on working hip. French labels: "Élastique aux chevilles", "Abduction de hanche 30-45°", "Appui main au mur", "Moyen fessier (orange)", "Genou légèrement fléchi dos droit", "15 répétitions 3 séries". Flat 2D medical illustration.`,
  },
  {
    id: 200,
    nom: 'Rétraction cervicale (chin tuck)',
    prompt: `${STYLE} Side profile of person seated upright. Two positions: faint (head in forward-head posture, chin forward) and solid (chin tucked back, back of head over shoulders). GREEN horizontal backward arrow at chin level. Dashed vertical line showing ear-over-shoulder alignment. Faint position labeled "Avant: tête projetée". Solid labeled "Après: rétraction cervicale". French labels: "Rétraction cervicale chin tuck", "Oreille au-dessus de l'épaule", "Fléchisseurs cervicaux profonds", "10 répétitions 10s maintien", "Rétraction pure sans incliner". Flat 2D medical illustration.`,
  },
];

async function downloadImage(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download: ${response.status}`);
  return await response.buffer();
}

async function uploadToR2(imageBuffer, filename) {
  const formData = new FormData();
  formData.append('file', imageBuffer, { filename, contentType: 'image/png' });
  const response = await fetch('https://polsia.com/api/proxy/r2/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.POLSIA_API_KEY}`,
      ...formData.getHeaders(),
    },
    body: formData,
  });
  const result = await response.json();
  if (!result.success) throw new Error(result.error?.message || 'R2 upload failed');
  return result.file.url;
}

// POST /api/admin/generate-batch2-images
// Auth: Authorization: Bearer <POLSIA_API_KEY>
// Runs async — returns 202 immediately, logs progress to console
router.post('/generate-batch2-images', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (token !== process.env.POLSIA_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Respond immediately — generation runs async
  res.status(202).json({
    message: 'Batch 2 image generation started',
    total: BATCH2_EXERCISES.length,
    note: 'Check server logs for progress. ~10min estimated.',
  });

  // Run async in background — use shared main pool (passed via factory)
  const pool = router._mainPool;
  const openai = new OpenAI();

  const results = [];
  console.log('[batch2] === Starting Batch 2 image generation ===');

  for (const exercise of BATCH2_EXERCISES) {
    console.log(`[batch2] Processing [${exercise.id}] ${exercise.nom}`);
    try {
      const imageResponse = await openai.images.generate({
        model: 'dall-e-3',
        prompt: exercise.prompt,
        size: '1024x1024',
        quality: 'standard',
        n: 1,
      });
      const dalleUrl = imageResponse.data[0].url;
      const imageBuffer = await downloadImage(dalleUrl);
      const filename = `exercice-batch2-${exercise.id}-${Date.now()}.png`;
      const r2Url = await uploadToR2(imageBuffer, filename);
      await pool.query('UPDATE exercices SET image_url = $1 WHERE id = $2', [r2Url, exercise.id]);
      console.log(`[batch2] ✓ [${exercise.id}] ${exercise.nom} → ${r2Url}`);
      results.push({ id: exercise.id, status: 'success', url: r2Url });
    } catch (err) {
      console.error(`[batch2] ✗ [${exercise.id}] ${exercise.nom} → ${err.message}`);
      results.push({ id: exercise.id, status: 'error', error: err.message });
    }
    await new Promise(r => setTimeout(r, 2500));
  }

  const successes = results.filter(r => r.status === 'success').length;
  console.log(`[batch2] === DONE: ${successes}/${results.length} succeeded ===`);
  console.log('[batch2] Results:', JSON.stringify(results, null, 2));
});

// Retry batch for the 7 exercises blocked by DALL-E content filters.
// Prompts rewritten as pure schematic diagrams without position descriptions.
const BATCH2_RETRY_EXERCISES = [
  {
    id: 163,
    nom: 'Extension thoracique sur rouleau',
    prompt: `Flat 2D medical illustration, pure white background, clinical diagram style. Schematic side-view diagram of a human spine. A cylindrical foam roller shown in cross-section placed under the mid-thoracic vertebrae (T4-T8 segment highlighted in teal). Curved GREEN arrow showing the thoracic spine gently arching over the roller (extension movement). Small dashed line comparing neutral spine vs. extended position. French labels: "Rouleau en mousse", "Zone thoracique T4-T8", "Extension douce", "Amplitude croissante", "30 secondes". Anatomical spine diagram, no photorealism, flat line art only.`,
  },
  {
    id: 168,
    nom: 'Dead bug',
    prompt: `Flat 2D medical illustration, pure white background, clinical diagram style. Schematic overhead-view diagram showing a mat exercise. Two outlined stick-figure arms pointing upward and two bent knees at 90 degrees — bird's-eye floor diagram. Movement arrows: diagonal GREEN arrow showing right arm extending toward top-left corner while left leg extends toward bottom-right corner (contralateral pattern). Small RED arrow with lock symbol on lumbar area: "Dos au sol". French labels: "Bras tendus vers haut", "Genoux à 90°", "Dos plaqué (neutre)", "Extension alternée bras/jambe", "Transverse abdomen". Schematic diagram, no photorealism.`,
  },
  {
    id: 184,
    nom: 'Terminal extension du genou (TKE)',
    prompt: `Flat 2D medical illustration, pure white background, clinical style. Schematic side-view diagram of a knee joint. Two positions overlaid: dashed outline showing knee at 30° flexion, solid outline showing full extension to 0°. A horizontal resistance band symbol (two parallel horizontal lines with spring symbol) crossing the back of the knee. GREEN arrow on lower leg pointing forward-downward (extension direction). RED arrow pointing backward (band resistance). VMO muscle region highlighted in orange on medial thigh above knee. French labels: "Genou 30° → 0°", "Élastique résistance", "Vaste interne VMO (orange)", "Extension terminale", "Contraction 2s". Anatomical knee diagram, flat 2D.`,
  },
  {
    id: 186,
    nom: 'Renforcement du vaste interne (VMO)',
    prompt: `Flat 2D medical illustration, pure white background, clinical style. Schematic front-view diagram of the right thigh and knee. Thigh musculature shown as flat color anatomy diagram. VMO (vastus medialis oblique) muscle highlighted in vivid orange on the inner thigh, just above and medial to the knee. A small straight-line symbol showing the knee in slight flexion (~15°). Dashed arrow showing foot in slight external rotation. French labels: "Vaste interne oblique VMO (orange)", "Genou 10-20° flexion", "Pied légèrement tourné vers l'extérieur", "Contraction isométrique 5s", "Renforcement sélectif VMO". Anatomical muscle diagram, flat line art, no photorealism.`,
  },
  {
    id: 190,
    nom: 'Renforcement des extenseurs du dos en position genoux-mains',
    prompt: `Flat 2D medical illustration, pure white background, clinical style. Side-view schematic of a quadruped exercise diagram (4-point kneeling position). Stick-figure on hands and knees, neutral spine. Right arm extends forward (horizontal) with GREEN arrow →. Left leg extends backward (horizontal) with GREEN arrow ←. Small level symbol (bubble level icon) on pelvis showing horizontal alignment. Inset diagram (red border) showing incorrect: pelvis rotating, RED X. French labels: "Position 4 appuis", "Bras droit tendu en avant", "Jambe gauche tendue en arrière", "Bassin horizontal", "Extenseurs lombaires + fessiers", "5 secondes". Schematic physiotherapy diagram.`,
  },
  {
    id: 191,
    nom: 'Étirement du piriforme (sciatique)',
    prompt: `Flat 2D medical illustration, pure white background, clinical style. Two-panel anatomical diagram. LEFT panel: hip joint anatomy schematic showing the piriformis muscle highlighted in orange, deep to the gluteus maximus. Sciatic nerve shown as a yellow line passing near/under the piriformis. French label: "Piriforme (orange)", "Nerf sciatique (jaune)". RIGHT panel: Floor mat exercise diagram (overhead view): figure-4 shape showing ankle-over-knee position with circular arrows indicating the stretch direction. GREEN arrow showing the hip externally rotating. French labels: "Cheville croisée sur le genou", "Rotation externe hanche", "Étirement piriforme", "30 secondes". Anatomical diagram, flat 2D, clinical.`,
  },
  {
    id: 195,
    nom: 'Renforcement serratus anterior (push-up plus)',
    prompt: `Flat 2D medical illustration, pure white background, clinical style. Side-view schematic of a plank/push-up exercise diagram. Stick-figure in straight-arm plank position (hands and toes). Phase 1 shown with neutral spine. Phase 2 (the "plus") shows thoracic spine rounding upward with scapulas spreading apart (protraction) — GREEN upward curved arrow on thorax. Small anatomical inset: rib cage cross-section showing serratus anterior muscle fibers (highlighted orange) connecting scapula to lateral ribs. French labels: "Planche bras tendus", "Phase PLUS: protraction scapulaire", "Scapulas s'écartent", "Serratus anterior (orange)", "Maintien 2s". Clinical exercise diagram, flat 2D.`,
  },
];

// POST /api/admin/retry-batch2-images — retry the 7 blocked exercises with revised prompts
router.post('/retry-batch2-images', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (token !== process.env.POLSIA_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.status(202).json({
    message: 'Batch 2 RETRY started (7 exercises)',
    total: BATCH2_RETRY_EXERCISES.length,
    note: 'Check server logs [batch2r] for progress.',
  });

  // Use shared main pool (passed via factory) — avoids separate connection issues
  const pool = router._mainPool;
  const openai = new OpenAI();
  const results = [];

  console.log('[batch2r] === Starting Batch 2 RETRY (7 exercises) ===');

  for (const exercise of BATCH2_RETRY_EXERCISES) {
    console.log(`[batch2r] Processing [${exercise.id}] ${exercise.nom}`);
    try {
      const imageResponse = await openai.images.generate({
        model: 'dall-e-3',
        prompt: exercise.prompt,
        size: '1024x1024',
        quality: 'standard',
        n: 1,
      });
      const dalleUrl = imageResponse.data[0].url;
      const imageBuffer = await downloadImage(dalleUrl);
      const filename = `exercice-b2r-${exercise.id}-${Date.now()}.png`;
      const r2Url = await uploadToR2(imageBuffer, filename);
      await pool.query('UPDATE exercices SET image_url = $1 WHERE id = $2', [r2Url, exercise.id]);
      console.log(`[batch2r] ✓ [${exercise.id}] ${exercise.nom} → ${r2Url}`);
      results.push({ id: exercise.id, status: 'success', url: r2Url });
    } catch (err) {
      console.error(`[batch2r] ✗ [${exercise.id}] ${exercise.nom} → ${err.message}`);
      results.push({ id: exercise.id, status: 'error', error: err.message });
    }
    await new Promise(r => setTimeout(r, 2500));
  }

  const successes = results.filter(r => r.status === 'success').length;
  console.log(`[batch2r] === DONE: ${successes}/${results.length} succeeded ===`);
  console.log('[batch2r] Results:', JSON.stringify(results));
});

// Batch 3: next 15 most-prescribed exercises without images
const BATCH3_EXERCISES = [
  {
    id: 164,
    nom: 'Étirements en ouverture thoracique',
    prompt: `${STYLE} Person standing in a doorway frame (two vertical posts visible on left and right). Both arms raised to shoulder height, elbows bent at 90°, forearms resting against the door posts (cactus arm position). Chest opening forward with GREEN forward arrow at sternum level. Dashed vertical alignment line showing chest protruding through the doorway. Pectoral region highlighted with orange shading. French labels: "Cadre de porte", "Bras en U à 90°", "Avant-bras sur le chambranle", "Ouverture pectorale + thoracique", "Légèrement en avant", "30 secondes, respiration profonde". Flat 2D medical illustration.`,
  },
  {
    id: 167,
    nom: 'Rotation thoracique en décubitus latéral',
    prompt: `Flat 2D medical illustration, pure white background, clinical diagram style. Schematic side-view anatomical diagram. Figure shown lying on their side on a mat. Both knees stacked and bent at 90 degrees. Top arm sweeps in a large arc from resting over the bottom arm (faint outline) to opening out to the opposite side (solid position), creating thoracic rotation. GREEN curved arc arrow showing the arm rotation path. Spine area at thoracic level highlighted teal with small rotation symbol. French labels: "Décubitus latéral", "Genoux fléchis superposés", "Bras supérieur en rotation", "Arc de mouvement thoracique", "Hanches restent en place", "30 secondes à la limite". Anatomical schematic.`,
  },
  {
    id: 169,
    nom: 'Gainage latéral avec élévation de hanche',
    prompt: `${STYLE} Person in full side plank position (elbow on floor, feet stacked). Two overlaid positions: faint showing hips lowered toward floor, solid showing hips elevated back to full alignment. GREEN upward arc arrow at hip showing the elevation movement. Dashed diagonal alignment line from feet through hip to shoulder. Oblique abdominal region on the working side highlighted in orange. French labels: "Planche latérale complète", "Appui pied + avant-bras", "Hanches s'abaissent légèrement", "Élévation hanche (retour)", "Obliques externes + internes (orange)", "10 répétitions × 3 séries". Flat 2D medical illustration.`,
  },
  {
    id: 170,
    nom: 'Stabilisation lombopelvienne en position quadrupède',
    prompt: `${STYLE} Person in quadruped position (on hands and knees, neutral spine). Stable position with all 4 contact points shown. Small bubble-level icon over the pelvis showing horizontal alignment. Lumbar spine neutral curve highlighted with dotted curve. Arrows: GREEN double-headed arrows at transverse abdominis region showing abdominal bracing. RED downward arrow below navel labeled "Ne pas creuser/bomber". French labels: "Position 4 appuis neutre", "Gainage abdominal doux", "Rachis lombaire neutre", "Transversus abdominaux actif", "Pelvis horizontal", "Respiration continue". Flat 2D medical illustration.`,
  },
  {
    id: 171,
    nom: 'Crunch isométrique abdominal profond',
    prompt: `Flat 2D medical illustration, pure white background, clinical diagram style. Schematic sagittal cross-section diagram of the lumbar spine and abdomen. Simple outline showing the lumbar vertebrae, pelvis, and layered abdominal muscles. Transversus abdominis muscle layer highlighted in orange, drawn as a horizontal band encircling the lower abdomen. Small arrows showing muscle activation inward (like a corset tightening). Pelvic angle comparison showing anterior tilt vs neutral. French labels: "Transversus abdominis (orange)", "Contraction douce 30% effort", "Pas de retenue de souffle", "Rachis neutre", "Plancher pelvien co-activé", "5 secondes, 10 répétitions". Anatomical cross-section diagram.`,
  },
  {
    id: 172,
    nom: 'Relevé de buste sur Swiss ball oblique',
    prompt: `${STYLE} Person performing an oblique crunch on an exercise ball. The ball positioned under the lower back/hip area. Person reclined at about 45°, shown in two positions: reclined (faint) and lifted/rotated (solid) with the right shoulder rotating toward the left knee. GREEN curved diagonal arrow showing the oblique rotation movement. Swiss ball shown as a large circle. External oblique abdominal muscle highlighted in orange on the working side. French labels: "Ballon sous bas du dos", "Légère rotation oblique", "Obliques externes (orange)", "Expiration à la montée", "Descente lente et contrôlée", "Amplitude modérée". Flat 2D medical illustration.`,
  },
  {
    id: 173,
    nom: 'Flexion du coude excentrique contre résistance',
    prompt: `${STYLE} Side view schematic of the elbow and forearm. Two-panel diagram. LEFT panel: Forearm raised (elbow flexed ~120°), holding a dumbbell. Biceps brachii highlighted in orange. RIGHT panel: Arm slowly lowering the weight (eccentric phase) from 120° to full extension. RED slow arrow indicating controlled lowering "3-4 secondes". Dashed arc showing range of motion. French labels: "Phase excentrique (descente)", "Fléchisseurs du coude (orange)", "Résistance faible à modérée", "Descente 3-4 secondes", "Tendinopathie biceps / épicondylite". Flat 2D medical illustration.`,
  },
  {
    id: 174,
    nom: 'Étirements fléchisseurs avant-bras (épitrochléite)',
    prompt: `${STYLE} Front view of arm in stretching position. Person arm extended forward, elbow straight, palm facing UP (supinated). Other hand gently pressing the fingers/palm downward (wrist extension). GREEN downward arrow on the extended hand showing the stretch direction. Forearm flexor muscles highlighted in orange on the medial forearm. Small anatomy inset showing medial epicondyle with red dot labeled "Épitrochlea". French labels: "Coude tendu", "Paume vers le haut (supination)", "Doigts étirés vers le bas", "Fléchisseurs avant-bras (orange)", "Épitrochléite (coude intérieur)", "30 secondes × 3". Flat 2D medical illustration.`,
  },
  {
    id: 175,
    nom: 'Mobilisation neuro-méningée du nerf médian',
    prompt: `Flat 2D medical illustration, pure white background, clinical diagram style. Full upper limb nerve mobilization schematic. Outline of the arm and hand. The median nerve path highlighted in yellow from neck/shoulder down through the arm, through the carpal tunnel, to the palm. Two-panel sequence: LEFT — arm relaxed at side. RIGHT — arm abducted 90°, elbow extended, wrist extended and supinated. GREEN tension arrows along nerve pathway. French labels: "Nerf médian (jaune)", "Abduction épaule 90°", "Extension poignet + supination", "Mise en tension progressive", "S'arrêter à la gêne", "Mobilisation neuromécanique douce". Nerve anatomy diagram, flat 2D.`,
  },
  {
    id: 176,
    nom: 'Renforcement des supinateurs avec élastique',
    prompt: `${STYLE} Close-up view of forearm and hand in two positions. LEFT: Forearm in pronation position (palm facing down), elastic band looped around the hand, other end fixed. RIGHT: Forearm rotated to full supination (palm facing up) against elastic resistance. GREEN curved rotation arrow showing supination direction. RED arrow showing elastic resistance. Supinator and biceps brachii highlighted in orange. Small anatomy inset showing radius and ulna rotation. French labels: "Départ: pronation (paume bas)", "Rotation vers supination (paume haut)", "Supinateurs + biceps (orange)", "Résistance élastique", "Mouvement lent", "10-15 répétitions". Flat 2D medical illustration.`,
  },
  {
    id: 177,
    nom: 'Mobilisation du tunnel carpien',
    prompt: `${STYLE} Diagram of the wrist and hand showing carpal tunnel mobilization. Two positions side by side. LEFT: Wrist in neutral position — tunnel cross-section showing median nerve (yellow circle) and tendons within the tunnel. RIGHT: Wrist gently oscillating in flexion and extension — two small dashed arc arrows showing the gentle oscillatory movement. Small anatomy inset: cross-section of carpal tunnel showing flexor retinaculum (teal), flexor tendons, and median nerve (yellow). French labels: "Canal carpien (coupe transversale)", "Rétinaculum (teal)", "Nerf médian (jaune)", "Mobilisation oscillatoire douce", "Flexion-extension poignet", "Soulagement de la compression". Flat 2D medical illustration.`,
  },
  {
    id: 178,
    nom: 'Exercice du tendon glissant (tendon gliding)',
    prompt: `${STYLE} Multi-position hand diagram showing the 5-step tendon gliding sequence. Five side-profile hand positions in a horizontal row: 1) "Doigts tendus" (hand open flat), 2) "Crochet" (hook fist — MCP straight, PIP + DIP flexed), 3) "Poing table" (tabletop — MCP flexed, PIP + DIP straight), 4) "Poing complet" (full fist), 5) "Extension" (return to open). Small GREEN arrow between each position. Finger tendons shown as thin orange lines. Title: "Glissement tendineux — séquence". French labels under each of the 5 positions. Flat 2D medical illustration.`,
  },
  {
    id: 179,
    nom: 'Renforcement des muscles thénar',
    prompt: `${STYLE} Close-up front-view diagram of the hand focusing on thumb muscles. Three-panel sequence. LEFT: Hand open, thumb pointing up — thenar eminence (base of thumb) highlighted in orange. MIDDLE: Thumb touching tip of index finger (pinch — GREEN arc arrow). RIGHT: Thumb touching tip of little finger (opposition — GREEN arc arrow). Small anatomy inset showing thenar muscles (abductor pollicis brevis, opponens pollicis) in orange. French labels: "Éminence thénar (orange)", "Opposition pouce-index", "Opposition pouce-auriculaire", "Abducteur + opposant du pouce", "10 répétitions, 3 séries". Flat 2D medical illustration.`,
  },
  {
    id: 180,
    nom: 'Mobilisation du poignet post-immobilisation',
    prompt: `${STYLE} Side-view diagram of the wrist showing post-immobilization mobility exercises. Four-panel movement sequence: 1) Flexion — wrist bending toward palm, GREEN downward arc arrow; 2) Extension — wrist bending backward, GREEN upward arc arrow; 3) Radial deviation — wrist tilting toward thumb, GREEN arrow; 4) Ulnar deviation — wrist tilting toward little finger, GREEN arrow. Each panel shows end-range with dashed range-of-motion arc. French labels: "Flexion palmaire", "Extension dorsale", "Déviation radiale", "Déviation ulnaire", "Amplitude progressive", "Pas de douleur vive". Flat 2D medical illustration.`,
  },
  {
    id: 181,
    nom: 'Renforcement supinateurs du pied (doming)',
    prompt: `${STYLE} Close-up side-view and top-view of the foot showing arch-doming exercise. TOP VIEW: Foot flat on floor, then foot forming an arch dome — toes remain flat on the ground but the arch rises upward. GREEN upward arc arrow under the medial arch. Intrinsic foot muscles highlighted in orange in the arch region. SIDE VIEW inset: showing arch height before (flat) and after (domed) with dashed line comparison. French labels: "Pied à plat sur le sol", "Orteils restent posés (ne pas les recroqueviller)", "Coupole plantaire (doming)", "Muscles intrinsèques (orange)", "Voûte plantaire renforcée", "10 répétitions, tenir 3s". Flat 2D medical illustration.`,
  },
];

// POST /api/admin/generate-batch3-images
// Auth: Authorization: Bearer <POLSIA_API_KEY>
// Runs async — returns 202 immediately, logs progress to console
router.post('/generate-batch3-images', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (token !== process.env.POLSIA_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Respond immediately — generation runs async
  res.status(202).json({
    message: 'Batch 3 image generation started',
    total: BATCH3_EXERCISES.length,
    note: 'Check server logs [batch3] for progress. ~10min estimated.',
  });

  // Run async in background — use shared main pool (passed via factory)
  const pool = router._mainPool;
  const openai = new OpenAI();

  const results = [];
  console.log('[batch3] === Starting Batch 3 image generation (15 exercises) ===');

  for (const exercise of BATCH3_EXERCISES) {
    console.log(`[batch3] Processing [${exercise.id}] ${exercise.nom}`);
    try {
      const imageResponse = await openai.images.generate({
        model: 'dall-e-3',
        prompt: exercise.prompt,
        size: '1024x1024',
        quality: 'standard',
        n: 1,
      });
      const dalleUrl = imageResponse.data[0].url;
      const imageBuffer = await downloadImage(dalleUrl);
      const filename = `exercice-batch3-${exercise.id}-${Date.now()}.png`;
      const r2Url = await uploadToR2(imageBuffer, filename);
      await pool.query('UPDATE exercices SET image_url = $1 WHERE id = $2', [r2Url, exercise.id]);
      console.log(`[batch3] ✓ [${exercise.id}] ${exercise.nom} → ${r2Url}`);
      results.push({ id: exercise.id, nom: exercise.nom, status: 'success', url: r2Url });
    } catch (err) {
      console.error(`[batch3] ✗ [${exercise.id}] ${exercise.nom} → ${err.message}`);
      results.push({ id: exercise.id, nom: exercise.nom, status: 'error', error: err.message });
    }
    await new Promise(r => setTimeout(r, 2500));
  }

  const successes = results.filter(r => r.status === 'success').length;
  console.log(`[batch3] === DONE: ${successes}/${results.length} succeeded ===`);
  console.log('[batch3] Results:', JSON.stringify(results, null, 2));
});

// Anatomy audit batch: 20 most-prescribed exercises with known DALL-E anatomical failures
// Priority 1: high prescription count. Priority 2: complex positioning. Priority 3: prone/side-lying (historical filter issues).
const ANATOMY_AUDIT_EXERCISES = [
  {
    id: 15,
    nom: 'Chat-chameau',
    prompt: `Flat 2D medical illustration, pure white background, clean clinical style. Two side-by-side panels showing the cat-cow exercise. LEFT panel labeled "Chat (flexion)": person on hands and knees, spine arched UPWARD (rounded), head lowered, tailbone tucked down. RIGHT panel labeled "Chameau (extension)": same quadruped position, spine arched DOWNWARD (extended), head raised, lower back concave. Wrists under shoulders, knees under hips in both. Curved green arrows on spine showing direction. No text labels, no shadows, anatomically precise, physiotherapy illustration style.`,
  },
  {
    id: 20,
    nom: 'Bascule du bassin',
    prompt: `Flat 2D medical illustration, pure white background, clean clinical style. Side profile of a person lying on their back with knees bent and feet flat. Two positions shown: LEFT (faint/dashed): small gap between lower back and floor (anterior tilt, slight lordosis). RIGHT (solid): lower back pressed flat against floor (posterior tilt, pelvis rotating backward). Green curved arrow at pelvis showing the rocking motion. Anatomically precise lumbar curve difference clearly visible. No text labels, no shadows.`,
  },
  {
    id: 9,
    nom: 'Renforcement quadriceps (chaise)',
    prompt: `Flat 2D medical illustration, pure white background, clean clinical style. Side view of a person seated on a chair. One leg extended straight out horizontally parallel to the floor, knee fully straightened. Other foot flat on ground. Quadriceps muscle region highlighted with a subtle orange tint. Green arrow pointing along the extended leg. The extended leg is truly horizontal. No text labels, no shadows, physiotherapy exercise illustration.`,
  },
  {
    id: 11,
    nom: 'Squat partiel mural',
    prompt: `Flat 2D medical illustration, pure white background, clean clinical style. Side view of a person with back flat against a wall, feet positioned 30-40cm away from the wall. Knees bent to approximately 45 degrees (NOT a full squat — thighs not parallel to floor). Knees aligned above toes. Back maintaining full contact with wall. Green angle indicator showing the 45-degree knee bend. No text labels, no shadows.`,
  },
  {
    id: 18,
    nom: 'Gainage planche ventrale',
    prompt: `Flat 2D medical illustration, pure white background, clean clinical style. Side view of a person performing a forearm plank. Body weight on forearms (elbows at 90 degrees, forearms flat) and toes. Body forms a perfectly straight diagonal line from head to heels. Hips are level — not sagging down and not raised up. Dashed line showing the straight body alignment. No text labels, no shadows.`,
  },
  {
    id: 16,
    nom: 'Extension lombaire en décubitus ventral',
    prompt: `Flat 2D medical illustration, pure white background, clean clinical style. Side view of a person lying face-down on a mat. Upper body propped on forearms with elbows directly below shoulders (sphinx position). Lower abdomen and hips remain flat on the floor. This is NOT a full cobra — arms are bent, not straight. Gentle lumbar curve visible. Green upward arrow on the upper torso. No text labels, no shadows.`,
  },
  {
    id: 13,
    nom: 'Extension terminale du genou avec élastique',
    prompt: `Flat 2D medical illustration, pure white background, clean clinical style. Side view of a person standing. An elastic resistance band is looped behind the knee, attached to a fixed point in front. Person is extending the knee from 30-degree flexion to full extension against the band's resistance. Knee joint shown clearly. Green arrow on lower leg pointing forward. Red arrow indicating band resistance pulling backward. No text labels, no shadows.`,
  },
  {
    id: 23,
    nom: 'Pont fessier',
    prompt: `Flat 2D medical illustration, pure white background, clean clinical style. Side view of a person lying on their back. Both knees bent at 90 degrees, feet flat on floor. Hips raised high off the floor creating a straight line from knees through hips to shoulders. Shoulders and upper back remain on floor. Gluteal muscles highlighted with subtle orange. Green upward arrow at hip level. No text labels, no shadows.`,
  },
  {
    id: 27,
    nom: 'Clamshell (palourde)',
    prompt: `Flat 2D medical illustration, pure white background, clean clinical style. Side view of a person lying on their side. Hips bent at 45 degrees. Both knees stacked and bent at approximately 45 degrees. Both feet touching each other (staying together). The top knee is rotating upward and opening, like a clamshell opening, while feet remain together. Pelvis stable. Green arc arrow showing the knee opening. No text labels, no shadows.`,
  },
  {
    id: 54,
    nom: 'Dead bug (insecte mort)',
    prompt: `Flat 2D medical illustration, pure white background, clean clinical style. Side view of a person lying on their back. Both arms pointing straight up toward ceiling. Both knees at 90 degrees, thighs vertical. The movement being shown: right arm lowering toward floor overhead while simultaneously left leg extends straight downward toward floor. Lower back pressed flat to floor. Contralateral movement pattern clearly shown with green arrows. No text labels, no shadows.`,
  },
  {
    id: 55,
    nom: 'Bird-dog (chien-oiseau)',
    prompt: `Flat 2D medical illustration, pure white background, clean clinical style. Side view of a person on hands and knees (quadruped). Spine is neutral and horizontal. Right arm extended forward parallel to the floor and left leg extended backward parallel to the floor simultaneously. Hips level and square (no rotation). Head neutral aligned with spine. Dashed line showing straight arm-spine-leg alignment. Green arrows on extended arm and leg. No text labels, no shadows.`,
  },
  {
    id: 65,
    nom: 'Renforcement en Y (prone Y-raise)',
    prompt: `Flat 2D medical illustration, pure white background, clean clinical style. Side and partial rear view of a person lying face-down on a mat. Both arms raised and extended diagonally upward at approximately 45 degrees from the head direction, forming a Y shape when viewed from above. Thumbs pointing toward ceiling. Arms lifted a few inches off the surface. Deltoid and lower trapezius muscles subtly highlighted. Green arrows on both arms. No text labels, no shadows.`,
  },
  {
    id: 66,
    nom: 'Renforcement en T (prone T-raise)',
    prompt: `Flat 2D medical illustration, pure white background, clean clinical style. Rear and slight overhead view of a person lying face-down. Both arms extended horizontally outward to the sides forming a T shape, perpendicular to the body. Thumbs pointing upward toward ceiling. Arms lifted slightly off the surface. Shoulder blades visibly squeezed together. Middle trapezius and rhomboid muscles subtly highlighted. Green arrows on both arms. No text labels, no shadows.`,
  },
  {
    id: 53,
    nom: 'Gainage latéral',
    prompt: `Flat 2D medical illustration, pure white background, clean clinical style. Front/side view of a person in a side plank. Body supported on one forearm (elbow on floor, forearm pointing forward) and the side edge of the bottom foot. Both feet stacked. Body forms a straight diagonal line from head through hips to feet. Hips elevated — not sagging. Free arm resting on hip. Oblique muscle region subtly highlighted. Dashed line showing body alignment. No text labels, no shadows.`,
  },
  {
    id: 87,
    nom: 'Lever de talon unilatéral (Alfredson)',
    prompt: `Flat 2D medical illustration, pure white background, clean clinical style. Side view of a person standing on the edge of a step. Only the ball of the foot is on the step edge, with the heel hanging off and below the step level. This is the end of the eccentric descent — heel dropped below step edge. The other foot is lifted off (not touching anything). Calf muscle (gastrocnemius and soleus) subtly highlighted. Green downward arrow showing eccentric heel descent. Step edge clearly defined. No text labels, no shadows.`,
  },
  {
    id: 19,
    nom: 'Rotation du tronc assis',
    prompt: `Flat 2D medical illustration, pure white background, clean clinical style. Front view of a person seated on a chair, feet flat on the floor, knees at 90 degrees. Two overlaid positions shown: faint/dashed outline facing forward, solid outline with trunk rotated approximately 45 degrees to the right. Arms are crossed lightly over the chest. Green curved arrow at chest level showing the rotation direction. Pelvis and lower body remain facing forward (stable). Thoracic spine and ribcage clearly rotating while lumbar stays neutral. No text labels, no shadows.`,
  },
  {
    id: 5,
    nom: 'Renforcement rotation externe',
    prompt: `Flat 2D medical illustration, pure white background, clean clinical style. Front view of a person standing upright. Right elbow bent at 90 degrees and held firmly against the right side of the torso (not floating away from the body). An elastic resistance band extends horizontally from the left side (fixed point) to the right hand. The forearm is rotating outward (externally) away from the belly against the band resistance. Green curved arrow showing the external rotation of the forearm. Red arrow on the band showing resistance direction. Infraspinatus and teres minor muscles subtly highlighted in orange on the posterior shoulder. No text labels, no shadows.`,
  },
  {
    id: 14,
    nom: 'Proprioception sur plateau instable',
    prompt: `Flat 2D medical illustration, pure white background, clean clinical style. Front view of a person standing on one leg on a wobble board (a flat circular disc on a half-sphere base, creating an unstable surface). The standing leg is slightly bent at the knee. Arms are held out to the sides for balance. The other foot is lifted slightly off the board. The wobble board is shown tilting slightly to illustrate instability. Dashed vertical line from head through standing knee to board center showing alignment. No text labels, no shadows.`,
  },
  {
    id: 2,
    nom: 'Élévation antérieure passive',
    prompt: `Flat 2D medical illustration, pure white background, clean clinical style. Side view of a person lying on their back on a mat. The unaffected (healthy) arm grips the wrist of the affected arm. Both arms are being raised together upward toward the ceiling and then overhead in an arc. Two positions shown: faint/dashed at the start (arms resting on thighs) and solid at the end (arms raised overhead past vertical). The affected arm is passive — the healthy arm does all the work. Green arrow along the arc of motion showing the elevation path. Elbows remain straight throughout. No text labels, no shadows.`,
  },
  {
    id: 4,
    nom: 'Étirement capsulaire postérieur',
    prompt: `Flat 2D medical illustration, pure white background, clean clinical style. Front view of a person standing or seated upright. The right arm is brought horizontally across the chest at shoulder height. The left hand grips the right elbow area and gently pulls it further across. The right shoulder is kept low (not shrugged up). Green arrow showing the pull direction across the body. Posterior deltoid and posterior shoulder capsule region subtly highlighted in orange. The stretch targets the back of the shoulder. No text labels, no shadows.`,
  },
];

// POST /api/admin/regenerate-anatomy-images
// Regenerates 15 high-priority exercises with improved anatomical prompts.
// Auth: Authorization: Bearer <POLSIA_API_KEY>
router.post('/regenerate-anatomy-images', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (token !== process.env.POLSIA_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const targetId = req.query.exercise_id ? parseInt(req.query.exercise_id) : null;
  const targets = targetId
    ? ANATOMY_AUDIT_EXERCISES.filter(e => e.id === targetId)
    : ANATOMY_AUDIT_EXERCISES;

  if (targets.length === 0) {
    return res.status(404).json({ error: `Exercise ID ${targetId} not in anatomy audit list` });
  }

  res.status(202).json({
    message: 'Anatomy image regeneration started',
    total: targets.length,
    exercises: targets.map(e => ({ id: e.id, nom: e.nom })),
    note: 'Check server logs [anatomy] for progress. Expect ~3min per 5 exercises.',
  });

  const pool = router._mainPool;
  const openai = new OpenAI();
  const results = [];

  console.log(`[anatomy] === Starting anatomy regeneration: ${targets.length} exercises ===`);

  for (const exercise of targets) {
    console.log(`[anatomy] Processing [${exercise.id}] ${exercise.nom}`);
    try {
      const imageResponse = await openai.images.generate({
        model: 'dall-e-3',
        prompt: exercise.prompt,
        size: '1024x1024',
        quality: 'standard',
        n: 1,
      });
      const dalleUrl = imageResponse.data[0].url;
      const imageBuffer = await downloadImage(dalleUrl);
      const filename = `exercice-anatomy-${exercise.id}-${Date.now()}.png`;
      const r2Url = await uploadToR2(imageBuffer, filename);
      await pool.query('UPDATE exercices SET image_url = $1 WHERE id = $2', [r2Url, exercise.id]);
      console.log(`[anatomy] ✓ [${exercise.id}] ${exercise.nom} → ${r2Url}`);
      results.push({ id: exercise.id, nom: exercise.nom, status: 'success', url: r2Url });
    } catch (err) {
      console.error(`[anatomy] ✗ [${exercise.id}] ${exercise.nom} → ${err.message}`);
      results.push({ id: exercise.id, nom: exercise.nom, status: 'error', error: err.message });
    }
    // Rate limit: 3s between DALL-E calls
    await new Promise(r => setTimeout(r, 3000));
  }

  const successes = results.filter(r => r.status === 'success').length;
  console.log(`[anatomy] === DONE: ${successes}/${results.length} succeeded ===`);
  console.log('[anatomy] Results:', JSON.stringify(results, null, 2));
});

// GET /api/admin/health — quick check
router.get('/health', (req, res) => {
  res.json({ ok: true, anatomy_audit_count: ANATOMY_AUDIT_EXERCISES.length, routes: ['POST /api/admin/generate-batch2-images', 'POST /api/admin/retry-batch2-images', 'POST /api/admin/generate-batch3-images', 'POST /api/admin/regenerate-anatomy-images', 'POST /api/admin/seed-demo-patients'] });
});

// POST /api/admin/seed-demo-patients
// Populates the 10 demo kiné accounts with realistic fake patients.
// Idempotent: no-op if patients already exist for demo kines.
// Auth: Authorization: Bearer <POLSIA_API_KEY>
router.post('/seed-demo-patients', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (token !== process.env.POLSIA_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Respond immediately — seed runs async
  res.status(202).json({
    message: 'Demo patient seeding started',
    note: 'Check server logs [seed-demo] for progress.',
  });

  const pool = router._mainPool;
  const seeder = require('../scripts/seed-demo-patients');

  seeder.run(pool, (msg) => console.log(msg))
    .then((result) => {
      console.log('[seed-demo] Seed complete:', JSON.stringify(result));
    })
    .catch((err) => {
      console.error('[seed-demo] Seed FAILED:', err.message, err.stack);
    });
});

// Export factory so server.js can pass the main pool, avoiding separate DB connection issues
module.exports = (mainPool) => {
  // Patch pool references in route handlers to use the passed pool
  router._mainPool = mainPool;
  return router;
};
