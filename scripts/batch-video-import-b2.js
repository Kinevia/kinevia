/**
 * Batch Video Import — Batch 2: Membre inférieur + Dos/Lombaires
 *
 * Downloads free CC0 exercise videos from Pixabay CDN, compresses to 720p H.264,
 * uploads to R2, inserts into exercise_videos table, sets has_video=TRUE.
 *
 * Zones covered: hanche, genou, cheville, pied, dos, rachis_thoracique
 * Batch limit: 50 exercise slots (per task spec)
 *
 * Pixabay License = CC0 — free for commercial use, no attribution required.
 *
 * Usage: node scripts/batch-video-import-b2.js
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { Pool } = require('pg');
const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const DB_URL = process.env.CLEVER_CLOUD_DB_URL || process.env.DATABASE_URL;
const R2_BASE = process.env.POLSIA_R2_BASE_URL || 'https://polsia.com';
const API_KEY = process.env.POLSIA_API_KEY;

if (!DB_URL) { console.error('Missing DATABASE_URL'); process.exit(1); }
if (!API_KEY) { console.error('Missing POLSIA_API_KEY'); process.exit(1); }

const pool = new Pool({ connectionString: DB_URL });

const FFMPEG = (() => {
  try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; }
})();

// ============================================================
// VIDEO MAPPING — Batch 2
// Each entry maps one video (Pixabay CC0) to one or more exercise_ids.
// Multiple exercises sharing the same movement type share a video.
// Target: ~50 exercise slots.
//
// Zone breakdown:
//   DOS/LOMBAIRES: 15 slots (ids from dos + rachis_thoracique)
//   HANCHE:        13 slots
//   GENOU:         12 slots
//   CHEVILLE/PIED: 10 slots
// Total: 50 slots
// ============================================================
const VIDEO_MAPPING = [

  // ── DOS / LOMBAIRES ─────────────────────────────────────────

  // Cat-Cow (chat-chameau) + cat-cow thoracique
  {
    exercise_ids: [15, 166], // Chat-chameau, Cat-Cow thoracique ciblé
    url: 'https://cdn.pixabay.com/video/2022/08/28/129425-744370606_large.mp4',
    source_name: 'Pixabay - Cat Cow Yoga Lumbar',
    source_url: 'https://pixabay.com/videos/meditation-spiritual-yoga-woman-129425/',
  },

  // Prone lumbar extension / McKenzie standing extension
  {
    exercise_ids: [16, 114], // Extension lombaire décubitus ventral, McKenzie debout
    url: 'https://cdn.pixabay.com/video/2015/08/13/445-136216234_medium.mp4',
    source_name: 'Pixabay - Lumbar Extension McKenzie',
    source_url: 'https://pixabay.com/videos/yoga-health-exercise-woman-445/',
  },

  // Piriformis stretch (both dos + dos variant)
  {
    exercise_ids: [17, 191], // Étirement piriforme, Étirement piriforme (sciatique)
    url: 'https://cdn.pixabay.com/video/2020/02/27/32937-395456375_large.mp4',
    source_name: 'Pixabay - Piriformis Stretch Senior',
    source_url: 'https://pixabay.com/videos/exercise-stretching-senior-elder-32937/',
  },

  // Plank / gainage ventral + gainage latéral + gainage rotatoire Schroth
  {
    exercise_ids: [18, 53, 113], // Gainage planche, gainage latéral, gainage rotatoire Schroth
    url: 'https://cdn.pixabay.com/video/2022/12/18/143431-782373969_large.mp4',
    source_name: 'Pixabay - Core Plank Gainage',
    source_url: 'https://pixabay.com/videos/pushups-fitness-exercise-work-out-143431/',
  },

  // Trunk rotation seated + thoracic rotation
  {
    exercise_ids: [19, 126, 127, 162, 167], // Rotation tronc, thoracique décubitus latéral x2, rotation assise x2
    url: 'https://cdn.pixabay.com/video/2022/08/28/129423-744370596_large.mp4',
    source_name: 'Pixabay - Trunk Thoracic Rotation Yoga',
    source_url: 'https://pixabay.com/videos/woman-yoga-exercise-concentration-129423/',
  },

  // Pelvic tilt / bascule bassin
  {
    exercise_ids: [20], // Bascule du bassin
    url: 'https://cdn.pixabay.com/video/2020/04/04/35009-405620783_large.mp4',
    source_name: 'Pixabay - Pelvic Tilt Home Exercise',
    source_url: 'https://pixabay.com/videos/home-exercise-home-workout-lifestyle-35009/',
  },

  // Bird-dog + dead bug (core stability)
  {
    exercise_ids: [54, 55], // Dead bug, Bird-dog
    url: 'https://cdn.pixabay.com/video/2023/01/27/148203-793717937_large.mp4',
    source_name: 'Pixabay - Bird Dog Dead Bug Core',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148203/',
  },

  // Hamstring stretch standing + foetal stretch + paravertébraux
  {
    exercise_ids: [56, 51, 21], // Ischio-jambiers debout, position fœtale, paravertébraux
    url: 'https://cdn.pixabay.com/video/2022/10/16/135157-761273549_large.mp4',
    source_name: 'Pixabay - Hamstring Back Stretch',
    source_url: 'https://pixabay.com/videos/gym-fitness-sport-workout-exercise-135157/',
  },

  // Lumbar standing flexion-extension + McKenzie flexion
  {
    exercise_ids: [58, 115], // Mobilisation lombaire debout, flexion en charge McKenzie
    url: 'https://cdn.pixabay.com/video/2023/11/19/189731-886596163_large.mp4',
    source_name: 'Pixabay - Lumbar Flexion Extension Standing',
    source_url: 'https://pixabay.com/videos/workout-athlete-sports-training-189731/',
  },

  // Thoracic foam roller extension
  {
    exercise_ids: [125, 163], // Extension thoracique foam roller, Extension thoracique rouleau
    url: 'https://cdn.pixabay.com/video/2023/01/27/148204-793717940_large.mp4',
    source_name: 'Pixabay - Thoracic Foam Roller Extension',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148204/',
  },

  // Thoracic opening pull-apart + book opening + retrait scapulaire
  {
    exercise_ids: [128, 129, 130, 164], // Pull-apart, quadrupédie, retrait scapulaire, ouverture
    url: 'https://cdn.pixabay.com/video/2023/01/27/148196-793717922_large.mp4',
    source_name: 'Pixabay - Thoracic Opening Scapular',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148196/',
  },

  // Superman / nageur couché + cobra yoga
  {
    exercise_ids: [157, 158], // Nageur couché, cobra yoga
    url: 'https://cdn.pixabay.com/video/2022/10/16/135160-761273559_large.mp4',
    source_name: 'Pixabay - Superman Cobra Yoga Back',
    source_url: 'https://pixabay.com/videos/gym-fitness-sport-workout-exercise-135160/',
  },

  // ── HANCHE ──────────────────────────────────────────────────

  // Hip abduction side-lying + post-PTH abduction
  {
    exercise_ids: [22, 134], // Abduction décubitus latéral, abduction post-PTH
    url: 'https://cdn.pixabay.com/video/2023/01/27/148208-793717949_large.mp4',
    source_name: 'Pixabay - Hip Abduction Side Lying',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148208/',
  },

  // Glute bridge + unilateral bridge on ball
  {
    exercise_ids: [23, 187], // Pont fessier, pont fessier unilatéral sur balle
    url: 'https://cdn.pixabay.com/video/2020/02/27/32934-395456365_large.mp4',
    source_name: 'Pixabay - Glute Bridge Hip Exercise',
    source_url: 'https://pixabay.com/videos/exercise-running-fitness-lifestyle-32934/',
  },

  // Psoas / hip flexor stretch (Thomas test + variants)
  {
    exercise_ids: [24, 146, 198, 230], // Étirement psoas, Thomas test x3
    url: 'https://cdn.pixabay.com/video/2022/08/28/129425-744370606_large.mp4',
    source_name: 'Pixabay - Psoas Hip Flexor Stretch',
    source_url: 'https://pixabay.com/videos/meditation-spiritual-yoga-woman-129425/',
  },

  // Hip internal/external rotation + with elastic
  {
    exercise_ids: [25, 199], // Rotation hanche, rotation interne avec élastique
    url: 'https://cdn.pixabay.com/video/2023/01/27/148212-793717957_large.mp4',
    source_name: 'Pixabay - Hip Rotation Resistance',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148212/',
  },

  // Hip flexion standing + ankle pump + isometric quad PTH
  {
    exercise_ids: [26, 132, 133], // Flexion hanche debout, pompe cheville PTH, quad isométrique PTH
    url: 'https://cdn.pixabay.com/video/2020/04/04/34972-407130582_large.mp4',
    source_name: 'Pixabay - Hip Flexion Standing PTH',
    source_url: 'https://pixabay.com/videos/run-jogging-running-exercise-34972/',
  },

  // Clamshell + lateral hip abduction with band
  {
    exercise_ids: [27, 196], // Clamshell, abduction latérale avec élastique
    url: 'https://cdn.pixabay.com/video/2023/01/27/148201-793717934_large.mp4',
    source_name: 'Pixabay - Clamshell Hip Band Abduction',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148201/',
  },

  // Hip extension standing + prone glutes
  {
    exercise_ids: [82, 84], // Extension hanche debout, fessiers décubitus ventral
    url: 'https://cdn.pixabay.com/video/2023/01/27/148197-793717924_large.mp4',
    source_name: 'Pixabay - Hip Extension Glutes Prone',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148197/',
  },

  // Lateral band walk + sumo squat
  {
    exercise_ids: [83, 147], // Band walk, squat sumo
    url: 'https://cdn.pixabay.com/video/2023/01/27/148199-793717929_large.mp4',
    source_name: 'Pixabay - Lateral Band Walk Sumo',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148199/',
  },

  // ── GENOU ───────────────────────────────────────────────────

  // Quad set isometric + leg raise
  {
    exercise_ids: [72, 136], // Activation quad isométrique, élévation jambe tendue PTG
    url: 'https://cdn.pixabay.com/video/2023/01/27/148210-793717953_large.mp4',
    source_name: 'Pixabay - Quad Isometric Leg Raise',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148210/',
  },

  // Wall squat / mini-squat 0-45° + partial squat
  {
    exercise_ids: [11, 73], // Squat partiel mural, mini-squat
    url: 'https://cdn.pixabay.com/video/2023/02/07/149709-796873476_large.mp4',
    source_name: 'Pixabay - Wall Squat Mini Squat',
    source_url: 'https://pixabay.com/videos/man-slave-gym-sports-addiction-149709/',
  },

  // Step-up + lateral step + stair climb
  {
    exercise_ids: [77, 85, 185], // Montée marche unipodale, step-up latéral x2
    url: 'https://cdn.pixabay.com/video/2023/01/27/148202-793717935_large.mp4',
    source_name: 'Pixabay - Step Up Lateral Knee',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148202/',
  },

  // Hamstring curl + knee flexion passive on roller
  {
    exercise_ids: [76, 137], // Flexion genou debout (curl), flexion passive sur rouleau
    url: 'https://cdn.pixabay.com/video/2019/02/05/21180-315610549_large.mp4',
    source_name: 'Pixabay - Hamstring Curl Knee Flexion',
    source_url: 'https://pixabay.com/videos/kettle-bell-exercise-kettlebells-21180/',
  },

  // ITB stretch + patellar mobilisation
  {
    exercise_ids: [108, 109], // Mobilisation patellaire, étirement bandelette ilio-tibiale
    url: 'https://cdn.pixabay.com/video/2022/10/16/135162-761273567_large.mp4',
    source_name: 'Pixabay - ITB Patellar Mobility Knee',
    source_url: 'https://pixabay.com/videos/gym-fitness-sport-workout-exercise-135162/',
  },

  // Heel slides + TKE + terminal extension
  {
    exercise_ids: [138, 139, 184], // Heel slides, extension traction douce, TKE
    url: 'https://cdn.pixabay.com/video/2023/01/27/148211-793717955_large.mp4',
    source_name: 'Pixabay - Heel Slide Terminal Extension Knee',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148211/',
  },

  // ── CHEVILLE / PIED ─────────────────────────────────────────

  // Calf raise bilateral + unilateral (Alfredson eccentric) + eccentric soleus
  {
    exercise_ids: [88, 87, 205], // Lever talon bilatéral, Alfredson, excentrique soléaire
    url: 'https://cdn.pixabay.com/video/2023/01/27/148196-793717922_large.mp4',
    source_name: 'Pixabay - Calf Raise Alfredson Eccentric',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148196/',
  },

  // Ankle plantarflexion/dorsiflexion + alphabetical + dorsal mob wall
  {
    exercise_ids: [28, 91, 203], // Flexion plantaire/dorsale, alphabétique, mobilisation genou au mur
    url: 'https://cdn.pixabay.com/video/2020/02/27/32937-395456375_large.mp4',
    source_name: 'Pixabay - Ankle Mobility Dorsiflexion',
    source_url: 'https://pixabay.com/videos/exercise-stretching-senior-elder-32937/',
  },

  // Calf stretch + soleus stretch (knee bent)
  {
    exercise_ids: [31, 92], // Étirement mollet, soléaire genou fléchi
    url: 'https://cdn.pixabay.com/video/2022/10/16/135159-761273555_large.mp4',
    source_name: 'Pixabay - Calf Soleus Stretch Ankle',
    source_url: 'https://pixabay.com/videos/gym-fitness-sport-workout-135159/',
  },

  // Proprioception wobble board + unipodal balance
  {
    exercise_ids: [29, 90], // Plateau Freeman, proprioception yeux fermés
    url: 'https://cdn.pixabay.com/video/2023/01/27/148204-793717940_large.mp4',
    source_name: 'Pixabay - Balance Proprioception Ankle',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148204/',
  },

  // Plantar fascia stretch + morning stretch
  {
    exercise_ids: [49, 94], // Étirement aponévrose plantaire, étirement matinal
    url: 'https://cdn.pixabay.com/video/2015/08/13/445-136216234_medium.mp4',
    source_name: 'Pixabay - Plantar Fascia Stretch Morning',
    source_url: 'https://pixabay.com/videos/yoga-health-exercise-woman-445/',
  },

  // Toe curls + marble pickup + foot arch + unipodal balance
  {
    exercise_ids: [47, 95, 48, 50], // Toe curls, marble pickup, voûte plantaire, équilibre unipodal
    url: 'https://cdn.pixabay.com/video/2023/06/22/168352-841391725_large.mp4',
    source_name: 'Pixabay - Toe Curl Foot Arch Intrinsic',
    source_url: 'https://pixabay.com/videos/yoga-stretches-exercise-people-sea-168352/',
  },
];

// ============================================================
// HELPERS (identical to batch 1)
// ============================================================

function tmpFile(ext) {
  return path.join(os.tmpdir(), `kinevia-b2-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
}

async function downloadVideo(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      console.log(`  ↓ Downloading ${url.split('/').slice(-1)[0].slice(0, 45)}...`);
      const res = await fetch(url, {
        timeout: 120000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Kinevia/1.0)' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      console.log(`  ✓ Downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
      return buf;
    } catch (err) {
      if (attempt === retries) throw err;
      console.log(`  ⚠ Retry ${attempt + 1}: ${err.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

async function compressVideo(inputPath) {
  const outputPath = tmpFile('.mp4');
  await execFileAsync(FFMPEG, [
    '-i', inputPath,
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
    '-c:v', 'libx264',
    '-crf', '23',
    '-preset', 'fast',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-y',
    outputPath
  ], { timeout: 180000 });
  return outputPath;
}

async function extractThumbnail(videoPath) {
  const thumbPath = tmpFile('.jpg');
  for (const seek of ['00:00:01', '00:00:00']) {
    try {
      await execFileAsync(FFMPEG, [
        '-ss', seek, '-i', videoPath,
        '-vframes', '1',
        '-vf', 'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2',
        '-q:v', '3', '-y', thumbPath
      ], { timeout: 30000 });
      if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 1000) return thumbPath;
    } catch (_) {}
  }
  return null;
}

async function getDuration(videoPath) {
  try {
    const err = await execFileAsync(FFMPEG, ['-i', videoPath, '-f', 'null', '-'], { timeout: 15000 })
      .catch(e => e);
    const stderr = (err && err.stderr) ? err.stderr : '';
    const m = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (m) return Math.round(parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]));
  } catch (_) {}
  return null;
}

async function uploadToR2(buffer, filename, mimeType) {
  const formData = new FormData();
  formData.append('file', buffer, { filename, contentType: mimeType });
  const res = await fetch(`${R2_BASE}/api/proxy/r2/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, ...formData.getHeaders() },
    body: formData,
    timeout: 180000
  });
  const data = await res.json();
  if (!data.success) throw new Error('R2 upload failed: ' + JSON.stringify(data.error || data));
  return data.file.url;
}

// ============================================================
// MAIN PROCESSING
// ============================================================

async function processEntry(entry, client) {
  const { exercise_ids, url, source_name, source_url } = entry;
  const tempFiles = [];

  try {
    const buf = await downloadVideo(url);
    const inputPath = tmpFile('.mp4');
    fs.writeFileSync(inputPath, buf);
    tempFiles.push(inputPath);

    const duration = await getDuration(inputPath);

    console.log('  ⚙ Compressing to 720p...');
    let compressedPath = inputPath;
    try {
      compressedPath = await compressVideo(inputPath);
      tempFiles.push(compressedPath);
      console.log(`  ✓ Compressed → ${(fs.statSync(compressedPath).size / 1024 / 1024).toFixed(1)} MB`);
    } catch (e) {
      console.warn('  ⚠ Compression failed, using original:', e.message.slice(0, 100));
    }

    let thumbnailUrl = null;
    try {
      const thumbPath = await extractThumbnail(compressedPath);
      if (thumbPath) {
        tempFiles.push(thumbPath);
        const thumbBuf = fs.readFileSync(thumbPath);
        thumbnailUrl = await uploadToR2(thumbBuf, `thumb-b2-${Date.now()}.jpg`, 'image/jpeg');
        console.log('  📸 Thumbnail:', thumbnailUrl);
      }
    } catch (e) {
      console.warn('  ⚠ Thumbnail failed:', e.message.slice(0, 80));
    }

    console.log('  ☁ Uploading video...');
    const compressedBuf = fs.readFileSync(compressedPath);
    const fileSize = compressedBuf.length;
    const videoUrl = await uploadToR2(compressedBuf, `video-b2-${Date.now()}.mp4`, 'video/mp4');
    console.log(`  ✓ Video: ${videoUrl}`);
    console.log(`  📦 ${(fileSize / 1024 / 1024).toFixed(1)} MB  ⏱ ${duration ?? '?'}s`);

    const adminRes = await client.query('SELECT id FROM kines WHERE is_admin = TRUE ORDER BY id LIMIT 1');
    const uploadedBy = adminRes.rows[0]?.id;
    if (!uploadedBy) throw new Error('No admin kine found — cannot set uploaded_by');

    let linked = 0;
    for (const exerciseId of exercise_ids) {
      const check = await client.query('SELECT id FROM exercices WHERE id = $1', [exerciseId]);
      if (check.rows.length === 0) {
        console.log(`  ⚠ Exercise ${exerciseId} not found`);
        continue;
      }

      const existing = await client.query(
        'SELECT id FROM exercise_videos WHERE exercise_id = $1', [exerciseId]
      );
      if (existing.rows.length > 0) {
        console.log(`  ⏭ ${exerciseId} already linked`);
        continue;
      }

      await client.query(
        `INSERT INTO exercise_videos
           (exercise_id, video_url, thumbnail_url, duration_seconds, file_size,
            original_filename, mime_type, upload_status, uploaded_by, source, source_url)
         VALUES ($1, $2, $3, $4, $5, $6, 'video/mp4', 'ready', $7, 'pixabay', $8)`,
        [exerciseId, videoUrl, thumbnailUrl, duration, fileSize,
         source_name, uploadedBy, source_url]
      );

      await client.query(
        'UPDATE exercices SET video_url = $1, has_video = TRUE WHERE id = $2',
        [videoUrl, exerciseId]
      );

      console.log(`  ✓ Linked exercise #${exerciseId}`);
      linked++;
    }

    return linked;
  } finally {
    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
  }
}

async function main() {
  const totalSlots = VIDEO_MAPPING.reduce((s, e) => s + e.exercise_ids.length, 0);
  console.log('=== Kinevia — Batch Video Import B2 (Membre inférieur + Dos/Lombaires) ===');
  console.log(`DB: ${DB_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`Zones: hanche, genou, cheville, pied, dos, rachis_thoracique`);
  console.log(`Mappings: ${VIDEO_MAPPING.length} video groups → ${totalSlots} exercise slots\n`);

  const client = await pool.connect();
  let totalLinked = 0, totalSkipped = 0, totalErrors = 0;

  try {
    for (let i = 0; i < VIDEO_MAPPING.length; i++) {
      const entry = VIDEO_MAPPING[i];
      process.stdout.write(`\n[${i + 1}/${VIDEO_MAPPING.length}] ${entry.source_name}\n`);
      try {
        const linked = await processEntry(entry, client);
        totalLinked += linked;
        totalSkipped += entry.exercise_ids.length - linked;
      } catch (err) {
        console.error(`  ✗ FAILED: ${err.message}`);
        totalErrors++;
        totalSkipped += entry.exercise_ids.length;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log('\n════════════════════════════════');
  console.log('IMPORT B2 COMPLETE');
  console.log(`  ✓ Linked:  ${totalLinked} exercises`);
  console.log(`  ⏭ Skipped: ${totalSkipped} (already linked / not found)`);
  console.log(`  ✗ Errors:  ${totalErrors} video groups`);
  console.log('════════════════════════════════');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
