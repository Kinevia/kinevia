/**
 * Regenerate exercise images with better anatomical accuracy.
 * Targets the 15 most-prescribed exercises with known DALL-E failure patterns.
 *
 * Usage: node scripts/regenerate-images-anatomy.js [--dry-run] [--exercise-id=N]
 *
 * Replaces images in-place in the database — URLs change but old R2 files are NOT deleted
 * (intentional: CDN may have cached old URLs; old records still viewable if needed).
 */

require('dotenv').config();
const { Pool } = require('pg');
const OpenAI = require('openai');
const fetch = require('node-fetch');
const FormData = require('form-data');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const openai = new OpenAI();

const DRY_RUN = process.argv.includes('--dry-run');
const EXERCISE_ID_ARG = process.argv.find(a => a.startsWith('--exercise-id='));
const TARGET_ID = EXERCISE_ID_ARG ? parseInt(EXERCISE_ID_ARG.split('=')[1]) : null;

// Base style applied to all prompts for visual consistency
const BASE_STYLE = [
  'flat 2D medical illustration',
  'clean white background',
  'simple line art with minimal color fills',
  'anatomically accurate human figure',
  'no text labels',
  'professional physiotherapy handout style',
  'side or three-quarter view unless specified',
].join(', ');

// Each entry: exercise id, French name, and a precise anatomical prompt
const EXERCISES_TO_REGENERATE = [
  {
    id: 15,
    nom: 'Chat-chameau',
    prompt: `Medical illustration of the cat-cow exercise (chat-chameau). Two positions shown side by side: LEFT: human figure on hands and knees (quadruped position), spine arched downward in extension (cow pose / chameau) with head raised and lower back curved inward. RIGHT: same figure with spine rounded upward in flexion (cat pose / chat) with head lowered and lower back curved outward. Wrists under shoulders, knees under hips. ${BASE_STYLE}`,
  },
  {
    id: 20,
    nom: 'Bascule du bassin',
    prompt: `Medical illustration of pelvic tilt exercise (bascule du bassin). Human figure lying on back (supine) with knees bent, feet flat on floor. Two positions: LEFT: anterior pelvic tilt — small arch under lumbar spine visible between back and floor. RIGHT: posterior pelvic tilt — lumbar spine pressed flat against floor, pelvis slightly rotated backward. Clear side profile view showing the lumbar curve difference. ${BASE_STYLE}`,
  },
  {
    id: 9,
    nom: 'Renforcement quadriceps (chaise)',
    prompt: `Medical illustration of seated leg extension for quadriceps strengthening. Human figure seated on a chair, one leg extended horizontally parallel to the floor, knee fully straightened. Other foot flat on ground. Leg held up at 90 degrees from vertical (horizontal). Clear quadriceps muscle highlighted. Side view. ${BASE_STYLE}`,
  },
  {
    id: 11,
    nom: 'Squat partiel mural',
    prompt: `Medical illustration of wall squat (squat partiel mural). Human figure with back flat against a wall, feet placed 30-40cm away from the wall, knees bent to approximately 45 degrees (NOT a full squat). Knees aligned directly above toes (no valgus collapse). Thighs at 45-degree angle to floor. Side view showing back contact with wall. ${BASE_STYLE}`,
  },
  {
    id: 18,
    nom: 'Gainage planche ventrale',
    prompt: `Medical illustration of prone forearm plank (gainage planche ventrale). Human figure face-down, supported on forearms (elbows at 90 degrees, forearms flat on floor) and toes. Body forms a perfectly straight diagonal line from head to heels. Hips NOT sagging down or raised up — level with shoulders. Side profile view. ${BASE_STYLE}`,
  },
  {
    id: 16,
    nom: 'Extension lombaire en décubitus ventral',
    prompt: `Medical illustration of prone press-up on forearms (extension lombaire décubitus ventral). Human figure lying face-down on stomach, propped up on forearms with elbows directly below shoulders. Upper torso raised, lower abdomen and hips remain on the floor. NOT a full cobra (no straight arms). Gentle lumbar extension. Side profile view. ${BASE_STYLE}`,
  },
  {
    id: 13,
    nom: 'Extension terminale du genou',
    prompt: `Medical illustration of terminal knee extension exercise with resistance band. Human figure standing, elastic resistance band looped behind the knee at 30-degree flexion start position. Knee fully extends against band resistance. Foot flat on ground, other leg in normal standing position. The elastic band attached to a fixed point in front. Side view showing knee movement. ${BASE_STYLE}`,
  },
  {
    id: 23,
    nom: 'Pont fessier',
    prompt: `Medical illustration of glute bridge (pont fessier). Human figure lying on back (supine), both knees bent at 90 degrees, feet flat on floor. Hips raised high off the floor, forming a straight diagonal line from knees through hips to shoulders. Shoulders remain on floor. Bottom contracted. Side profile view. ${BASE_STYLE}`,
  },
  {
    id: 27,
    nom: 'Clamshell (palourde)',
    prompt: `Medical illustration of clamshell exercise (exercice de la palourde). Human figure lying on their side, hips bent at 45 degrees, knees stacked and bent at 45 degrees. Both feet together (touching). Top knee rotated upward and open (like a clamshell opening) while feet stay together. Pelvis stable and not rolling. Clear side view. ${BASE_STYLE}`,
  },
  {
    id: 54,
    nom: 'Dead bug (insecte mort)',
    prompt: `Medical illustration of dead bug exercise. Human figure lying on back, both arms pointing straight up toward ceiling, both knees bent at 90 degrees with thighs vertical. In motion: right arm lowering toward floor overhead while left leg extends and straightens toward floor simultaneously. Lower back pressed flat to floor throughout. ${BASE_STYLE}`,
  },
  {
    id: 55,
    nom: 'Bird-dog (chien-oiseau)',
    prompt: `Medical illustration of bird-dog exercise. Human figure on hands and knees (quadruped), spine neutral and flat. Right arm extended forward parallel to floor, left leg extended backward parallel to floor simultaneously. Hips level and square to floor (no rotation). Head in neutral position aligned with spine. ${BASE_STYLE}`,
  },
  {
    id: 65,
    nom: 'Renforcement abduction en Y',
    prompt: `Medical illustration of prone Y-raise exercise for shoulder strengthening. Human figure lying face-down on a flat surface, both arms raised and extended diagonally upward to form a Y shape (approximately 45 degrees from head direction). Thumbs pointing toward ceiling. Arms lifted a few inches off the surface. Forehead may rest on floor or slight head lift. ${BASE_STYLE}`,
  },
  {
    id: 66,
    nom: 'Renforcement en T (abduction horizontale)',
    prompt: `Medical illustration of prone T-raise exercise (renforcement en T). Human figure lying face-down on a flat surface, both arms extended horizontally outward to the sides forming a T shape (perpendicular to body). Thumbs pointing upward. Arms lifted slightly off the surface, shoulder blades squeezed together. Head neutral or slightly raised. ${BASE_STYLE}`,
  },
  {
    id: 53,
    nom: 'Gainage latéral',
    prompt: `Medical illustration of side plank (gainage latéral). Human figure lying on their side, entire body weight supported on one forearm and the side of one foot (feet stacked). Body forms a straight diagonal line from head through hips to feet. Hips NOT sagging — elevated to create body alignment. Free arm extended upward or resting on hip. ${BASE_STYLE}`,
  },
  {
    id: 87,
    nom: 'Lever de talon unilatéral (Alfredson)',
    prompt: `Medical illustration of Alfredson eccentric heel drop exercise. Human figure standing on the edge of a step with just the ball of one foot on the step edge, heel hanging off. One leg slightly bent (injured side). Other foot lifted off step. Starting from raised toes position, heel slowly lowering down below step level performing eccentric calf contraction. Side profile view showing step edge clearly. ${BASE_STYLE}`,
  },
];

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
    throw new Error(`R2 upload failed: ${result.error?.message || JSON.stringify(result)}`);
  }
  return result.file.url;
}

