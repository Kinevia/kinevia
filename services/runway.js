'use strict';

/**
 * Runway ML — Image-to-Video Generation Service
 *
 * Génère des vidéos d'exercices à partir des illustrations existantes
 * via l'API Runway ML Gen-4.5 (image-to-video).
 *
 * Pipeline :
 *   1. Récupère l'exercice + son image_url depuis la DB
 *   2. Soumet la génération à Runway ML (Gen-4.5)
 *   3. Poll jusqu'à completion (max ~5 min)
 *   4. Télécharge la vidéo MP4 générée
 *   5. Upload sur Cloudflare R2 (nom : exercise_{id}.mp4)
 *   6. Insère dans exercise_videos + met has_video=TRUE sur exercices
 *
 * API Runway :
 *   POST https://api.dev.runwayml.com/v1/image_to_video
 *   Auth : Authorization: Bearer {RUNWAY_API_KEY}
 *         X-Runway-Version: 2024-11-06
 *
 * Usage :
 *   const runway = require('./services/runway');
 *   const result = await runway.generateExerciseVideo(pool, exerciceId);
 *
 * Ou via endpoint admin :
 *   POST /api/admin/runway/generate-video   { exercice_id: 211 }
 *   GET  /api/admin/runway/task/:taskId      → status polling
 */

const nodeFetch = require('node-fetch');
const FormData = require('form-data');

// ── Constants ────────────────────────────────────────────────────────────────

const RUNWAY_API_BASE = 'https://api.dev.runwayml.com/v1';
const RUNWAY_VERSION  = '2024-11-06';
const RUNWAY_MODEL    = 'gen4_turbo'; // Gen-4.5 API name

// Video generation parameters
const VIDEO_DURATION  = 5;   // seconds (5 or 10)
const VIDEO_RATIO     = '1280:720';  // 16:9 landscape

// Polling config
const POLL_INTERVAL_MS = 8000;   // 8s between polls
const POLL_MAX_ATTEMPTS = 45;     // 45 × 8s = 6 min max

// R2 upload
const R2_BASE = process.env.POLSIA_R2_BASE_URL || 'https://polsia.com';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build Runway API headers.
 */
function runwayHeaders(extraHeaders) {
  const apiKey = process.env.RUNWAY_API_KEY;
  if (!apiKey) throw new Error('RUNWAY_API_KEY environment variable not set');
  return {
    'Authorization': 'Bearer ' + apiKey,
    'X-Runway-Version': RUNWAY_VERSION,
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
}

/**
 * Upload a buffer to Cloudflare R2 via Polsia proxy.
 * Returns the CDN URL.
 */
async function uploadToR2(buffer, filename, mimeType) {
  const apiKey = process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN;
  if (!apiKey) throw new Error('POLSIA_API_KEY environment variable not set');

  const formData = new FormData();
  formData.append('file', buffer, { filename, contentType: mimeType });

  const res = await nodeFetch(R2_BASE + '/api/proxy/r2/upload', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      ...formData.getHeaders(),
    },
    body: formData,
    timeout: 180000,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error('R2 upload failed: ' + res.status + ' ' + txt);
  }

  const data = await res.json();
  if (!data.success) {
    throw new Error('R2 upload failed: ' + (data.error && data.error.message || JSON.stringify(data)));
  }

  return data.file.url;
}

/**
 * Build a French prompt for Runway based on exercise metadata.
 */
function buildPrompt(exercice) {
  const zone = exercice.zone_corporelle || 'musculaire';
  const nom  = exercice.nom || 'exercice de kinésithérapie';

  return (
    `A medical physiotherapy exercise demonstration showing: ${nom}. ` +
    `Body zone: ${zone}. ` +
    `Clean white background, professional medical illustration style, ` +
    `smooth slow movement, educational physiotherapy video, ` +
    `no text overlay, high quality.`
  );
}

// ── Core Functions ────────────────────────────────────────────────────────────

/**
 * Submit an image-to-video task to Runway ML.
 *
 * @param {string} imageUrl   - Public URL of the exercise illustration
 * @param {string} prompt     - Text description for the video
 * @returns {string}          - Runway task ID
 */
