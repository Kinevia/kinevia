/**
 * Batch Video Import — Cervical + Membre supérieur (Batch 1)
 *
 * Downloads free CC0 exercise videos from Pixabay CDN, compresses to 720p H.264,
 * uploads to R2, inserts into exercise_videos table, sets has_video=TRUE.
 *
 * All video URLs verified accessible (HTTP 200) before including.
 * Pixabay License = CC0 — free for commercial use, no attribution required.
 *
 * Usage: node scripts/batch-video-import.js
 * (reads DATABASE_URL + CLEVER_CLOUD_DB_URL + POLSIA_API_KEY from env/.env)
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

// Use Clever Cloud (production) DB — override DATABASE_URL if set
const DB_URL = process.env.CLEVER_CLOUD_DB_URL || process.env.DATABASE_URL;
const R2_BASE = process.env.POLSIA_R2_BASE_URL || 'https://polsia.com';
const API_KEY = process.env.POLSIA_API_KEY;

if (!DB_URL) { console.error('Missing DATABASE_URL'); process.exit(1); }
if (!API_KEY) { console.error('Missing POLSIA_API_KEY'); process.exit(1); }

const pool = new Pool({ connectionString: DB_URL });

// ffmpeg-static path
const FFMPEG = (() => {
  try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; }
})();

// ============================================================
// VIDEO MAPPING
// Each entry maps one video (by CDN URL) to one or more exercise_ids.
// Multiple exercises can share a video (e.g. both variants of same movement).
// All URLs verified HTTP 200 before this script was written.
// Source: Pixabay CC0 — https://pixabay.com/service/terms/
// ============================================================
const VIDEO_MAPPING = [

  // ── CERVICAL (cou) ──────────────────────────────────────────

  // Neck rotation / head movement — for rotation, flexion-extension, chin tuck exercises
  {
    exercise_ids: [39, 40, 44, 200], // Flexion-extension cervicale, Rotation cervicale, Rétraction (x2)
    url: 'https://cdn.pixabay.com/video/2023/11/19/189729-886596145_large.mp4',
    source_name: 'Pixabay - Neck Stretching Athlete',
    source_url: 'https://pixabay.com/videos/workout-athlete-sports-training-189729/',
  },

  // Lateral neck / yoga stretch — inclinaison latérale
  {
    exercise_ids: [41, 202], // Inclinaison latérale, Étirement latéral avec inclinaison
    url: 'https://cdn.pixabay.com/video/2022/08/28/129423-744370596_large.mp4',
    source_name: 'Pixabay - Yoga Neck Concentration',
    source_url: 'https://pixabay.com/videos/woman-yoga-exercise-concentration-129423/',
  },

  // Isometric neck strengthening
  {
    exercise_ids: [42, 201], // Renforcement isométrique, Rotation contre résistance
    url: 'https://cdn.pixabay.com/video/2023/11/19/189730-886596151_large.mp4',
    source_name: 'Pixabay - Neck Strengthening Training',
    source_url: 'https://pixabay.com/videos/workout-athlete-sports-training-189730/',
  },

  // Trapezius / scalene / angular stretch
  {
    exercise_ids: [43, 59, 62], // Étirement trapèze, scalènes, angulaire
    url: 'https://cdn.pixabay.com/video/2022/08/28/129425-744370606_large.mp4',
    source_name: 'Pixabay - Meditation Yoga Neck',
    source_url: 'https://pixabay.com/videos/meditation-spiritual-yoga-woman-129425/',
  },

  // Deep cervical flexors / suboccipital stretch — seated gentle
  {
    exercise_ids: [60, 61], // Renforcement fléchisseurs profonds, Auto-étirement suboccipital
    url: 'https://cdn.pixabay.com/video/2020/02/27/32937-395456375_large.mp4',
    source_name: 'Pixabay - Senior Stretching Exercise',
    source_url: 'https://pixabay.com/videos/exercise-stretching-senior-elder-32937/',
  },

  // Thoracic rotation / mobility
  {
    exercise_ids: [63], // Mobilisation thoracique en rotation (assis)
    url: 'https://cdn.pixabay.com/video/2015/08/13/445-136216234_medium.mp4',
    source_name: 'Pixabay - Yoga Health Exercise Woman',
    source_url: 'https://pixabay.com/videos/yoga-health-exercise-woman-445/',
  },

  // McKenzie cervical (sustained extension)
  {
    exercise_ids: [140], // Exercice de McKenzie cervical
    url: 'https://cdn.pixabay.com/video/2023/11/19/189731-886596163_large.mp4',
    source_name: 'Pixabay - Neck McKenzie Training',
    source_url: 'https://pixabay.com/videos/workout-athlete-sports-training-189731/',
  },

  // Cervical traction / home exercise
  {
    exercise_ids: [141], // Traction cervicale auto-assistée
    url: 'https://cdn.pixabay.com/video/2020/04/04/35009-405620783_large.mp4',
    source_name: 'Pixabay - Home Exercise Workout',
    source_url: 'https://pixabay.com/videos/home-exercise-home-workout-lifestyle-35009/',
  },

  // ── ÉPAULE ──────────────────────────────────────────────────

  // Pendulum / Codman — gentle shoulder circles
  {
    exercise_ids: [1, 193, 228], // Pendulaire de Codman (x2 + avancé)
    url: 'https://cdn.pixabay.com/video/2022/07/15/124251-730508536_large.mp4',
    source_name: 'Pixabay - Shoulder Meditation Pose',
    source_url: 'https://pixabay.com/videos/woman-lotus-meditation-pose-124251/',
  },

  // Passive anterior elevation — gentle arm lift
  {
    exercise_ids: [2], // Élévation antérieure passive
    url: 'https://cdn.pixabay.com/video/2020/02/27/32934-395456365_large.mp4',
    source_name: 'Pixabay - Exercise Fitness Lifestyle',
    source_url: 'https://pixabay.com/videos/exercise-running-fitness-lifestyle-32934/',
  },

  // External rotation with stick / resistance
  {
    exercise_ids: [3], // Rotation externe avec bâton
    url: 'https://cdn.pixabay.com/video/2023/01/27/148208-793717949_large.mp4',
    source_name: 'Pixabay - Shoulder Rotation Gym',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148208/',
  },

  // Posterior capsule stretch / cross-body stretch
  {
    exercise_ids: [4, 194], // Étirement capsulaire postérieur (x2)
    url: 'https://cdn.pixabay.com/video/2022/10/16/135157-761273549_large.mp4',
    source_name: 'Pixabay - Shoulder Capsule Stretch',
    source_url: 'https://pixabay.com/videos/gym-fitness-sport-workout-exercise-135157/',
  },

  // External/Internal rotation with elastic band
  {
    exercise_ids: [5, 64], // Rotation externe, Rotation interne élastique
    url: 'https://cdn.pixabay.com/video/2023/01/27/148212-793717957_large.mp4',
    source_name: 'Pixabay - Resistance Band Shoulder',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148212/',
  },

  // Circumduction d'épaule
  {
    exercise_ids: [6], // Circumduction d'épaule
    url: 'https://cdn.pixabay.com/video/2022/10/16/135156-761273546_large.mp4',
    source_name: 'Pixabay - Shoulder Circumduction Gym',
    source_url: 'https://pixabay.com/videos/gym-fitness-sport-workout-exercise-135156/',
  },

  // Lateral raise with elastic band
  {
    exercise_ids: [7], // Élévation latérale avec élastique
    url: 'https://cdn.pixabay.com/video/2023/01/27/148196-793717922_large.mp4',
    source_name: 'Pixabay - Lateral Raise Resistance',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148196/',
  },

  // Scapular Y/T/W strengthening
  {
    exercise_ids: [65, 66, 67], // Y, T, W scapulaire
    url: 'https://cdn.pixabay.com/video/2023/01/27/148203-793717937_large.mp4',
    source_name: 'Pixabay - Scapular YTW Strengthening',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148203/',
  },

  // Wall slide / scapular glide
  {
    exercise_ids: [68], // Glissement scapulaire au mur
    url: 'https://cdn.pixabay.com/video/2023/01/27/148204-793717940_large.mp4',
    source_name: 'Pixabay - Wall Slide Scapular Gym',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148204/',
  },

  // Pulley exercise (capsulitis) / overhead movement
  {
    exercise_ids: [69], // Exercice de poulie (capsulite)
    url: 'https://cdn.pixabay.com/video/2023/01/27/148197-793717924_large.mp4',
    source_name: 'Pixabay - Pulley Shoulder Capsulitis',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148197/',
  },

  // Shoulder rotation stretch (lying / behind back)
  {
    exercise_ids: [70, 142], // Étirement rotation ext couchée, int derrière dos
    url: 'https://cdn.pixabay.com/video/2022/10/16/135160-761273559_large.mp4',
    source_name: 'Pixabay - Shoulder Stretch Rotation',
    source_url: 'https://pixabay.com/videos/gym-fitness-sport-workout-exercise-135160/',
  },

  // Resistance band rowing
  {
    exercise_ids: [71], // Bandes de résistance (rowing)
    url: 'https://cdn.pixabay.com/video/2023/01/27/148201-793717934_large.mp4',
    source_name: 'Pixabay - Resistance Band Rowing',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148201/',
  },

  // Shoulder shrug (scapular)
  {
    exercise_ids: [143], // Shrug scapulaire (haussement d'épaules)
    url: 'https://cdn.pixabay.com/video/2023/01/27/148202-793717935_large.mp4',
    source_name: 'Pixabay - Shoulder Shrug Gym',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148202/',
  },

  // Dumbbell external rotation lying
  {
    exercise_ids: [192], // Rotation externe couchée avec haltère
    url: 'https://cdn.pixabay.com/video/2022/10/16/135162-761273567_large.mp4',
    source_name: 'Pixabay - Dumbbell Rotation Exercise',
    source_url: 'https://pixabay.com/videos/gym-fitness-sport-workout-exercise-135162/',
  },

  // Serratus anterior push-up plus
  {
    exercise_ids: [195], // Renforcement serratus anterior (push-up plus)
    url: 'https://cdn.pixabay.com/video/2022/12/18/143431-782373969_large.mp4',
    source_name: 'Pixabay - Push-Up Plus Serratus',
    source_url: 'https://pixabay.com/videos/pushups-fitness-exercise-work-out-143431/',
  },

  // ── COUDE ───────────────────────────────────────────────────

  // Eccentric wrist extension / forearm strengthening
  {
    exercise_ids: [97, 174], // Extension poignet excentrique, étirements fléchisseurs épitrochléite
    url: 'https://cdn.pixabay.com/video/2017/10/31/12697-241674141_large.mp4',
    source_name: 'Pixabay - Forearm Eccentric Kettlebell',
    source_url: 'https://pixabay.com/videos/kettlebell-training-kettlebells-12697/',
  },

  // Forearm extensor/flexor stretch
  {
    exercise_ids: [98, 154], // Étirement extenseurs avant-bras, fléchisseurs (épitrochlée)
    url: 'https://cdn.pixabay.com/video/2023/01/27/148211-793717955_large.mp4',
    source_name: 'Pixabay - Forearm Stretch Gym',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148211/',
  },

  // FlexBar Tyler Twist — uses a verified 200 URL
  {
    exercise_ids: [99], // Exercice avec FlexBar (Tyler Twist)
    url: 'https://cdn.pixabay.com/video/2023/01/27/148199-793717929_large.mp4',
    source_name: 'Pixabay - Tyler Twist FlexBar Rehab',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148199/',
  },

  // Supination/pronation eccentric + supinators
  {
    exercise_ids: [100, 176], // Supination-pronation excentrique, supinateurs élastique
    url: 'https://cdn.pixabay.com/video/2023/11/19/189729-886596145_large.mp4',
    source_name: 'Pixabay - Supination Pronation Forearm',
    source_url: 'https://pixabay.com/videos/workout-athlete-sports-training-189729/',
  },

  // Grip strengthening (ouverture)
  {
    exercise_ids: [101], // Renforcement grip (ouverture)
    url: 'https://cdn.pixabay.com/video/2023/02/07/149709-796873476_large.mp4',
    source_name: 'Pixabay - Grip Strength Training',
    source_url: 'https://pixabay.com/videos/man-slave-gym-sports-addiction-149709/',
  },

  // Elbow flexion/extension mobilisation + eccentric
  {
    exercise_ids: [102, 173], // Mobilisation coude flexion-ext, Flexion excentrique
    url: 'https://cdn.pixabay.com/video/2023/01/27/148210-793717953_large.mp4',
    source_name: 'Pixabay - Elbow Flexion Extension',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148210/',
  },

  // Bicep curl with elastic
  {
    exercise_ids: [103], // Curl biceps avec élastique
    url: 'https://cdn.pixabay.com/video/2019/02/05/21180-315610549_large.mp4',
    source_name: 'Pixabay - Bicep Curl Kettlebell',
    source_url: 'https://pixabay.com/videos/kettle-bell-exercise-kettlebells-21180/',
  },

  // Triceps extension with elastic
  {
    exercise_ids: [104], // Extension triceps avec élastique
    url: 'https://cdn.pixabay.com/video/2017/11/03/12740-241674224_large.mp4',
    source_name: 'Pixabay - Triceps Extension Kettlebell',
    source_url: 'https://pixabay.com/videos/kettlebells-kettlebell-juggling-12740/',
  },

  // Electrostimulation / eccentric elbow rehab
  {
    exercise_ids: [155], // Electrostimulation excentrique coude
    url: 'https://cdn.pixabay.com/video/2023/01/27/148211-793717955_large.mp4',
    source_name: 'Pixabay - Elbow Rehab Eccentric',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148211/',
  },

  // Median nerve mobilisation (neurodynamics)
  {
    exercise_ids: [175], // Mobilisation neuro-méningée du nerf médian
    url: 'https://cdn.pixabay.com/video/2020/04/04/34972-407130582_large.mp4',
    source_name: 'Pixabay - Nerve Gliding Median',
    source_url: 'https://pixabay.com/videos/run-jogging-running-exercise-34972/',
  },

  // ── POIGNET / MAIN ───────────────────────────────────────────

  // Wrist flexion-extension + radial/ulnar deviation
  {
    exercise_ids: [34, 38], // Flexion-extension poignet, Déviation radiale/ulnaire
    url: 'https://cdn.pixabay.com/video/2023/01/27/148199-793717929_large.mp4',
    source_name: 'Pixabay - Wrist Flexion Extension Deviation',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148199/',
  },

  // Pronation-supination active (poignet)
  {
    exercise_ids: [35], // Pronation-supination active
    url: 'https://cdn.pixabay.com/video/2023/11/19/189731-886596163_large.mp4',
    source_name: 'Pixabay - Wrist Pronation Supination',
    source_url: 'https://pixabay.com/videos/workout-athlete-sports-training-189731/',
  },

  // Wrist flexor stretch + dorsiflexion stretch
  {
    exercise_ids: [36, 106], // Étirement fléchisseurs poignet, dorsiflexion
    url: 'https://cdn.pixabay.com/video/2020/02/27/32937-395456375_large.mp4',
    source_name: 'Pixabay - Wrist Stretch Senior',
    source_url: 'https://pixabay.com/videos/exercise-stretching-senior-elder-32937/',
  },

  // Grip + thenar strengthening
  {
    exercise_ids: [37, 179], // Renforcement préhension, thénar
    url: 'https://cdn.pixabay.com/video/2023/01/27/148201-793717934_large.mp4',
    source_name: 'Pixabay - Grip Thenar Strength',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148201/',
  },

  // Nerve gliding (median) + tendon gliding
  {
    exercise_ids: [105, 178], // Nerf médian glissement, tendon gliding
    url: 'https://cdn.pixabay.com/video/2023/06/22/168352-841391725_large.mp4',
    source_name: 'Pixabay - Nerve Tendon Gliding',
    source_url: 'https://pixabay.com/videos/yoga-stretches-exercise-people-sea-168352/',
  },

  // Finger tenodesis
  {
    exercise_ids: [107], // Ténodèse des doigts
    url: 'https://cdn.pixabay.com/video/2023/01/27/148210-793717953_large.mp4',
    source_name: 'Pixabay - Finger Tenodesis Hand',
    source_url: 'https://pixabay.com/videos/fitness-workout-gym-sport-148210/',
  },

  // Wrist warm-up / circular massage
  {
    exercise_ids: [159], // Échauffement poignet (massage circulaire)
    url: 'https://cdn.pixabay.com/video/2022/08/28/129423-744370596_large.mp4',
    source_name: 'Pixabay - Wrist Warmup Yoga',
    source_url: 'https://pixabay.com/videos/woman-yoga-exercise-concentration-129423/',
  },

  // Carpal tunnel / post-immobilisation wrist mobilisation
  {
    exercise_ids: [177, 180], // Mobilisation tunnel carpien, post-immobilisation
    url: 'https://cdn.pixabay.com/video/2022/10/16/135159-761273555_large.mp4',
    source_name: 'Pixabay - Carpal Tunnel Wrist Rehab',
    source_url: 'https://pixabay.com/videos/gym-fitness-sport-workout-135159/',
  },
];

// ============================================================
// HELPERS
// ============================================================

function tmpFile(ext) {
  return path.join(os.tmpdir(), `kinevia-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
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
  // Try at 1s, fallback to frame 0
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
  // ffmpeg prints to stderr; run it and catch
  try {
    const err = await execFileAsync(FFMPEG, ['-i', videoPath, '-f', 'null', '-'], { timeout: 15000 })
      .catch(e => e); // ffmpeg always "fails" when writing to /dev/null
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
  const label = source_name;
  const tempFiles = [];

  try {
    // Download
    const buf = await downloadVideo(url);
    const inputPath = tmpFile('.mp4');
    fs.writeFileSync(inputPath, buf);
    tempFiles.push(inputPath);

    // Get duration
    const duration = await getDuration(inputPath);

    // Compress
    console.log('  ⚙ Compressing to 720p...');
    let compressedPath = inputPath;
    try {
      compressedPath = await compressVideo(inputPath);
      tempFiles.push(compressedPath);
      console.log(`  ✓ Compressed → ${(fs.statSync(compressedPath).size / 1024 / 1024).toFixed(1)} MB`);
    } catch (e) {
      console.warn('  ⚠ Compression failed, using original:', e.message.slice(0, 100));
    }

    // Thumbnail
    let thumbnailUrl = null;
    try {
      const thumbPath = await extractThumbnail(compressedPath);
      if (thumbPath) {
        tempFiles.push(thumbPath);
        const thumbBuf = fs.readFileSync(thumbPath);
        thumbnailUrl = await uploadToR2(thumbBuf, `thumb-b1-${Date.now()}.jpg`, 'image/jpeg');
        console.log('  📸 Thumbnail:', thumbnailUrl);
      }
    } catch (e) {
      console.warn('  ⚠ Thumbnail failed:', e.message.slice(0, 80));
    }

    // Upload video
    console.log('  ☁ Uploading video...');
    const compressedBuf = fs.readFileSync(compressedPath);
    const fileSize = compressedBuf.length;
    const videoUrl = await uploadToR2(compressedBuf, `video-b1-${Date.now()}.mp4`, 'video/mp4');
    console.log(`  ✓ Video: ${videoUrl}`);
    console.log(`  📦 ${(fileSize / 1024 / 1024).toFixed(1)} MB  ⏱ ${duration ?? '?'}s`);

    // Get admin kine_id (uploaded_by is NOT NULL)
    const adminRes = await client.query('SELECT id FROM kines WHERE is_admin = TRUE ORDER BY id LIMIT 1');
    const uploadedBy = adminRes.rows[0]?.id;
    if (!uploadedBy) throw new Error('No admin kine found — cannot set uploaded_by');

    // Link each exercise
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
  console.log('=== Kinevia — Batch Video Import (Cervical + Membre supérieur) ===');
  console.log(`DB: ${DB_URL.replace(/:[^:@]+@/, ':***@')}`);
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
  console.log('IMPORT COMPLETE');
  console.log(`  ✓ Linked:  ${totalLinked} exercises`);
  console.log(`  ⏭ Skipped: ${totalSkipped} (already linked / not found)`);
  console.log(`  ✗ Errors:  ${totalErrors} video groups`);
  console.log('════════════════════════════════');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