async function generateAndUpload(exercise) {
  console.log(`\n[${exercise.id}] Generating: ${exercise.nom}`);

  // Generate via DALL-E 3
  const imageResponse = await openai.images.generate({
    model: 'dall-e-3',
    prompt: exercise.prompt,
    size: '1024x1024',
    quality: 'standard',
    n: 1,
  });

  const imageUrl = imageResponse.data[0].url;
  console.log(`  ✓ DALL-E 3 generated image`);

  // Download the image
  const imgFetch = await fetch(imageUrl);
  if (!imgFetch.ok) throw new Error(`Failed to download image: ${imgFetch.status}`);
  const imageBuffer = Buffer.from(await imgFetch.arrayBuffer());
  console.log(`  ✓ Downloaded (${Math.round(imageBuffer.length / 1024)}KB)`);

  // Upload to R2
  const filename = `exercise_${exercise.id}_anatomy_${Date.now()}.png`;
  const r2Url = await uploadToR2(imageBuffer, filename);
  console.log(`  ✓ Uploaded to R2: ${r2Url}`);

  return r2Url;
}

async function updateExerciseImage(exerciseId, newUrl) {
  await pool.query(
    'UPDATE exercices SET image_url = $1 WHERE id = $2',
    [newUrl, exerciseId]
  );
  console.log(`  ✓ DB updated for exercise ${exerciseId}`);
}

async function main() {
  const targets = TARGET_ID
    ? EXERCISES_TO_REGENERATE.filter(e => e.id === TARGET_ID)
    : EXERCISES_TO_REGENERATE;

  if (targets.length === 0) {
    console.error(`Exercise ID ${TARGET_ID} not in regeneration list`);
    process.exit(1);
  }

  console.log(`=== Anatomy Image Regeneration ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}`);
  console.log(`Exercises to process: ${targets.length}`);
  console.log('');

  const results = [];
  let successCount = 0;
  let failCount = 0;

  for (const exercise of targets) {
    try {
      if (DRY_RUN) {
        console.log(`[DRY RUN] Would regenerate: [${exercise.id}] ${exercise.nom}`);
        results.push({ id: exercise.id, nom: exercise.nom, status: 'dry-run' });
        continue;
      }

      const newUrl = await generateAndUpload(exercise);
      await updateExerciseImage(exercise.id, newUrl);
      results.push({ id: exercise.id, nom: exercise.nom, status: 'success', url: newUrl });
      successCount++;

      // Rate limiting: wait 3s between DALL-E calls to avoid hitting rate limits
      if (targets.indexOf(exercise) < targets.length - 1) {
        console.log('  Waiting 3s before next generation...');
        await new Promise(r => setTimeout(r, 3000));
      }
    } catch (err) {
      console.error(`  ✗ FAILED [${exercise.id}] ${exercise.nom}: ${err.message}`);
      results.push({ id: exercise.id, nom: exercise.nom, status: 'failed', error: err.message });
      failCount++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Success: ${successCount}/${targets.length}`);
  console.log(`Failed: ${failCount}`);
  if (failCount > 0) {
    console.log('\nFailed exercises:');
    results.filter(r => r.status === 'failed').forEach(r => {
      console.log(`  - [${r.id}] ${r.nom}: ${r.error}`);
    });
  }

  await pool.end();
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