async function submitRunwayTask(imageUrl, prompt) {
  const body = {
    model: RUNWAY_MODEL,
    promptImage: imageUrl,
    promptText: prompt,
    ratio: VIDEO_RATIO,
    duration: VIDEO_DURATION,
  };

  const res = await nodeFetch(RUNWAY_API_BASE + '/image_to_video', {
    method: 'POST',
    headers: runwayHeaders(),
    body: JSON.stringify(body),
    timeout: 30000,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error('Runway API error ' + res.status + ': ' + txt);
  }

  const data = await res.json();
  if (!data.id) throw new Error('Runway API returned no task ID: ' + JSON.stringify(data));

  return data.id;
}

/**
 * Poll Runway for task status.
 *
 * @param {string} taskId
 * @returns {{ status: string, output: string[]|null, error: string|null }}
 */
async function pollRunwayTask(taskId) {
  const res = await nodeFetch(RUNWAY_API_BASE + '/tasks/' + taskId, {
    method: 'GET',
    headers: runwayHeaders(),
    timeout: 15000,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error('Runway poll error ' + res.status + ': ' + txt);
  }

  const data = await res.json();
  return {
    status: data.status,          // 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
    output: data.output || null,  // array of URLs when SUCCEEDED
    error:  data.error  || null,
    progress: data.progress || null,
  };
}

/**
 * Wait for a Runway task to complete (poll loop).
 *
 * @param {string} taskId
 * @returns {string} - Video URL from Runway CDN
 */
async function waitForRunwayTask(taskId) {
  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    const result = await pollRunwayTask(taskId);

    if (result.status === 'SUCCEEDED') {
      if (!result.output || result.output.length === 0) {
        throw new Error('Runway task succeeded but no output URLs returned');
      }
      return result.output[0];
    }

    if (result.status === 'FAILED' || result.status === 'CANCELLED') {
      throw new Error('Runway task ' + result.status + ': ' + (result.error || 'unknown error'));
    }

    // PENDING or RUNNING — keep waiting
    const progress = result.progress != null ? ' (' + Math.round(result.progress * 100) + '%)' : '';
    console.log('[runway] Task ' + taskId + ' — ' + result.status + progress + ' (attempt ' + attempt + '/' + POLL_MAX_ATTEMPTS + ')');

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error('Runway task timed out after ' + POLL_MAX_ATTEMPTS + ' polling attempts (~' + Math.round(POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS / 60000) + ' min)');
}

/**
 * Download a video from a URL and return as Buffer.
 */
async function downloadVideo(url) {
  const res = await nodeFetch(url, { timeout: 120000 });
  if (!res.ok) throw new Error('Download failed: HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 10000) throw new Error('Downloaded video too small (' + buf.length + ' bytes) — likely invalid');
  return buf;
}

// ── Main Export ───────────────────────────────────────────────────────────────

/**
 * Full pipeline: exercice → Runway → R2 → DB.
 *
 * @param {Pool}   pool        - pg Pool
 * @param {number} exerciceId  - exercices.id
 * @returns {{ taskId, videoUrl, r2Url, exerciceId, nom }}
 */
async function generateExerciseVideo(pool, exerciceId) {
  const id = parseInt(exerciceId, 10);
  if (!id || isNaN(id)) throw new Error('Invalid exercice_id: ' + exerciceId);

  // 1. Fetch exercise data
  const exRes = await pool.query(
    'SELECT id, nom, zone_corporelle, image_url FROM exercices WHERE id = $1',
    [id]
  );
  if (exRes.rows.length === 0) throw new Error('Exercice #' + id + ' non trouvé');

  const exercice = exRes.rows[0];
  console.log('[runway] Exercice #' + id + ': "' + exercice.nom + '" (zone: ' + (exercice.zone_corporelle || 'N/A') + ')');

  // 2. Verify we have an image to use as reference
  if (!exercice.image_url) {
    throw new Error('Exercice #' + id + ' n\'a pas d\'image_url — impossible de générer une vidéo image-to-video');
  }

  // 3. Build prompt
  const prompt = buildPrompt(exercice);
  console.log('[runway] Prompt: ' + prompt.slice(0, 120) + '...');

  // 4. Submit to Runway ML
  console.log('[runway] Submitting task to Runway ML Gen-4.5...');
  const taskId = await submitRunwayTask(exercice.image_url, prompt);
  console.log('[runway] Task submitted — ID: ' + taskId);

  // 5. Poll for completion
  console.log('[runway] Polling for completion...');
  const runwayVideoUrl = await waitForRunwayTask(taskId);
  console.log('[runway] ✓ Video ready: ' + runwayVideoUrl);

  // 6. Download the video
  console.log('[runway] Downloading video...');
  const videoBuffer = await downloadVideo(runwayVideoUrl);
  console.log('[runway] Downloaded: ' + (videoBuffer.length / 1024 / 1024).toFixed(1) + ' MB');

  // 7. Upload to R2
  const filename = 'exercise_' + id + '.mp4';
  console.log('[runway] Uploading to R2 as ' + filename + '...');
  const r2Url = await uploadToR2(videoBuffer, filename, 'video/mp4');
  console.log('[runway] ✓ R2 URL: ' + r2Url);

  // 8. Get admin kine_id for uploaded_by (NOT NULL constraint)
  const adminRes = await pool.query('SELECT id FROM kines WHERE is_admin = TRUE ORDER BY id LIMIT 1');
  const uploadedBy = adminRes.rows[0] ? adminRes.rows[0].id : null;

  // 9. Upsert into exercise_videos
  await pool.query('DELETE FROM exercise_videos WHERE exercise_id = $1 AND source = $2', [id, 'runway']);

  await pool.query(
    `INSERT INTO exercise_videos
       (exercise_id, video_url, thumbnail_url, duration_seconds, file_size,
        original_filename, mime_type, upload_status, uploaded_by, source, source_url)
     VALUES ($1, $2, NULL, $3, $4, $5, 'video/mp4', 'ready', $6, 'runway', $7)`,
    [id, r2Url, VIDEO_DURATION, videoBuffer.length, filename, uploadedBy, runwayVideoUrl]
  );

  // 10. Update exercices.video_url + has_video
  await pool.query(
    'UPDATE exercices SET video_url = $1, has_video = TRUE WHERE id = $2',
    [r2Url, id]
  );

  console.log('[runway] ✓ Exercice #' + id + ' mis à jour avec has_video=TRUE');

  return {
    taskId,
    videoUrl: runwayVideoUrl,
    r2Url,
    exerciceId: id,
    nom: exercice.nom,
    filename,
    fileSize: videoBuffer.length,
    duration: VIDEO_DURATION,
  };
}

/**
 * Get current status of a Runway task (without waiting).
 * Used by the status polling endpoint.
 */
async function getTaskStatus(taskId) {
  return await pollRunwayTask(taskId);
}

module.exports = {
  generateExerciseVideo,
  getTaskStatus,
  submitRunwayTask,
  waitForRunwayTask,
};
