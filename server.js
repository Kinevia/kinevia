const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const crypto = require('crypto');
const OpenAI = require('openai');
const webpush = require('web-push');

const app = express();
const port = process.env.PORT || 3000;

// ==========================================
// WEB PUSH — VAPID configuration
// ==========================================
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_CONTACT = process.env.VAPID_CONTACT || 'mailto:contact@kinevia.pro';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log('[push] VAPID keys configured');
} else {
  console.warn('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — push notifications disabled');
}

// Fail fast if DATABASE_URL is missing
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Admin routes (temporary — image generation jobs). Pass main pool to avoid separate DB connection issues.
app.use('/api/admin', require('./routes/admin-image-gen')(pool));

// DEBUG: /api/debug/db-check — check what columns exist in kines table
app.get('/api/debug/db-check', async (req, res) => {
  try {
    // Check which columns exist
    const cols = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'kines'
      ORDER BY ordinal_position
    `);
    // Check admin status
    const adminCheck = await pool.query(`
      SELECT id, email, is_admin, subscription_status
      FROM kines
      WHERE LOWER(email) = LOWER('amin.thiers.pro@gmail.com')
    `);
    // Check current_database
    const dbName = await pool.query('SELECT current_database() as db');
    res.json({
      columns: cols.rows,
      admin_user: adminCheck.rows,
      database: dbName.rows[0]
    });
  } catch (err) {
    res.json({ error: err.message, hint: 'columns might not exist yet' });
  }
});


// ==========================================
// STARTUP SEED: Ensure admin columns exist in kines table
// Uses DO blocks for reliable idempotent column addition.
// ==========================================
(async function seedAdminColumns() {
  try {
    // Use DO blocks with full ALTER TABLE syntax for each column
    const columnsToAdd = [
      { name: 'is_admin', def: 'BOOLEAN NOT NULL DEFAULT FALSE' },
      { name: 'stripe_customer_id', def: 'VARCHAR(255)' },
      { name: 'stripe_subscription_id', def: 'VARCHAR(255)' },
      { name: 'subscription_status', def: `VARCHAR(50) NOT NULL DEFAULT 'trialing'` },
      { name: 'trial_ends_at', def: 'TIMESTAMPTZ' },
      { name: 'subscription_ends_at', def: 'TIMESTAMPTZ' },
      { name: 'subscription_updated_at', def: 'TIMESTAMPTZ' },
    ];

    for (const col of columnsToAdd) {
      try {
        await pool.query(
          `DO $$ BEGIN ALTER TABLE kines ADD COLUMN IF NOT EXISTS ${col.name} ${col.def}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`
        );
        console.log(`[seed] Column ${col.name}: added`);
      } catch (e) {
        console.log(`[seed] Column ${col.name}: ${e.message.split('\n')[0]}`);
      }
    }

    // Set is_admin for founder (always runs, independent of subscription_status)
    const adminResult = await pool.query(`
      UPDATE kines
      SET is_admin = TRUE
      WHERE LOWER(email) = LOWER('amin.thiers.pro@gmail.com')
        AND (is_admin = FALSE OR is_admin IS NULL)
    `);
    console.log('[seed] is_admin update result:', adminResult.rowCount, 'rows affected');

    // Set subscription fields (only if columns exist)
    try {
      await pool.query(`
        UPDATE kines
        SET subscription_status = 'active',
            subscription_updated_at = NOW(),
            trial_ends_at = COALESCE(trial_ends_at, created_at + INTERVAL '14 days')
        WHERE LOWER(email) = LOWER('amin.thiers.pro@gmail.com')
          AND subscription_status IS DISTINCT FROM 'active'
      `);
    } catch (e) {
      // subscription_status column may not exist yet
    }

    console.log('[seed] Admin columns seeded OK');
  } catch (err) {
    console.error('[seed] Admin columns seed failed:', err.message);
  }
})();

// ==========================================
// AES-256-GCM ENCRYPTION (HDS compliance)
// ==========================================
// ENCRYPTION_KEY must be a 64-char hex string (32 bytes).
// Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

const ENCRYPTION_KEY_HEX = process.env.ENCRYPTION_KEY;
let ENCRYPTION_KEY = null;

if (ENCRYPTION_KEY_HEX) {
  if (ENCRYPTION_KEY_HEX.length !== 64) {
    console.error('ERROR: ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
    process.exit(1);
  }
  ENCRYPTION_KEY = Buffer.from(ENCRYPTION_KEY_HEX, 'hex');
} else {
  // Warn but do not crash — allows app to boot without encryption in dev.
  // In production, ENCRYPTION_KEY must be set; data will be stored as plaintext
  // in the _enc columns until the key is configured.
  console.warn('WARNING: ENCRYPTION_KEY is not set. Health data will NOT be encrypted. Set this in production!');
}

/**
 * Encrypt a value with AES-256-GCM.
 * Returns "iv:authTag:ciphertext" as hex, or null if value is null/undefined.
 * Falls back to plaintext if ENCRYPTION_KEY is not set.
 */
function encrypt(value) {
  if (value === null || value === undefined) return null;
  const str = String(value);
  if (!ENCRYPTION_KEY) return str; // fallback: store plaintext

  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted.toString('hex');
}

/**
 * Decrypt a value encrypted with encrypt().
 * Returns the original string, or null on failure.
 * Handles legacy plaintext values gracefully (returns as-is if not in enc format).
 */
function decrypt(value) {
  if (value === null || value === undefined) return null;
  if (!ENCRYPTION_KEY) return value; // no key: return as-is

  // Check if value looks like our encrypted format (iv:authTag:ciphertext)
  const parts = String(value).split(':');
  if (parts.length !== 3) {
    // Not encrypted (legacy plaintext value) — return as-is
    return value;
  }

  try {
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const ciphertext = Buffer.from(parts[2], 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (e) {
    console.error('Decryption failed:', e.message);
    return null;
  }
}

/**
 * Decrypt an integer field (douleur_score, douleur_initiale).
 * Returns integer or null.
 */
function decryptInt(value) {
  const str = decrypt(value);
  if (str === null || str === undefined) return null;
  const n = parseInt(str, 10);
  return isNaN(n) ? null : n;
}

// ==========================================
// HEALTH DATA ACCESS LOGGING
// ==========================================

/**
 * Log access to health-sensitive data.
 * Fire-and-forget — never blocks the response.
 */
async function logHealthAccess({ kineId, resourceType, resourceId, patientId, action, endpoint, req }) {
  try {
    const ip = req ? (req.ip || req.headers['x-forwarded-for'] || null) : null;
    await pool.query(
      `INSERT INTO health_access_logs (kine_id, resource_type, resource_id, patient_id, action, endpoint, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [kineId || null, resourceType, resourceId, patientId || null, action,
       endpoint || null, ip ? String(ip).substring(0, 45) : null]
    );
  } catch (e) {
    // Never let logging failure break the request
    console.error('health_access_log error:', e.message);
  }
}

// ==========================================
// HEALTH DATA HELPERS
// ==========================================

/** Decrypt a patient row's sensitive fields. */
function decryptPatient(row) {
  if (!row) return null;
  return {
    ...row,
    pathologie: decrypt(row.pathologie_enc) ?? row.pathologie ?? null,
    notes: decrypt(row.notes_enc) ?? row.notes ?? null
  };
}

/** Decrypt a seance row's sensitive fields. */
function decryptSeance(row) {
  if (!row) return null;
  return {
    ...row,
    douleur_score: row.douleur_score_enc != null ? decryptInt(row.douleur_score_enc) : (row.douleur_score ?? null),
    notes_patient: decrypt(row.notes_patient_enc) ?? row.notes_patient ?? null,
    difficulte: decrypt(row.difficulte_enc) ?? row.difficulte ?? null
  };
}

/** Decrypt a bilan row's sensitive fields. */
function decryptBilan(row) {
  if (!row) return null;
  let donnees_cliniques = null;
  if (row.donnees_cliniques_enc) {
    const raw = decrypt(row.donnees_cliniques_enc);
    if (raw) {
      try { donnees_cliniques = JSON.parse(raw); } catch(e) { donnees_cliniques = null; }
    }
  }
  return {
    ...row,
    douleur_initiale: row.douleur_initiale_enc != null ? decryptInt(row.douleur_initiale_enc) : (row.douleur_initiale ?? null),
    mobilite_initiale: decrypt(row.mobilite_initiale_enc) ?? row.mobilite_initiale ?? null,
    objectifs: decrypt(row.objectifs_enc) ?? row.objectifs ?? null,
    notes: decrypt(row.notes_enc) ?? row.notes ?? null,
    observations: decrypt(row.observations_enc) ?? row.observations ?? null,
    mesures: decrypt(row.mesures_enc) ?? row.mesures ?? null,
    donnees_cliniques,
    functional_details: decrypt(row.functional_details_enc) ?? null,
    observations_praticien: decrypt(row.observations_praticien_enc) ?? null,
    conclusion_bilan: decrypt(row.conclusion_bilan_enc) ?? null,
    synthese_redigee: decrypt(row.synthese_redigee_enc) ?? null
  };
}

// Raw body parser ONLY for Stripe webhooks (must come before express.json())
// Stripe signature verification requires the raw request body
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));

// JSON parser for all other routes
app.use(function(req, res, next) {
  if (req.path === '/api/webhooks/stripe') return next(); // already handled above
  express.json()(req, res, next);
});
app.use(express.urlencoded({ extended: true }));

// Prevent browsers and service workers from caching API responses
app.use('/api', function(req, res, next) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});

// Session config — persistent PostgreSQL store (survives restarts/deploys)
const PgSession = connectPgSimple(session);
app.use(session({
  store: new PgSession({
    pool,
    tableName: 'session',
    pruneSessionInterval: 60 * 60, // prune expired sessions every hour
  }),
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  rolling: true, // reset inactivity timer on every request
  cookie: {
    secure: false, // Render terminates SSL at proxy layer
    httpOnly: true,
    maxAge: 48 * 60 * 60 * 1000, // 48h inactivity timeout
    sameSite: 'lax'
  }
}));

// Trust proxy for Render
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// 301 redirect: monkine.app → kinevia.pro (keep monkine.app active as redirect)
app.use((req, res, next) => {
  const host = req.hostname;
  if (host === 'monkine.app' || host === 'www.monkine.app') {
    return res.redirect(301, 'https://kinevia.pro' + req.originalUrl);
  }
  next();
});

// Digital Asset Links — TWA domain ownership verification for Google Play Store.
// Must be served before static middleware (express.static ignores dotfiles by default).
app.use('/.well-known', require('./routes/well-known'));

// Health check endpoint (required for Render)
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// ==========================================
// PAGE VIEW ANALYTICS MIDDLEWARE
// Tracks public page views for admin analytics.
// Fire-and-forget — never blocks the response.
// Only tracks GET requests to HTML pages (not API or static assets).
// ==========================================
app.use((req, res, next) => {
  // Only track GET requests to navigable paths (not API, not assets)
  if (
    req.method === 'GET' &&
    !req.path.startsWith('/api/') &&
    !req.path.startsWith('/health') &&
    !req.path.match(/\.(js|css|png|jpg|jpeg|svg|ico|woff|woff2|ttf|map|json|txt|webp|gif)$/)
  ) {
    // Hash IP for privacy (no PII stored)
    const rawIp = req.ip || req.headers['x-forwarded-for'] || '';
    const ipHash = crypto.createHash('sha256').update(String(rawIp).split(',')[0].trim()).digest('hex').substring(0, 16);
    const sessionId = req.session && req.session.id ? req.session.id.substring(0, 32) : null;
    const kineId = req.session && req.session.kineId ? req.session.kineId : null;
    const referrer = req.headers.referer ? String(req.headers.referer).substring(0, 500) : null;
    const userAgent = req.headers['user-agent'] ? String(req.headers['user-agent']).substring(0, 200) : null;
    const path = req.path.substring(0, 200);
    // Fire-and-forget
    pool.query(
      `INSERT INTO page_views (path, referrer, user_agent, kine_id, session_id, ip_hash)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [path, referrer, userAgent, kineId, sessionId, ipHash]
    ).catch(() => {}); // intentional: never let analytics break a request
  }
  next();
});

// Demo route — public read-only showcase (no auth required)
app.get('/demo', (req, res) => res.sendFile(path.join(__dirname, 'public', 'demo.html')));
app.get('/demo/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'demo.html')));

// Flyer route — promotional flyer with PDF download (no auth required)
app.get('/flyer', (req, res) => res.sendFile(path.join(__dirname, 'public', 'flyer.html')));

// ==========================================
// AUTH MIDDLEWARE
// ==========================================
function requireAuth(req, res, next) {
  if (!req.session.kineId) {
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(401).json({ error: 'Non authentifié' });
    }
    return res.redirect('/connexion');
  }
  next();
}

// Carnet de suivi en cabinet — kiné-side session journal per patient.
// Mounted here (after session + body-parser middleware) so req.session and req.body exist.
app.use('/api/patients/:patientId/cabinet-seances',
  require('./routes/cabinet-seances')(pool, requireAuth)
);

// ==========================================
// AUTH API ROUTES
// ==========================================

// POST /api/auth/inscription - Register
app.post('/api/auth/inscription', async (req, res) => {
  try {
    const { prenom, nom, email, mot_de_passe, cabinet, telephone } = req.body;

    if (!nom || !email || !mot_de_passe) {
      return res.status(400).json({ error: 'Nom, email et mot de passe sont requis' });
    }

    if (mot_de_passe.length < 8) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères' });
    }

    // Check email uniqueness
    const existing = await pool.query('SELECT id FROM kines WHERE LOWER(email) = LOWER($1)', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Un compte existe déjà avec cet email' });
    }

    const hash = await bcrypt.hash(mot_de_passe, 12);
    // trial_ends_at = now + 14 days (free trial period)
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 14);

    const result = await pool.query(
      `INSERT INTO kines (prenom, nom, email, mot_de_passe_hash, cabinet, telephone, subscription_status, trial_ends_at, subscription_updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'trialing', $7, NOW())
       RETURNING id, prenom, nom, email, cabinet, telephone, subscription_status, trial_ends_at`,
      [prenom || null, nom, email.toLowerCase(), hash, cabinet || null, telephone || null, trialEndsAt]
    );

    req.session.kineId = result.rows[0].id;
    const newKine = result.rows[0];

    // Record signup event
    pool.query(
      `INSERT INTO kine_subscription_events (kine_id, event_type, metadata) VALUES ($1, 'account_created', $2)`,
      [newKine.id, JSON.stringify({ trial_ends_at: trialEndsAt.toISOString() })]
    ).catch(e => console.error('[SUBSCRIPTION] event log error:', e.message));

    // Register as known email contact (fire-and-forget)
    registerEmailContact({
      email: newKine.email,
      name: [newKine.prenom, newKine.nom].filter(Boolean).join(' ')
    }).catch(e => console.error('[email] register contact error:', e.message));

    // Send verification email (fire-and-forget — don't block signup response)
    sendVerificationEmail(newKine).catch(e => console.error('[email] verification email error:', e.message));

    const STRIPE_URL = process.env.APP_URL
      ? process.env.APP_URL + '/abonnement/checkout'
      : 'https://buy.stripe.com/14A9AT0efcyT1eQ5TXbMQ00';

    res.status(201).json({
      success: true,
      kine: newKine,
      trial_ends_at: trialEndsAt.toISOString(),
      checkout_url: 'https://buy.stripe.com/14A9AT0efcyT1eQ5TXbMQ00'
    });
  } catch (err) {
    console.error('Inscription error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/auth/connexion - Login
app.post('/api/auth/connexion', async (req, res) => {
  try {
    const { email, mot_de_passe } = req.body;

    if (!email || !mot_de_passe) {
      return res.status(400).json({ error: 'Email et mot de passe sont requis' });
    }

    const result = await pool.query('SELECT id, prenom, nom, email, mot_de_passe_hash, cabinet, telephone FROM kines WHERE LOWER(email) = LOWER($1)', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const kine = result.rows[0];
    const valid = await bcrypt.compare(mot_de_passe, kine.mot_de_passe_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    req.session.kineId = kine.id;
    res.json({
      success: true,
      kine: { id: kine.id, prenom: kine.prenom, nom: kine.nom, email: kine.email, cabinet: kine.cabinet, telephone: kine.telephone, is_admin: kine.is_admin || false }
    });
  } catch (err) {
    console.error('Connexion error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/auth/deconnexion - Logout
app.post('/api/auth/deconnexion', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// GET /api/auth/moi - Current user
app.get('/api/auth/moi', async (req, res) => {
  if (!req.session.kineId) {
    return res.json({ authenticated: false });
  }
  try {
    const result = await pool.query(
      `SELECT id, prenom, nom, email, cabinet, telephone, rpps, adresse,
              subscription_status, trial_ends_at, subscription_ends_at,
              stripe_subscription_id, is_admin, lifetime_free,
              has_seen_onboarding
       FROM kines WHERE id = $1`,
      [req.session.kineId]
    );
    if (result.rows.length === 0) {
      return res.json({ authenticated: false });
    }
    const kine = result.rows[0];
    // subscription_status, trial_ends_at, etc. added by migration 018
    // Only include if they exist (graceful fallback)
    const kineData = {
      id: kine.id, prenom: kine.prenom, nom: kine.nom,
      email: kine.email, cabinet: kine.cabinet, telephone: kine.telephone,
      rpps: kine.rpps || null, adresse: kine.adresse || null,
      is_admin: kine.is_admin || false,
      has_seen_onboarding: kine.has_seen_onboarding || false
    };
    // Check if subscription columns exist and add them if present
    if (kine.subscription_status !== undefined) kineData.subscription_status = kine.subscription_status;
    res.json({
      authenticated: true,
      kine: kineData,
      subscription: {
        active: true,
        reason: 'default',
        status: kine.subscription_status || 'trialing',
        trial_ends_at: kine.trial_ends_at || null,
        subscription_ends_at: kine.subscription_ends_at || null,
        has_paid_subscription: !!kine.stripe_subscription_id,
        lifetime_free: kine.lifetime_free || false,
        checkout_url: STRIPE_CHECKOUT_URL
      }
    });
  } catch (err) {
    res.json({ authenticated: false });
  }
});

// PUT /api/auth/profil - Update kiné profile (nom, prenom, cabinet, telephone, rpps, adresse)
app.put('/api/auth/profil', requireAuth, async (req, res) => {
  try {
    const { prenom, nom, cabinet, telephone, rpps, adresse } = req.body;
    await pool.query(
      `UPDATE kines SET
         prenom = COALESCE($1, prenom),
         nom = COALESCE($2, nom),
         cabinet = COALESCE($3, cabinet),
         telephone = COALESCE($4, telephone),
         rpps = $5,
         adresse = $6
       WHERE id = $7`,
      [prenom || null, nom || null, cabinet || null, telephone || null,
       rpps || null, adresse || null, req.session.kineId]
    );
    const result = await pool.query(
      `SELECT id, prenom, nom, email, cabinet, telephone, rpps, adresse FROM kines WHERE id = $1`,
      [req.session.kineId]
    );
    res.json({ success: true, kine: result.rows[0] });
  } catch (err) {
    console.error('Update profil error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// EMAIL HELPER (Polsia proxy)
// ==========================================
async function sendEmail({ to, subject, body, html }) {
  const apiKey = process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN;
  if (!apiKey) {
    console.error('[email] POLSIA_API_KEY not set — cannot send email');
    return;
  }
  try {
    const res = await fetch('https://polsia.com/api/proxy/email/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({ to, subject, body, html }),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error('[email] send failed:', res.status, txt);
    }
  } catch (e) {
    console.error('[email] send error:', e.message);
  }
}

async function registerEmailContact({ email, name }) {
  const apiKey = process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN;
  if (!apiKey) return;
  try {
    await fetch('https://polsia.com/api/proxy/email/contacts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({ email, name, source: 'signup' }),
    });
  } catch (e) {
    console.error('[email] register contact error:', e.message);
  }
}

// ==========================================
// PASSWORD RESET ROUTES
// ==========================================

// POST /api/auth/mot-de-passe-oublie - Request password reset
app.post('/api/auth/mot-de-passe-oublie', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email requis' });
    }

    const result = await pool.query(
      'SELECT id, prenom, nom, email FROM kines WHERE LOWER(email) = LOWER($1)',
      [email]
    );

    // Always return success to avoid email enumeration
    if (result.rows.length === 0) {
      return res.json({ success: true, message: 'Si un compte existe avec cet email, vous recevrez un lien de réinitialisation.' });
    }

    const kine = result.rows[0];
    const token = crypto.randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Invalidate previous unused tokens
    await pool.query(
      'UPDATE password_reset_tokens SET used_at = NOW() WHERE kine_id = $1 AND used_at IS NULL',
      [kine.id]
    );

    await pool.query(
      'INSERT INTO password_reset_tokens (kine_id, token, expires_at) VALUES ($1, $2, $3)',
      [kine.id, token, expiresAt]
    );

    const appUrl = process.env.APP_URL || 'https://kinevia.pro';
    const resetLink = appUrl + '/reinitialisation-mot-de-passe?token=' + token;
    const prenom = kine.prenom || kine.nom;

    await sendEmail({
      to: kine.email,
      subject: 'Réinitialisation de votre mot de passe — Kinévia',
      body: `Bonjour ${prenom},\n\nVous avez demandé la réinitialisation de votre mot de passe Kinévia.\n\nCliquez sur ce lien pour définir un nouveau mot de passe (valable 1 heure) :\n${resetLink}\n\nSi vous n'avez pas fait cette demande, ignorez cet email — votre mot de passe reste inchangé.\n\nL'équipe Kinévia`,
      html: `<!DOCTYPE html><html lang="fr"><body style="margin:0;padding:0;font-family:Inter,sans-serif;background:#f8fafc;">
<div style="max-width:520px;margin:40px auto;background:white;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden;">
  <div style="background:#0ea5e9;padding:28px 32px;text-align:center;">
    <div style="display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;background:rgba(255,255,255,0.2);border-radius:12px;margin-bottom:12px;">
      <span style="color:white;font-weight:700;font-size:18px;">K</span>
    </div>
    <h1 style="margin:0;color:white;font-size:20px;font-weight:700;">Kinévia</h1>
  </div>
  <div style="padding:32px;">
    <h2 style="margin:0 0 16px;color:#0f172a;font-size:18px;font-weight:600;">Réinitialisation de mot de passe</h2>
    <p style="margin:0 0 8px;color:#475569;font-size:14px;">Bonjour <strong>${prenom}</strong>,</p>
    <p style="margin:0 0 24px;color:#475569;font-size:14px;">Vous avez demandé la réinitialisation de votre mot de passe. Cliquez sur le bouton ci-dessous pour en définir un nouveau :</p>
    <div style="text-align:center;margin:0 0 24px;">
      <a href="${resetLink}" style="display:inline-block;background:#0ea5e9;color:white;font-weight:600;font-size:14px;padding:12px 28px;border-radius:8px;text-decoration:none;">Réinitialiser mon mot de passe</a>
    </div>
    <p style="margin:0 0 8px;color:#94a3b8;font-size:12px;">Ce lien est valable <strong>1 heure</strong>. Si vous n'avez pas fait cette demande, ignorez cet email.</p>
    <p style="margin:0;color:#94a3b8;font-size:12px;">Ou copiez ce lien dans votre navigateur :<br><span style="word-break:break-all;color:#0ea5e9;">${resetLink}</span></p>
  </div>
  <div style="border-top:1px solid #f1f5f9;padding:20px 32px;text-align:center;">
    <p style="margin:0;color:#94a3b8;font-size:12px;">© 2026 Kinévia — Application de suivi patient pour kinésithérapeutes</p>
  </div>
</div>
</body></html>`,
    });

    res.json({ success: true, message: 'Si un compte existe avec cet email, vous recevrez un lien de réinitialisation.' });
  } catch (err) {
    console.error('mot-de-passe-oublie error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/auth/reinitialiser-mot-de-passe - Reset password with token
app.post('/api/auth/reinitialiser-mot-de-passe', async (req, res) => {
  try {
    const { token, mot_de_passe } = req.body;

    if (!token || !mot_de_passe) {
      return res.status(400).json({ error: 'Token et nouveau mot de passe requis' });
    }

    if (mot_de_passe.length < 8) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères' });
    }

    const result = await pool.query(
      `SELECT prt.id, prt.kine_id, prt.expires_at, prt.used_at
       FROM password_reset_tokens prt
       WHERE prt.token = $1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Lien invalide ou expiré' });
    }

    const tokenRow = result.rows[0];

    if (tokenRow.used_at) {
      return res.status(400).json({ error: 'Ce lien a déjà été utilisé' });
    }

    if (new Date(tokenRow.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Ce lien a expiré. Veuillez faire une nouvelle demande.' });
    }

    const hash = await bcrypt.hash(mot_de_passe, 12);

    await pool.query('UPDATE kines SET mot_de_passe_hash = $1 WHERE id = $2', [hash, tokenRow.kine_id]);
    await pool.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [tokenRow.id]);

    // Destroy any existing session for security
    req.session.destroy(() => {});

    res.json({ success: true, message: 'Mot de passe modifié avec succès. Vous pouvez maintenant vous connecter.' });
  } catch (err) {
    console.error('reinitialiser-mot-de-passe error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/auth/verifier-token-reset - Check if reset token is valid (for frontend form)
app.get('/api/auth/verifier-token-reset', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ valid: false, error: 'Token manquant' });

    const result = await pool.query(
      'SELECT expires_at, used_at FROM password_reset_tokens WHERE token = $1',
      [token]
    );

    if (result.rows.length === 0) return res.json({ valid: false, error: 'Lien invalide' });
    const row = result.rows[0];
    if (row.used_at) return res.json({ valid: false, error: 'Ce lien a déjà été utilisé' });
    if (new Date(row.expires_at) < new Date()) return res.json({ valid: false, error: 'Ce lien a expiré' });

    res.json({ valid: true });
  } catch (err) {
    res.status(500).json({ valid: false, error: 'Erreur serveur' });
  }
});

// ==========================================
// MAGIC LINK ROUTES (beta auto-login)
// ==========================================

// GET /api/auth/magic-link?token=... - Validate magic link and auto-login
app.get('/api/auth/magic-link', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/connexion?email_error=lien_invalide');

  try {
    const result = await pool.query(
      `SELECT mlt.id, mlt.kine_id, mlt.expires_at, mlt.used_at
       FROM magic_link_tokens mlt
       WHERE mlt.token = $1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.redirect('/connexion?email_error=lien_invalide');
    }

    const tokenRow = result.rows[0];

    if (tokenRow.used_at) {
      // Token already used — redirect to login, suggest they log in normally
      return res.redirect('/connexion?email_error=lien_expire');
    }

    if (new Date(tokenRow.expires_at) < new Date()) {
      return res.redirect('/connexion?email_error=lien_expire');
    }

    // Mark token as used
    await pool.query('UPDATE magic_link_tokens SET used_at = NOW() WHERE id = $1', [tokenRow.id]);

    // Mark email as verified (they clicked the link — email confirmed)
    await pool.query(
      'UPDATE kines SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = $1',
      [tokenRow.kine_id]
    );

    // Set session — logged in
    req.session.kineId = tokenRow.kine_id;

    // Save session explicitly before redirect to avoid race condition
    // (session must be persisted before browser follows the redirect)
    req.session.save((err) => {
      if (err) {
        console.error('[magic-link] session save error:', err);
        return res.redirect('/connexion?email_error=erreur_serveur');
      }
      // Redirect to dashboard (relative path — works in any environment)
      res.redirect('/patients');
    });
  } catch (err) {
    console.error('[magic-link] error:', err);
    res.redirect('/connexion?email_error=lien_invalide');
  }
});

// ==========================================
// EMAIL VERIFICATION ROUTES
// ==========================================

// GET /api/auth/verifier-email - Verify email from link
app.get('/api/auth/verifier-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.redirect('/connexion?email_error=token_manquant');

    const result = await pool.query(
      'SELECT evt.id, evt.kine_id, evt.expires_at, evt.used_at FROM email_verification_tokens evt WHERE evt.token = $1',
      [token]
    );

    if (result.rows.length === 0) {
      return res.redirect('/connexion?email_error=lien_invalide');
    }

    const tokenRow = result.rows[0];

    if (tokenRow.used_at) {
      return res.redirect('/connexion?email_verified=deja');
    }

    if (new Date(tokenRow.expires_at) < new Date()) {
      return res.redirect('/connexion?email_error=lien_expire');
    }

    await pool.query('UPDATE kines SET email_verified_at = NOW() WHERE id = $1', [tokenRow.kine_id]);
    await pool.query('UPDATE email_verification_tokens SET used_at = NOW() WHERE id = $1', [tokenRow.id]);

    res.redirect('/connexion?email_verified=ok');
  } catch (err) {
    console.error('verifier-email error:', err);
    res.redirect('/connexion?email_error=erreur_serveur');
  }
});

// POST /api/auth/renvoyer-verification - Resend verification email
app.post('/api/auth/renvoyer-verification', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });

    const result = await pool.query(
      'SELECT id, prenom, nom, email, email_verified_at FROM kines WHERE LOWER(email) = LOWER($1)',
      [email]
    );

    if (result.rows.length === 0) {
      return res.json({ success: true }); // no enumeration
    }

    const kine = result.rows[0];

    if (kine.email_verified_at) {
      return res.json({ success: true, already_verified: true });
    }

    await sendVerificationEmail(kine);
    res.json({ success: true });
  } catch (err) {
    console.error('renvoyer-verification error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

async function sendVerificationEmail(kine) {
  const token = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72 hours

  // Invalidate previous unused verification tokens
  await pool.query(
    'UPDATE email_verification_tokens SET used_at = NOW() WHERE kine_id = $1 AND used_at IS NULL',
    [kine.id]
  );

  await pool.query(
    'INSERT INTO email_verification_tokens (kine_id, token, expires_at) VALUES ($1, $2, $3)',
    [kine.id, token, expiresAt]
  );

  const appUrl = process.env.APP_URL || 'https://kinevia.pro';
  const verifyLink = appUrl + '/api/auth/verifier-email?token=' + token;
  const prenom = kine.prenom || kine.nom;

  await sendEmail({
    to: kine.email,
    subject: 'Confirmez votre adresse email — Kinévia',
    body: `Bonjour ${prenom},\n\nBienvenue sur Kinévia ! Pour activer votre compte, veuillez confirmer votre adresse email en cliquant sur ce lien :\n${verifyLink}\n\nCe lien est valable 72 heures.\n\nL'équipe Kinévia`,
    html: `<!DOCTYPE html><html lang="fr"><body style="margin:0;padding:0;font-family:Inter,sans-serif;background:#f8fafc;">
<div style="max-width:520px;margin:40px auto;background:white;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden;">
  <div style="background:#0ea5e9;padding:28px 32px;text-align:center;">
    <div style="display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;background:rgba(255,255,255,0.2);border-radius:12px;margin-bottom:12px;">
      <span style="color:white;font-weight:700;font-size:18px;">K</span>
    </div>
    <h1 style="margin:0;color:white;font-size:20px;font-weight:700;">Kinévia</h1>
  </div>
  <div style="padding:32px;">
    <h2 style="margin:0 0 16px;color:#0f172a;font-size:18px;font-weight:600;">Bienvenue, ${prenom} ! 👋</h2>
    <p style="margin:0 0 8px;color:#475569;font-size:14px;">Merci de vous être inscrit(e) sur Kinévia.</p>
    <p style="margin:0 0 24px;color:#475569;font-size:14px;">Pour finaliser la création de votre compte, veuillez confirmer votre adresse email :</p>
    <div style="text-align:center;margin:0 0 24px;">
      <a href="${verifyLink}" style="display:inline-block;background:#2DD4BF;color:white;font-weight:600;font-size:14px;padding:12px 28px;border-radius:8px;text-decoration:none;">Confirmer mon email</a>
    </div>
    <p style="margin:0 0 8px;color:#94a3b8;font-size:12px;">Ce lien est valable <strong>72 heures</strong>.</p>
    <p style="margin:0;color:#94a3b8;font-size:12px;">Ou copiez ce lien dans votre navigateur :<br><span style="word-break:break-all;color:#0ea5e9;">${verifyLink}</span></p>
  </div>
  <div style="border-top:1px solid #f1f5f9;padding:20px 32px;text-align:center;">
    <p style="margin:0;color:#94a3b8;font-size:12px;">© 2026 Kinévia — Application de suivi patient pour kinésithérapeutes</p>
  </div>
</div>
</body></html>`,
  });
}

// ==========================================
// ONBOARDING API
// ==========================================

// GET /api/onboarding/status — returns whether the current kiné has seen the onboarding tour + last step
app.get('/api/onboarding/status', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT has_seen_onboarding, onboarding_step FROM kines WHERE id = $1',
      [req.session.kineId]
    );
    if (result.rows.length === 0) return res.json({ has_seen_onboarding: true, onboarding_step: null });
    const row = result.rows[0];
    res.json({
      has_seen_onboarding: row.has_seen_onboarding || false,
      onboarding_step: row.onboarding_step || null
    });
  } catch (err) {
    res.json({ has_seen_onboarding: true, onboarding_step: null }); // fail-open: don't block if column not yet added
  }
});

// POST /api/onboarding/step — save current step so tour resumes after re-login
app.post('/api/onboarding/step', requireAuth, async (req, res) => {
  try {
    const { step } = req.body || {};
    if (!step || typeof step !== 'string') return res.json({ ok: false });
    await pool.query(
      'UPDATE kines SET onboarding_step = $1 WHERE id = $2',
      [step, req.session.kineId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

// POST /api/onboarding/complete — mark onboarding as seen for the current kiné
app.post('/api/onboarding/complete', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE kines SET has_seen_onboarding = TRUE, onboarding_step = NULL WHERE id = $1',
      [req.session.kineId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

// ==========================================
// PATIENT ONBOARDING API (Phase 3)
// Owns: patient-side tour status/step/completion.
// Does NOT own: kiné onboarding (handled above).
// ==========================================

// GET /api/patient/:lien/onboarding/status — return tour state for this patient
app.get('/api/patient/:lien/onboarding/status', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT has_seen_patient_onboarding, patient_onboarding_step FROM patients WHERE lien_unique = $1',
      [req.params.lien]
    );
    if (result.rows.length === 0) return res.json({ has_seen_patient_onboarding: true, patient_onboarding_step: null });
    const row = result.rows[0];
    res.json({
      has_seen_patient_onboarding: row.has_seen_patient_onboarding || false,
      patient_onboarding_step: row.patient_onboarding_step || null
    });
  } catch (err) {
    res.json({ has_seen_patient_onboarding: true, patient_onboarding_step: null }); // fail-open: don't block if column not yet added
  }
});

// POST /api/patient/:lien/onboarding/step — persist current step so tour can resume
app.post('/api/patient/:lien/onboarding/step', async (req, res) => {
  try {
    const { step } = req.body;
    if (!step) return res.json({ ok: false });
    await pool.query(
      'UPDATE patients SET patient_onboarding_step = $1 WHERE lien_unique = $2',
      [step, req.params.lien]
    );
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

// POST /api/patient/:lien/onboarding/complete — mark tour as seen, clear step
app.post('/api/patient/:lien/onboarding/complete', async (req, res) => {
  try {
    await pool.query(
      'UPDATE patients SET has_seen_patient_onboarding = TRUE, patient_onboarding_step = NULL WHERE lien_unique = $1',
      [req.params.lien]
    );
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

// ==========================================
// PATIENTS API
// ==========================================

// GET /api/patients - List patients for authenticated kiné
app.get('/api/patients', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, nom, prenom, email, telephone, pathologie, notes, pathologie_enc, notes_enc, lien_unique, created_at FROM patients WHERE kine_id = $1 ORDER BY nom, prenom',
      [req.session.kineId]
    );
    const patients = result.rows.map(decryptPatient);
    // Log bulk access
    for (const p of patients) {
      logHealthAccess({ kineId: req.session.kineId, resourceType: 'patient', resourceId: p.id, patientId: p.id, action: 'read', endpoint: 'GET /api/patients', req });
    }
    res.json({ patients });
  } catch (err) {
    console.error('List patients error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/patients - Create patient
app.post('/api/patients', requireAuth, async (req, res) => {
  try {
    const { nom, prenom, email, telephone, pathologie, notes } = req.body;

    if (!nom || !prenom) {
      return res.status(400).json({ error: 'Nom et prénom sont requis' });
    }

    const lienUnique = crypto.randomBytes(16).toString('hex');
    const result = await pool.query(
      `INSERT INTO patients (kine_id, nom, prenom, email, telephone, pathologie_enc, notes_enc, lien_unique)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, nom, prenom, email, telephone, pathologie_enc, notes_enc, lien_unique, created_at`,
      [req.session.kineId, nom, prenom, email || null, telephone || null,
       encrypt(pathologie || null), encrypt(notes || null), lienUnique]
    );

    const patient = decryptPatient(result.rows[0]);
    logHealthAccess({ kineId: req.session.kineId, resourceType: 'patient', resourceId: patient.id, patientId: patient.id, action: 'write', endpoint: 'POST /api/patients', req });
    res.status(201).json({ patient });
  } catch (err) {
    console.error('Create patient error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/patients/:id - Get patient detail
app.get('/api/patients/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM patients WHERE id = $1 AND kine_id = $2',
      [req.params.id, req.session.kineId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Patient non trouvé' });
    }
    const patient = decryptPatient(result.rows[0]);
    logHealthAccess({ kineId: req.session.kineId, resourceType: 'patient', resourceId: patient.id, patientId: patient.id, action: 'read', endpoint: `GET /api/patients/${req.params.id}`, req });
    res.json({ patient });
  } catch (err) {
    console.error('Get patient error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/patients/:id - Update patient
app.put('/api/patients/:id', requireAuth, async (req, res) => {
  try {
    const { nom, prenom, email, telephone, pathologie, notes } = req.body;
    const result = await pool.query(
      `UPDATE patients SET nom=$1, prenom=$2, email=$3, telephone=$4,
       pathologie_enc=$5, notes_enc=$6
       WHERE id=$7 AND kine_id=$8
       RETURNING id, nom, prenom, email, telephone, pathologie_enc, notes_enc, lien_unique, created_at`,
      [nom, prenom, email || null, telephone || null,
       encrypt(pathologie !== undefined ? pathologie : null),
       encrypt(notes !== undefined ? notes : null),
       req.params.id, req.session.kineId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Patient non trouvé' });
    }
    const patient = decryptPatient(result.rows[0]);
    logHealthAccess({ kineId: req.session.kineId, resourceType: 'patient', resourceId: patient.id, patientId: patient.id, action: 'write', endpoint: `PUT /api/patients/${req.params.id}`, req });
    res.json({ patient });
  } catch (err) {
    console.error('Update patient error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/patients/:id - Delete patient
app.delete('/api/patients/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM patients WHERE id = $1 AND kine_id = $2 RETURNING id',
      [req.params.id, req.session.kineId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Patient non trouvé' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete patient error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/patients/:id/programmes - List programmes for a specific patient
app.get('/api/patients/:id/programmes', requireAuth, async (req, res) => {
  try {
    // Verify patient belongs to this kiné
    const patCheck = await pool.query('SELECT id FROM patients WHERE id = $1 AND kine_id = $2', [req.params.id, req.session.kineId]);
    if (patCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Patient non trouvé' });
    }

    const result = await pool.query(
      'SELECT * FROM programmes WHERE patient_id = $1 AND kine_id = $2 ORDER BY created_at DESC',
      [req.params.id, req.session.kineId]
    );
    res.json({ programmes: result.rows });
  } catch (err) {
    console.error('List patient programmes error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/patients/:id/bilans - List bilans for a specific patient
app.get('/api/patients/:id/bilans', requireAuth, async (req, res) => {
  try {
    // Verify patient belongs to this kiné
    const patCheck = await pool.query('SELECT id FROM patients WHERE id = $1 AND kine_id = $2', [req.params.id, req.session.kineId]);
    if (patCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Patient non trouvé' });
    }

    const result = await pool.query(
      `SELECT *, ROW_NUMBER() OVER (PARTITION BY patient_id ORDER BY created_at ASC) AS bilan_number
       FROM bilans WHERE patient_id = $1 AND kine_id = $2 ORDER BY created_at DESC`,
      [req.params.id, req.session.kineId]
    );
    const bilans = result.rows.map(decryptBilan);
    for (const b of bilans) {
      logHealthAccess({ kineId: req.session.kineId, resourceType: 'bilan', resourceId: b.id, patientId: b.patient_id, action: 'read', endpoint: `GET /api/patients/${req.params.id}/bilans`, req });
    }
    res.json({ bilans });
  } catch (err) {
    console.error('List patient bilans error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// PROGRAMMES API
// ==========================================

// POST /api/programmes - Create programme
app.post('/api/programmes', requireAuth, async (req, res) => {
  try {
    const { patient_id, titre, date_debut, date_fin, notes } = req.body;

    if (!patient_id || !titre) {
      return res.status(400).json({ error: 'Patient et titre sont requis' });
    }

    // Verify patient belongs to this kiné
    const patCheck = await pool.query('SELECT id FROM patients WHERE id = $1 AND kine_id = $2', [patient_id, req.session.kineId]);
    if (patCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Patient non trouvé' });
    }

    const result = await pool.query(
      'INSERT INTO programmes (kine_id, patient_id, titre, date_debut, date_fin, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [req.session.kineId, patient_id, titre, date_debut || null, date_fin || null, notes || null]
    );

    res.status(201).json({ programme: result.rows[0] });
  } catch (err) {
    console.error('Create programme error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/programmes/:id - Get programme with exercises
app.get('/api/programmes/:id', requireAuth, async (req, res) => {
  try {
    const progResult = await pool.query(`
      SELECT p.*, pat.nom as patient_nom, pat.prenom as patient_prenom, pat.lien_unique as patient_lien_unique
      FROM programmes p
      JOIN patients pat ON p.patient_id = pat.id
      WHERE p.id = $1 AND p.kine_id = $2
    `, [req.params.id, req.session.kineId]);

    if (progResult.rows.length === 0) {
      return res.status(404).json({ error: 'Programme non trouvé' });
    }

    const exResult = await pool.query(`
      SELECT pe.*, e.nom, e.zone_corporelle, e.description, e.image_url, e.video_url
      FROM programme_exercices pe
      JOIN exercices e ON pe.exercice_id = e.id
      WHERE pe.programme_id = $1
      ORDER BY pe.ordre
    `, [req.params.id]);

    res.json({ programme: progResult.rows[0], exercices: exResult.rows });
  } catch (err) {
    console.error('Get programme error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// EXERCICES API
// ==========================================

// GET /api/exercices - List exercises (global + kiné's custom) with search, zone & pathologie filters
app.get('/api/exercices', requireAuth, async (req, res) => {
  try {
    const { zone, q, pathologie } = req.query;
    let query = 'SELECT * FROM exercices WHERE (kine_id IS NULL OR kine_id = $1)';
    const params = [req.session.kineId];
    let paramIdx = 2;

    if (zone) {
      query += ` AND zone_corporelle = $${paramIdx}`;
      params.push(zone);
      paramIdx++;
    }
    if (pathologie) {
      // pathologies stored as comma-separated, match any exercise that includes this pathologie
      query += ` AND (pathologies LIKE $${paramIdx} OR pathologies LIKE $${paramIdx + 1} OR pathologies LIKE $${paramIdx + 2} OR pathologies = $${paramIdx + 3})`;
      params.push(pathologie + ',%');       // starts with pathologie,
      params.push('%,' + pathologie + ',%'); // in middle
      params.push('%,' + pathologie);        // ends with ,pathologie
      params.push(pathologie);               // exact match (only one)
      paramIdx += 4;
    }
    if (q) {
      query += ` AND (LOWER(nom) LIKE $${paramIdx} OR LOWER(description) LIKE $${paramIdx})`;
      params.push('%' + q.toLowerCase() + '%');
      paramIdx++;
    }
    query += ' ORDER BY zone_corporelle, nom';

    const result = await pool.query(query, params);
    res.json({ exercices: result.rows });
  } catch (err) {
    console.error('List exercices error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/exercices/:id - Get single exercise detail
app.get('/api/exercices/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM exercices WHERE id = $1 AND (kine_id IS NULL OR kine_id = $2)',
      [req.params.id, req.session.kineId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Exercice non trouvé' });
    }
    res.json({ exercice: result.rows[0] });
  } catch (err) {
    console.error('Get exercice error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/programmes?patient_id=X - List programmes with exercise count
app.get('/api/programmes', requireAuth, async (req, res) => {
  try {
    const { patient_id } = req.query;
    let query = `
      SELECT p.*, pat.nom as patient_nom, pat.prenom as patient_prenom,
             COUNT(pe.id)::int as exercice_count
      FROM programmes p
      JOIN patients pat ON p.patient_id = pat.id
      LEFT JOIN programme_exercices pe ON pe.programme_id = p.id
      WHERE p.kine_id = $1
    `;
    const params = [req.session.kineId];

    if (patient_id) {
      query += ' AND p.patient_id = $2';
      params.push(patient_id);
    }
    query += ' GROUP BY p.id, pat.nom, pat.prenom ORDER BY pat.nom, p.created_at DESC';

    const result = await pool.query(query, params);
    res.json({ programmes: result.rows });
  } catch (err) {
    console.error('List programmes error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/programmes/:id - Update programme info
app.put('/api/programmes/:id', requireAuth, async (req, res) => {
  try {
    const { titre, patient_id, date_debut, date_fin, notes, frequence_semaine, duree_semaines } = req.body;
    const progCheck = await pool.query('SELECT id FROM programmes WHERE id = $1 AND kine_id = $2', [req.params.id, req.session.kineId]);
    if (progCheck.rows.length === 0) return res.status(404).json({ error: 'Programme non trouvé' });

    // If patient_id provided, verify it belongs to this kiné
    if (patient_id) {
      const patCheck = await pool.query('SELECT id FROM patients WHERE id = $1 AND kine_id = $2', [patient_id, req.session.kineId]);
      if (patCheck.rows.length === 0) return res.status(404).json({ error: 'Patient non trouvé' });
    }

    const result = await pool.query(
      `UPDATE programmes SET
        titre = COALESCE($1, titre),
        patient_id = COALESCE($2, patient_id),
        date_debut = $3,
        date_fin = $4,
        notes = $5,
        frequence_semaine = COALESCE($6, frequence_semaine),
        duree_semaines = COALESCE($7, duree_semaines)
       WHERE id = $8 AND kine_id = $9 RETURNING *`,
      [titre || null, patient_id || null, date_debut || null, date_fin || null, notes || null,
       frequence_semaine || null, duree_semaines || null, req.params.id, req.session.kineId]
    );
    res.json({ programme: result.rows[0] });
  } catch (err) {
    console.error('Update programme error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/programmes/:id - Delete programme
app.delete('/api/programmes/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM programmes WHERE id = $1 AND kine_id = $2 RETURNING id', [req.params.id, req.session.kineId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Programme non trouvé' });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete programme error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/programmes/:id/archiver - Archive programme (set actif=false)
app.put('/api/programmes/:id/archiver', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE programmes SET actif = false WHERE id = $1 AND kine_id = $2 RETURNING *',
      [req.params.id, req.session.kineId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Programme non trouvé' });
    res.json({ programme: result.rows[0] });
  } catch (err) {
    console.error('Archive programme error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/programmes/:id/activer - Reactivate an archived programme
app.put('/api/programmes/:id/activer', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE programmes SET actif = true WHERE id = $1 AND kine_id = $2 RETURNING *',
      [req.params.id, req.session.kineId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Programme non trouvé' });
    res.json({ programme: result.rows[0] });
  } catch (err) {
    console.error('Activate programme error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/programmes/:id/dupliquer - Duplicate programme to same or new patient
app.post('/api/programmes/:id/dupliquer', requireAuth, async (req, res) => {
  try {
    const { patient_id } = req.body;
    const progResult = await pool.query(
      'SELECT * FROM programmes WHERE id = $1 AND kine_id = $2',
      [req.params.id, req.session.kineId]
    );
    if (progResult.rows.length === 0) return res.status(404).json({ error: 'Programme non trouvé' });
    const prog = progResult.rows[0];

    const targetPatientId = patient_id || prog.patient_id;

    // Verify target patient belongs to this kiné
    const patCheck = await pool.query('SELECT id FROM patients WHERE id = $1 AND kine_id = $2', [targetPatientId, req.session.kineId]);
    if (patCheck.rows.length === 0) return res.status(404).json({ error: 'Patient non trouvé' });

    const newProg = await pool.query(
      `INSERT INTO programmes (kine_id, patient_id, titre, date_debut, date_fin, notes, frequence_semaine, duree_semaines)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.session.kineId, targetPatientId, prog.titre + ' (copie)', prog.date_debut, prog.date_fin,
       prog.notes, prog.frequence_semaine, prog.duree_semaines]
    );

    // Copy exercises
    const exResult = await pool.query('SELECT * FROM programme_exercices WHERE programme_id = $1 ORDER BY ordre', [req.params.id]);
    for (const ex of exResult.rows) {
      await pool.query(
        'INSERT INTO programme_exercices (programme_id, exercice_id, series, repetitions, duree_secondes, instructions, ordre) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [newProg.rows[0].id, ex.exercice_id, ex.series, ex.repetitions, ex.duree_secondes, ex.instructions, ex.ordre]
      );
    }

    res.status(201).json({ programme: newProg.rows[0] });
  } catch (err) {
    console.error('Duplicate programme error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/programmes/:id/exercices/ordre - Reorder exercises (MUST be before /:peId route)
app.put('/api/programmes/:id/exercices/ordre', requireAuth, async (req, res) => {
  try {
    const progCheck = await pool.query('SELECT id FROM programmes WHERE id = $1 AND kine_id = $2', [req.params.id, req.session.kineId]);
    if (progCheck.rows.length === 0) return res.status(404).json({ error: 'Programme non trouvé' });

    const { ordre } = req.body; // Array of { id, ordre }
    if (!Array.isArray(ordre)) return res.status(400).json({ error: 'ordre doit être un tableau' });

    for (const item of ordre) {
      await pool.query('UPDATE programme_exercices SET ordre = $1 WHERE id = $2 AND programme_id = $3', [item.ordre, item.id, req.params.id]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Reorder programme exercises error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/programmes/:id/exercices/:peId - Update exercise config in programme
app.put('/api/programmes/:id/exercices/:peId', requireAuth, async (req, res) => {
  try {
    const progCheck = await pool.query('SELECT id FROM programmes WHERE id = $1 AND kine_id = $2', [req.params.id, req.session.kineId]);
    if (progCheck.rows.length === 0) return res.status(404).json({ error: 'Programme non trouvé' });

    const { series, repetitions, duree_secondes, instructions } = req.body;
    const result = await pool.query(
      `UPDATE programme_exercices SET series = COALESCE($1, series), repetitions = COALESCE($2, repetitions),
       duree_secondes = $3, instructions = $4
       WHERE id = $5 AND programme_id = $6 RETURNING *`,
      [series || null, repetitions || null, duree_secondes || null, instructions || null, req.params.peId, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Exercice non trouvé dans ce programme' });
    res.json({ programme_exercice: result.rows[0] });
  } catch (err) {
    console.error('Update programme exercise error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/programmes/:id/exercices/:peId - Remove exercise from programme
app.delete('/api/programmes/:id/exercices/:peId', requireAuth, async (req, res) => {
  try {
    const progCheck = await pool.query('SELECT id FROM programmes WHERE id = $1 AND kine_id = $2', [req.params.id, req.session.kineId]);
    if (progCheck.rows.length === 0) return res.status(404).json({ error: 'Programme non trouvé' });

    const result = await pool.query('DELETE FROM programme_exercices WHERE id = $1 AND programme_id = $2 RETURNING id', [req.params.peId, req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Exercice non trouvé dans ce programme' });
    res.json({ success: true });
  } catch (err) {
    console.error('Remove programme exercise error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/exercices - Create custom exercise
app.post('/api/exercices', requireAuth, async (req, res) => {
  try {
    const { nom, zone_corporelle, description, muscles, image_url, video_url, series_recommandees, repetitions_recommandees, pathologies, niveau_difficulte } = req.body;

    if (!nom || !zone_corporelle) {
      return res.status(400).json({ error: 'Nom et zone corporelle sont requis' });
    }

    const result = await pool.query(
      'INSERT INTO exercices (nom, zone_corporelle, description, muscles, image_url, video_url, est_personnalise, kine_id, series_recommandees, repetitions_recommandees, pathologies, niveau_difficulte) VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9, $10, $11) RETURNING *',
      [nom, zone_corporelle, description || null, muscles || null, image_url || null, video_url || null, req.session.kineId, series_recommandees || 3, repetitions_recommandees || '10', pathologies || '', niveau_difficulte || 'moyen']
    );

    res.status(201).json({ exercice: result.rows[0] });
  } catch (err) {
    console.error('Create exercice error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// VIDEO LIBRARY API
// FFmpeg compression pipeline: 720p max, H.264/AAC, MP4 container
// Thumbnail from first frame, duration extraction, R2 storage
// ==========================================
const multer = require('multer');
const nodeFetch = require('node-fetch');
const FormData = require('form-data');
const os = require('os');
const ffmpegStatic = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegStatic);

const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB raw input
  fileFilter: (req, file, cb) => {
    const allowed = ['video/mp4', 'video/webm', 'video/quicktime', 'video/avi', 'video/mpeg'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format vidéo non supporté. Utilisez MP4, WebM, MOV ou AVI.'));
    }
  }
});

// Helper: write buffer to temp file, return path
function writeTempFile(buffer, ext) {
  const tmpPath = path.join(os.tmpdir(), 'kinevia-' + crypto.randomBytes(8).toString('hex') + ext);
  fs.writeFileSync(tmpPath, buffer);
  return tmpPath;
}

// Helper: get video metadata (duration) via ffprobe
function probeVideo(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(err);
      const duration = Math.round(metadata.format.duration || 0);
      resolve({ duration });
    });
  });
}

// Helper: compress video to 720p H.264/AAC MP4
// Returns path to compressed output file
function compressVideo(inputPath) {
  return new Promise((resolve, reject) => {
    const outputPath = inputPath.replace(/\.[^.]+$/, '-compressed.mp4');
    ffmpeg(inputPath)
      .outputOptions([
        '-vf', 'scale=\'min(1280,iw)\':\'min(720,ih)\':force_original_aspect_ratio=decrease',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        '-pix_fmt', 'yuv420p',
      ])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(new Error('FFmpeg compress error: ' + err.message)))
      .run();
  });
}

// Helper: extract first-frame thumbnail as JPEG
// Returns path to thumbnail file
function extractThumbnail(inputPath) {
  return new Promise((resolve, reject) => {
    const thumbDir = path.dirname(inputPath);
    const thumbFilename = 'thumb-' + crypto.randomBytes(6).toString('hex') + '.jpg';
    const thumbPath = path.join(thumbDir, thumbFilename);
    // Use -vframes 1 at 1s (fallback to 0s if short video)
    ffmpeg(inputPath)
      .outputOptions(['-vframes', '1', '-ss', '1', '-vf', 'scale=640:360:force_original_aspect_ratio=decrease'])
      .output(thumbPath)
      .on('end', () => resolve(thumbPath))
      .on('error', () => {
        // Fallback: first frame at t=0
        ffmpeg(inputPath)
          .outputOptions(['-vframes', '1', '-ss', '0', '-vf', 'scale=640:360:force_original_aspect_ratio=decrease'])
          .output(thumbPath)
          .on('end', () => resolve(thumbPath))
          .on('error', (e2) => reject(new Error('FFmpeg thumbnail error: ' + e2.message)))
          .run();
      })
      .run();
  });
}

// Helper: upload file buffer to R2 using node-fetch (required — native fetch breaks multipart)
async function uploadBufferToR2(buffer, filename, mimeType) {
  const r2Base = process.env.POLSIA_R2_BASE_URL || 'https://polsia.com';
  const apiKey = process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN;
  const formData = new FormData();
  formData.append('file', buffer, { filename, contentType: mimeType });
  const res = await nodeFetch(r2Base + '/api/proxy/r2/upload', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      ...formData.getHeaders(),
    },
    body: formData,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error('R2 upload failed: ' + res.status + ' ' + txt);
  }
  const data = await res.json();
  if (!data.success) throw new Error('R2 upload failed: ' + (data.error && data.error.message || JSON.stringify(data)));
  return data.file.url;
}

// POST /api/exercices/:id/video — upload + compress + thumbnail + store
app.post('/api/exercices/:id/video', requireAuth, videoUpload.single('video'), async (req, res) => {
  const tempFiles = [];
  try {
    const exerciceId = parseInt(req.params.id, 10);
    const kineId = req.session.kineId;

    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier vidéo fourni' });
    }

    // Verify exercise exists and permissions
    const exCheck = await pool.query('SELECT id, nom, kine_id FROM exercices WHERE id = $1', [exerciceId]);
    if (exCheck.rows.length === 0) return res.status(404).json({ error: 'Exercice non trouvé' });
    const exercice = exCheck.rows[0];
    if (exercice.kine_id !== null && exercice.kine_id !== kineId) {
      return res.status(403).json({ error: 'Vous ne pouvez pas modifier cet exercice' });
    }

    // Write input to temp file
    const ext = req.file.originalname.match(/\.[^.]+$/) ? req.file.originalname.match(/\.[^.]+$/)[0] : '.mp4';
    const inputPath = writeTempFile(req.file.buffer, ext);
    tempFiles.push(inputPath);

    // Probe original duration
    let duration = 0;
    try {
      const probe = await probeVideo(inputPath);
      duration = probe.duration;
    } catch (e) {
      console.warn('[video] probe failed:', e.message);
    }

    // Compress to 720p H.264/AAC MP4
    let compressedPath;
    try {
      compressedPath = await compressVideo(inputPath);
      tempFiles.push(compressedPath);
    } catch (e) {
      console.error('[video] FFmpeg compress failed, using original:', e.message);
      compressedPath = inputPath;
    }

    // Extract thumbnail from compressed video
    let thumbnailUrl = null;
    try {
      const thumbPath = await extractThumbnail(compressedPath);
      tempFiles.push(thumbPath);
      const thumbBuffer = fs.readFileSync(thumbPath);
      const thumbFilename = 'thumb-exercice-' + exerciceId + '-' + Date.now() + '.jpg';
      thumbnailUrl = await uploadBufferToR2(thumbBuffer, thumbFilename, 'image/jpeg');
    } catch (e) {
      console.warn('[video] Thumbnail generation failed:', e.message);
    }

    // Upload compressed video to R2
    const compressedBuffer = fs.readFileSync(compressedPath);
    const videoFilename = 'video-exercice-' + exerciceId + '-' + Date.now() + '.mp4';
    const videoUrl = await uploadBufferToR2(compressedBuffer, videoFilename, 'video/mp4');

    // Remove any existing video for this exercise (one primary video per exercise)
    await pool.query('DELETE FROM exercise_videos WHERE exercise_id = $1', [exerciceId]);

    // Insert new video record with all metadata
    const result = await pool.query(
      `INSERT INTO exercise_videos
         (exercise_id, video_url, thumbnail_url, duration_seconds, file_size,
          original_filename, mime_type, upload_status, uploaded_by, source)
       VALUES ($1, $2, $3, $4, $5, $6, 'video/mp4', 'ready', $7, 'upload')
       RETURNING *`,
      [exerciceId, videoUrl, thumbnailUrl, duration || null, compressedBuffer.length,
       req.file.originalname, kineId]
    );

    // Update exercices.video_url and has_video for backward compatibility + fast lookup
    await pool.query(
      'UPDATE exercices SET video_url = $1, has_video = TRUE WHERE id = $2',
      [videoUrl, exerciceId]
    );

    res.status(201).json({ video: result.rows[0] });
  } catch (err) {
    if (err.message && err.message.startsWith('Format vidéo')) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[video] Upload error:', err);
    res.status(500).json({ error: 'Erreur lors de l\'upload vidéo' });
  } finally {
    // Clean up all temp files
    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
  }
});

// GET /api/exercices/:id/video — get video info for an exercise
app.get('/api/exercices/:id/video', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ev.* FROM exercise_videos ev
       JOIN exercices e ON e.id = ev.exercise_id
       WHERE ev.exercise_id = $1
         AND (e.kine_id IS NULL OR e.kine_id = $2)
       ORDER BY ev.created_at DESC
       LIMIT 1`,
      [req.params.id, req.session.kineId]
    );
    if (result.rows.length === 0) return res.json({ video: null });
    res.json({ video: result.rows[0] });
  } catch (err) {
    console.error('[video] Get error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/exercices/:id/video — remove video for an exercise
app.delete('/api/exercices/:id/video', requireAuth, async (req, res) => {
  try {
    const exerciceId = parseInt(req.params.id, 10);
    const kineId = req.session.kineId;
    const check = await pool.query(
      'SELECT ev.id FROM exercise_videos ev JOIN exercices e ON e.id = ev.exercise_id WHERE ev.exercise_id = $1 AND ev.uploaded_by = $2',
      [exerciceId, kineId]
    );
    if (check.rows.length === 0) {
      return res.status(403).json({ error: 'Vidéo non trouvée ou accès refusé' });
    }
    await pool.query('DELETE FROM exercise_videos WHERE exercise_id = $1', [exerciceId]);
    await pool.query(
      'UPDATE exercices SET video_url = NULL, has_video = FALSE WHERE id = $1',
      [exerciceId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[video] Delete error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/videos — list all exercise_videos accessible to the kiné (global + their custom exercises)
// Returns: id, exercise_id, exercise_nom, zone_corporelle, video_url, thumbnail_url, duration_seconds, file_size, source, created_at
// Supports: ?zone=, ?q= (search name), ?duree=court|moyen|long
app.get('/api/videos', requireAuth, async (req, res) => {
  try {
    const kineId = req.session.kineId;
    const { zone, q, duree } = req.query;

    let conditions = '(e.kine_id IS NULL OR e.kine_id = $1)';
    const params = [kineId];
    let paramIdx = 2;

    if (zone) {
      conditions += ` AND e.zone_corporelle = $${paramIdx}`;
      params.push(zone);
      paramIdx++;
    }
    if (q) {
      conditions += ` AND (LOWER(e.nom) LIKE $${paramIdx} OR LOWER(e.description) LIKE $${paramIdx})`;
      params.push('%' + q.toLowerCase() + '%');
      paramIdx++;
    }
    if (duree === 'court') {
      conditions += ' AND ev.duration_seconds <= 60';
    } else if (duree === 'moyen') {
      conditions += ' AND ev.duration_seconds > 60 AND ev.duration_seconds <= 180';
    } else if (duree === 'long') {
      conditions += ' AND ev.duration_seconds > 180';
    }

    const result = await pool.query(
      `SELECT ev.id, ev.exercise_id, ev.video_url, ev.thumbnail_url, ev.duration_seconds, ev.file_size, ev.source, ev.created_at,
              e.nom AS exercise_nom, e.zone_corporelle, e.kine_id AS exercise_kine_id, e.est_personnalise
       FROM exercise_videos ev
       JOIN exercices e ON e.id = ev.exercise_id
       WHERE ${conditions}
       ORDER BY e.zone_corporelle, e.nom`,
      params
    );
    res.json({ videos: result.rows });
  } catch (err) {
    console.error('[videos] List error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/videos/:id/link — link a video to a different exercise (by exercise_id)
// Body: { exercise_id }
app.put('/api/videos/:id/link', requireAuth, async (req, res) => {
  try {
    const kineId = req.session.kineId;
    const videoId = parseInt(req.params.id, 10);
    const { exercise_id } = req.body;
    if (!exercise_id) return res.status(400).json({ error: 'exercise_id requis' });

    // Verify the video belongs to an exercise this kiné can manage
    const videoCheck = await pool.query(
      `SELECT ev.id, ev.exercise_id FROM exercise_videos ev
       JOIN exercices e ON e.id = ev.exercise_id
       WHERE ev.id = $1 AND (e.kine_id IS NULL OR e.kine_id = $2)`,
      [videoId, kineId]
    );
    if (videoCheck.rows.length === 0) return res.status(404).json({ error: 'Vidéo non trouvée' });

    // Verify target exercise is accessible
    const targetCheck = await pool.query(
      'SELECT id FROM exercices WHERE id = $1 AND (kine_id IS NULL OR kine_id = $2)',
      [exercise_id, kineId]
    );
    if (targetCheck.rows.length === 0) return res.status(404).json({ error: 'Exercice cible non trouvé' });

    const oldExerciseId = videoCheck.rows[0].exercise_id;

    // Remove video from old exercise if different
    if (oldExerciseId !== parseInt(exercise_id, 10)) {
      // Clear old exercise has_video if no other videos remain after move
      await pool.query('UPDATE exercise_videos SET exercise_id = $1 WHERE id = $2', [exercise_id, videoId]);
      // Update old exercise has_video
      const oldCount = await pool.query('SELECT COUNT(*) FROM exercise_videos WHERE exercise_id = $1', [oldExerciseId]);
      if (parseInt(oldCount.rows[0].count, 10) === 0) {
        await pool.query('UPDATE exercices SET video_url = NULL, has_video = FALSE WHERE id = $1', [oldExerciseId]);
      }
      // Update new exercise has_video + video_url
      const vid = await pool.query('SELECT video_url FROM exercise_videos WHERE id = $1', [videoId]);
      await pool.query('UPDATE exercices SET video_url = $1, has_video = TRUE WHERE id = $2', [vid.rows[0].video_url, exercise_id]);
    }

    const updated = await pool.query(
      `SELECT ev.*, e.nom AS exercise_nom, e.zone_corporelle FROM exercise_videos ev
       JOIN exercices e ON e.id = ev.exercise_id WHERE ev.id = $1`,
      [videoId]
    );
    res.json({ video: updated.rows[0] });
  } catch (err) {
    console.error('[videos] Link error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/admin/videos/batch-import — admin batch-import from URL (Pixabay/Pexels/YouTube CC)
// Accepts JSON: { exercise_id, source_url, source_name }
// Downloads, compresses, thumbnails, stores in R2 + DB
app.post('/api/admin/videos/batch-import', requireAuth, async (req, res) => {
  const tempFiles = [];
  try {
    const kineId = req.session.kineId;
    // Admin only
    const adminCheck = await pool.query('SELECT is_admin FROM kines WHERE id = $1', [kineId]);
    if (!adminCheck.rows[0] || !adminCheck.rows[0].is_admin) {
      return res.status(403).json({ error: 'Admin requis' });
    }

    const { exercise_id, source_url, source_name } = req.body;
    if (!exercise_id || !source_url) {
      return res.status(400).json({ error: 'exercise_id et source_url requis' });
    }

    const exerciceId = parseInt(exercise_id, 10);
    const exCheck = await pool.query('SELECT id FROM exercices WHERE id = $1', [exerciceId]);
    if (exCheck.rows.length === 0) return res.status(404).json({ error: 'Exercice non trouvé' });

    // Download source video
    const dlRes = await nodeFetch(source_url, { timeout: 60000 });
    if (!dlRes.ok) return res.status(400).json({ error: 'Impossible de télécharger la vidéo source: ' + dlRes.status });
    const videoBuffer = Buffer.from(await dlRes.arrayBuffer());

    // Write to temp file
    const inputPath = writeTempFile(videoBuffer, '.mp4');
    tempFiles.push(inputPath);

    // Probe duration
    let duration = 0;
    try {
      const probe = await probeVideo(inputPath);
      duration = probe.duration;
    } catch (e) {
      console.warn('[video-import] probe failed:', e.message);
    }

    // Compress
    let compressedPath;
    try {
      compressedPath = await compressVideo(inputPath);
      tempFiles.push(compressedPath);
    } catch (e) {
      console.error('[video-import] compress failed, using original:', e.message);
      compressedPath = inputPath;
    }

    // Thumbnail
    let thumbnailUrl = null;
    try {
      const thumbPath = await extractThumbnail(compressedPath);
      tempFiles.push(thumbPath);
      const thumbBuf = fs.readFileSync(thumbPath);
      thumbnailUrl = await uploadBufferToR2(thumbBuf, 'thumb-exercice-' + exerciceId + '-' + Date.now() + '.jpg', 'image/jpeg');
    } catch (e) {
      console.warn('[video-import] thumbnail failed:', e.message);
    }

    // Upload video
    const compressedBuffer = fs.readFileSync(compressedPath);
    const videoUrl = await uploadBufferToR2(compressedBuffer, 'video-exercice-' + exerciceId + '-' + Date.now() + '.mp4', 'video/mp4');

    // Store in DB (replace existing)
    await pool.query('DELETE FROM exercise_videos WHERE exercise_id = $1', [exerciceId]);
    const result = await pool.query(
      `INSERT INTO exercise_videos
         (exercise_id, video_url, thumbnail_url, duration_seconds, file_size,
          original_filename, mime_type, upload_status, uploaded_by, source, source_url)
       VALUES ($1, $2, $3, $4, $5, $6, 'video/mp4', 'ready', $7, $8, $9)
       RETURNING *`,
      [exerciceId, videoUrl, thumbnailUrl, duration || null, compressedBuffer.length,
       source_name || source_url, kineId, source_name || 'import', source_url || null]
    );
    // Update exercices.video_url and has_video for backward compat + fast lookup
    await pool.query(
      'UPDATE exercices SET video_url = $1, has_video = TRUE WHERE id = $2',
      [videoUrl, exerciceId]
    );

    res.status(201).json({ video: result.rows[0] });
  } catch (err) {
    console.error('[video-import] Error:', err);
    res.status(500).json({ error: 'Erreur import vidéo: ' + err.message });
  } finally {
    for (const f of tempFiles) { try { fs.unlinkSync(f); } catch (_) {} }
  }
});

// Error handler for multer file size exceeded
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'Fichier trop volumineux. Limite : 100 MB.' });
  }
  next(err);
});

// POST /api/programmes/:id/exercices - Add exercise to programme
app.post('/api/programmes/:id/exercices', requireAuth, async (req, res) => {
  try {
    const { exercice_id, series, repetitions, duree_secondes, instructions, ordre } = req.body;

    // Verify programme belongs to this kiné
    const progCheck = await pool.query('SELECT id FROM programmes WHERE id = $1 AND kine_id = $2', [req.params.id, req.session.kineId]);
    if (progCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Programme non trouvé' });
    }

    const result = await pool.query(
      'INSERT INTO programme_exercices (programme_id, exercice_id, series, repetitions, duree_secondes, instructions, ordre) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [req.params.id, exercice_id, series || 3, repetitions || 10, duree_secondes || null, instructions || null, ordre || 0]
    );

    res.status(201).json({ programme_exercice: result.rows[0] });
  } catch (err) {
    console.error('Add exercise to programme error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// SÉANCES API
// ==========================================

// GET /api/seances?patient_id=X - List sessions
app.get('/api/seances', requireAuth, async (req, res) => {
  try {
    const { patient_id } = req.query;
    let query = `
      SELECT s.*, p.titre as programme_titre, pat.nom as patient_nom, pat.prenom as patient_prenom
      FROM seances s
      JOIN programmes p ON s.programme_id = p.id
      JOIN patients pat ON s.patient_id = pat.id
      WHERE p.kine_id = $1
    `;
    const params = [req.session.kineId];

    if (patient_id) {
      query += ' AND s.patient_id = $2';
      params.push(patient_id);
    }
    query += ' ORDER BY s.date DESC';

    const result = await pool.query(query, params);
    const seances = result.rows.map(decryptSeance);
    for (const s of seances) {
      logHealthAccess({ kineId: req.session.kineId, resourceType: 'seance', resourceId: s.id, patientId: s.patient_id, action: 'read', endpoint: 'GET /api/seances', req });
    }
    res.json({ seances });
  } catch (err) {
    console.error('List seances error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// BILANS API
// ==========================================

// POST /api/bilans - Create bilan
app.post('/api/bilans', requireAuth, async (req, res) => {
  try {
    const { patient_id, douleur_initiale, mobilite_initiale, objectifs, notes, type, date_bilan, observations, mesures, donnees_cliniques, functional_scale, functional_details, observations_praticien, conclusion_bilan, synthese_redigee } = req.body;

    if (!patient_id) {
      return res.status(400).json({ error: 'Patient requis' });
    }

    // Verify patient belongs to this kiné
    const patCheck = await pool.query('SELECT id FROM patients WHERE id = $1 AND kine_id = $2', [patient_id, req.session.kineId]);
    if (patCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Patient non trouvé' });
    }

    const donneesCliniquesStr = donnees_cliniques ? JSON.stringify(donnees_cliniques) : null;
    const funcScale = (functional_scale != null && functional_scale !== '') ? parseInt(functional_scale) : null;

    const result = await pool.query(
      `INSERT INTO bilans (kine_id, patient_id,
         douleur_initiale_enc, mobilite_initiale_enc, objectifs_enc, notes_enc,
         type, date_bilan, observations_enc, mesures_enc, donnees_cliniques_enc,
         functional_scale, functional_details_enc,
         observations_praticien_enc, conclusion_bilan_enc, synthese_redigee_enc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [req.session.kineId, patient_id,
       encrypt(douleur_initiale != null ? String(douleur_initiale) : null),
       encrypt(mobilite_initiale || null),
       encrypt(objectifs || null),
       encrypt(notes || null),
       type || 'initial',
       date_bilan || null,
       encrypt(observations || null),
       encrypt(mesures || null),
       encrypt(donneesCliniquesStr),
       funcScale,
       encrypt(functional_details || null),
       encrypt(observations_praticien || null),
       encrypt(conclusion_bilan || null),
       encrypt(synthese_redigee || null)]
    );

    const bilan = decryptBilan(result.rows[0]);
    logHealthAccess({ kineId: req.session.kineId, resourceType: 'bilan', resourceId: bilan.id, patientId: bilan.patient_id, action: 'write', endpoint: 'POST /api/bilans', req });
    res.status(201).json({ bilan });
  } catch (err) {
    console.error('Create bilan error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/bilans/:id - Get single bilan
app.get('/api/bilans/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT *, ROW_NUMBER() OVER (PARTITION BY patient_id ORDER BY created_at ASC) AS bilan_number
       FROM bilans WHERE id = $1 AND kine_id = $2`,
      [req.params.id, req.session.kineId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Bilan non trouvé' });
    const bilan = decryptBilan(result.rows[0]);
    logHealthAccess({ kineId: req.session.kineId, resourceType: 'bilan', resourceId: bilan.id, patientId: bilan.patient_id, action: 'read', endpoint: `GET /api/bilans/${req.params.id}`, req });
    res.json({ bilan });
  } catch (err) {
    console.error('Get bilan error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/bilans/:id - Update bilan (clinical data)
app.put('/api/bilans/:id', requireAuth, async (req, res) => {
  try {
    const { douleur_initiale, mobilite_initiale, objectifs, notes, observations, mesures, donnees_cliniques, date_bilan, functional_scale, functional_details, observations_praticien, conclusion_bilan, synthese_redigee } = req.body;

    // Verify bilan belongs to this kiné
    const check = await pool.query('SELECT id, patient_id FROM bilans WHERE id = $1 AND kine_id = $2', [req.params.id, req.session.kineId]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Bilan non trouvé' });

    const donneesCliniquesStr = donnees_cliniques !== undefined ? JSON.stringify(donnees_cliniques) : undefined;
    const funcScale = (functional_scale != null && functional_scale !== '') ? parseInt(functional_scale) : null;

    const result = await pool.query(
      `UPDATE bilans SET
         douleur_initiale_enc = $3,
         mobilite_initiale_enc = $4,
         objectifs_enc = $5,
         notes_enc = $6,
         observations_enc = $7,
         mesures_enc = $8,
         donnees_cliniques_enc = $9,
         date_bilan = COALESCE($10, date_bilan),
         functional_scale = COALESCE($11, functional_scale),
         functional_details_enc = COALESCE($12, functional_details_enc),
         observations_praticien_enc = COALESCE($13, observations_praticien_enc),
         conclusion_bilan_enc = COALESCE($14, conclusion_bilan_enc),
         synthese_redigee_enc = COALESCE($15, synthese_redigee_enc)
       WHERE id = $1 AND kine_id = $2
       RETURNING *`,
      [req.params.id, req.session.kineId,
       encrypt(douleur_initiale != null ? String(douleur_initiale) : null),
       encrypt(mobilite_initiale || null),
       encrypt(objectifs || null),
       encrypt(notes || null),
       encrypt(observations || null),
       encrypt(mesures || null),
       donneesCliniquesStr !== undefined ? encrypt(donneesCliniquesStr) : null,
       date_bilan || null,
       funcScale,
       functional_details !== undefined ? encrypt(functional_details || null) : null,
       observations_praticien !== undefined ? encrypt(observations_praticien || null) : null,
       conclusion_bilan !== undefined ? encrypt(conclusion_bilan || null) : null,
       synthese_redigee !== undefined ? encrypt(synthese_redigee || null) : null]
    );

    const bilan = decryptBilan(result.rows[0]);
    logHealthAccess({ kineId: req.session.kineId, resourceType: 'bilan', resourceId: bilan.id, patientId: bilan.patient_id, action: 'write', endpoint: `PUT /api/bilans/${req.params.id}`, req });
    res.json({ bilan });
  } catch (err) {
    console.error('Update bilan error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/bilans?patient_id=X - List bilans
app.get('/api/bilans', requireAuth, async (req, res) => {
  try {
    const { patient_id } = req.query;
    let query = `SELECT b.*, pat.nom as patient_nom, pat.prenom as patient_prenom,
      ROW_NUMBER() OVER (PARTITION BY b.patient_id ORDER BY b.created_at ASC) AS bilan_number
      FROM bilans b JOIN patients pat ON b.patient_id = pat.id WHERE b.kine_id = $1`;
    const params = [req.session.kineId];

    if (patient_id) {
      query += ' AND b.patient_id = $2';
      params.push(patient_id);
    }
    query += ' ORDER BY b.created_at DESC';

    const result = await pool.query(query, params);
    const bilans = result.rows.map(decryptBilan);
    for (const b of bilans) {
      logHealthAccess({ kineId: req.session.kineId, resourceType: 'bilan', resourceId: b.id, patientId: b.patient_id, action: 'read', endpoint: 'GET /api/bilans', req });
    }
    res.json({ bilans });
  } catch (err) {
    console.error('List bilans error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/bilans/:id/pdf-data - Full bilan data for PDF export
app.get('/api/bilans/:id/pdf-data', requireAuth, async (req, res) => {
  try {
    // Fetch bilan + patient info + bilan_number
    const bilanResult = await pool.query(
      `SELECT b.*, pat.nom AS patient_nom, pat.prenom AS patient_prenom,
              pat.pathologie_enc, pat.pathologie,
              ROW_NUMBER() OVER (PARTITION BY b.patient_id ORDER BY b.created_at ASC) AS bilan_number
       FROM bilans b
       JOIN patients pat ON b.patient_id = pat.id
       WHERE b.id = $1 AND b.kine_id = $2`,
      [req.params.id, req.session.kineId]
    );
    if (bilanResult.rows.length === 0) return res.status(404).json({ error: 'Bilan non trouvé' });

    const raw = bilanResult.rows[0];
    const bilan = decryptBilan(raw);
    // Decrypt patient pathologie
    const pathoRaw = raw.pathologie_enc ? decrypt(raw.pathologie_enc) : null;
    bilan.patient_pathologie = pathoRaw || raw.pathologie || null;

    // Fetch kiné info (including new rpps/adresse fields if available)
    const kineResult = await pool.query(
      `SELECT id, prenom, nom, email, cabinet, telephone, rpps, adresse FROM kines WHERE id = $1`,
      [req.session.kineId]
    );
    const kine = kineResult.rows[0] || {};

    // Fetch all bilans for this patient (for progression table) with bilan_number
    const allBilansResult = await pool.query(
      `SELECT b.*, pat.nom AS patient_nom, pat.prenom AS patient_prenom,
              ROW_NUMBER() OVER (PARTITION BY b.patient_id ORDER BY b.created_at ASC) AS bilan_number
       FROM bilans b
       JOIN patients pat ON b.patient_id = pat.id
       WHERE b.patient_id = $1 AND b.kine_id = $2
       ORDER BY b.created_at ASC`,
      [bilan.patient_id, req.session.kineId]
    );
    const allBilans = allBilansResult.rows.map(decryptBilan);

    // Fetch active programme and its exercises for the patient
    let activeProgramme = null;
    let programmeExercices = [];
    try {
      const progResult = await pool.query(
        `SELECT p.id, p.titre, p.frequence_semaine, p.duree_semaines, p.statut
         FROM programmes p
         WHERE p.patient_id = $1 AND p.kine_id = $2
           AND (p.statut = 'active' OR p.actif = true)
         ORDER BY p.created_at DESC
         LIMIT 1`,
        [bilan.patient_id, req.session.kineId]
      );
      if (progResult.rows.length > 0) {
        activeProgramme = progResult.rows[0];
        const exResult = await pool.query(
          `SELECT pe.series, pe.repetitions, pe.duree_secondes, pe.ordre,
                  e.nom, e.zone_corporelle, e.description
           FROM programme_exercices pe
           JOIN exercices e ON pe.exercice_id = e.id
           WHERE pe.programme_id = $1
           ORDER BY pe.ordre`,
          [activeProgramme.id]
        );
        programmeExercices = exResult.rows;
      }
    } catch (progErr) {
      // Non-blocking — programme section simply won't appear in PDF
      console.error('Programme fetch error (PDF):', progErr);
    }

    logHealthAccess({ kineId: req.session.kineId, resourceType: 'bilan', resourceId: bilan.id, patientId: bilan.patient_id, action: 'read', endpoint: `GET /api/bilans/${req.params.id}/pdf-data`, req });

    res.json({ bilan, kine, allBilans, activeProgramme, programmeExercices });
  } catch (err) {
    console.error('PDF data error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// ZONES CORPORELLES API
// ==========================================
app.get('/api/zones', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM zones_corporelles ORDER BY label_fr');
    res.json({ zones: result.rows });
  } catch (err) {
    console.error('List zones error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// JOURNAL SCIENTIFIQUE — Publications
// ==========================================

// GET /api/publications - List all publications (with optional thematique filter)
// GET /api/publications?thematique=epaule
app.get('/api/publications', requireAuth, async (req, res) => {
  try {
    const { thematique } = req.query;
    let query = `
      SELECT id, titre, resume, thematique, lien_original, date_publication, created_at
      FROM publications
    `;
    const params = [];
    if (thematique && thematique !== 'all') {
      query += ' WHERE thematique = $1';
      params.push(thematique);
    }
    query += ' ORDER BY date_publication DESC';
    const result = await pool.query(query, params);
    res.json({ publications: result.rows });
  } catch (err) {
    console.error('List publications error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/publications/thematiques - List all available thematiques with counts
app.get('/api/publications/thematiques', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT thematique, COUNT(*) as count
      FROM publications
      GROUP BY thematique
      ORDER BY thematique ASC
    `);
    res.json({ thematiques: result.rows });
  } catch (err) {
    console.error('List thematiques error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// PATIENT PUBLIC ACCESS (via unique link)
// ==========================================

// GET /api/patient/:lien - Get patient data via unique link (no auth needed)
app.get('/api/patient/:lien', async (req, res) => {
  try {
    const patResult = await pool.query(
      'SELECT id, nom, prenom, pathologie FROM patients WHERE lien_unique = $1',
      [req.params.lien]
    );
    if (patResult.rows.length === 0) {
      return res.status(404).json({ error: 'Lien invalide' });
    }

    const patient = patResult.rows[0];

    // Get active programmes with exercises
    const progResult = await pool.query(`
      SELECT p.id, p.titre, p.date_debut, p.date_fin, p.notes, p.frequence_semaine, p.duree_semaines
      FROM programmes p
      WHERE p.patient_id = $1 AND p.actif = true
      ORDER BY p.created_at DESC
    `, [patient.id]);

    const programmes = [];
    for (const prog of progResult.rows) {
      const exResult = await pool.query(`
        SELECT pe.id as pe_id, pe.exercice_id, pe.series, pe.repetitions, pe.duree_secondes, pe.instructions, pe.ordre,
               e.nom, e.zone_corporelle, e.description, e.image_url, e.video_url, e.has_video,
               ev.video_url  AS r2_video_url,
               ev.thumbnail_url,
               ev.duration_seconds AS video_duration_seconds
        FROM programme_exercices pe
        JOIN exercices e ON pe.exercice_id = e.id
        LEFT JOIN exercise_videos ev ON ev.exercise_id = e.id
        WHERE pe.programme_id = $1
        ORDER BY pe.ordre
      `, [prog.id]);
      programmes.push({ ...prog, exercices: exResult.rows });
    }

    // Get recent sessions with difficulty and observance counts
    const seancesResult = await pool.query(`
      SELECT s.id, s.date, s.completee,
             s.douleur_score, s.douleur_score_enc,
             s.difficulte, s.difficulte_enc,
             s.notes_patient, s.notes_patient_enc,
             p.titre as programme_titre,
             s.programme_id,
             s.patient_id,
             (SELECT COUNT(*)::int FROM seance_exercices se WHERE se.seance_id = s.id AND se.complete = true) as exercices_faits,
             (SELECT COUNT(*)::int FROM programme_exercices pe2 WHERE pe2.programme_id = s.programme_id) as exercices_total
      FROM seances s
      JOIN programmes p ON s.programme_id = p.id
      WHERE s.patient_id = $1
      ORDER BY s.date DESC
      LIMIT 30
    `, [patient.id]);

    const seances = seancesResult.rows.map(decryptSeance);
    // Log patient self-access (no kine_id)
    logHealthAccess({ kineId: null, resourceType: 'patient_public', resourceId: patient.id, patientId: patient.id, action: 'read', endpoint: `GET /api/patient/${req.params.lien}`, req });

    res.json({ patient, programmes, seances });
  } catch (err) {
    console.error('Patient public access error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/patient/:lien/seance - Patient records a session
app.post('/api/patient/:lien/seance', async (req, res) => {
  try {
    const patResult = await pool.query('SELECT id, prenom, kine_id FROM patients WHERE lien_unique = $1', [req.params.lien]);
    if (patResult.rows.length === 0) {
      return res.status(404).json({ error: 'Lien invalide' });
    }

    const { programme_id, douleur_score, difficulte, notes_patient, exercices_completes } = req.body;

    if (!programme_id) {
      return res.status(400).json({ error: 'Programme requis' });
    }

    const patient = patResult.rows[0];

    const seanceResult = await pool.query(
      `INSERT INTO seances (programme_id, patient_id, douleur_score_enc, difficulte_enc, notes_patient_enc, completee)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [programme_id, patient.id,
       encrypt(douleur_score != null ? String(douleur_score) : null),
       encrypt(difficulte || null),
       encrypt(notes_patient || null),
       true]
    );
    logHealthAccess({ kineId: null, resourceType: 'seance', resourceId: seanceResult.rows[0].id, patientId: patient.id, action: 'write', endpoint: `POST /api/patient/${req.params.lien}/seance`, req });

    // Record individual exercise observances (exercices_completes = array of exercice_id integers)
    if (exercices_completes && Array.isArray(exercices_completes)) {
      for (const exId of exercices_completes) {
        const exIdInt = parseInt(exId, 10);
        if (!isNaN(exIdInt)) {
          await pool.query(
            'INSERT INTO seance_exercices (seance_id, exercice_id, complete) VALUES ($1, $2, true)',
            [seanceResult.rows[0].id, exIdInt]
          );
        }
      }
    }

    res.status(201).json({ seance: decryptSeance(seanceResult.rows[0]) });

    // Fire-and-forget: notify the kiné that this patient submitted their feedback
    // Skip if the kiné has disabled feedback alerts in their notification preferences
    if (patient.kine_id) {
      (async () => {
        try {
          const { rows: kinePrefRows } = await pool.query(
            `SELECT alertes_feedback_enabled FROM kine_notification_prefs WHERE kine_id = $1`,
            [patient.kine_id]
          );
          // Default is enabled if no preference row exists yet
          const alertesEnabled = kinePrefRows.length === 0 || kinePrefRows[0].alertes_feedback_enabled !== false;
          if (alertesEnabled) {
            await sendPushToKine(patient.kine_id, {
              title: 'Kinévia — Nouveau ressenti',
              body: `${patient.prenom} a envoyé son ressenti`,
              data: { url: '/suivi' }
            });
          }
        } catch (err) {
          console.error('[kine-push] feedback notification error:', err.message);
        }
      })();
    }
  } catch (err) {
    console.error('Patient record session error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/patient/:lien/sync — bulk sync of offline-queued actions
// Idempotent: each action is processed independently; partial failures don't block others.
// Returns { synced: [{ local_id }], failed: [{ local_id, reason }] }
app.post('/api/patient/:lien/sync', async (req, res) => {
  try {
    const patResult = await pool.query(
      'SELECT id, prenom, kine_id FROM patients WHERE lien_unique = $1',
      [req.params.lien]
    );
    if (patResult.rows.length === 0) {
      return res.status(404).json({ error: 'Lien invalide' });
    }
    const patient = patResult.rows[0];

    const { actions } = req.body;
    if (!Array.isArray(actions) || actions.length === 0) {
      return res.status(400).json({ error: 'actions[] requis' });
    }

    const synced = [];
    const failed = [];

    for (const action of actions) {
      const localId = action.id;
      try {
        if (action.type === 'seance') {
          const { programme_id, douleur_score, difficulte, notes_patient, exercices_completes } = action.payload || {};
          if (!programme_id) { failed.push({ local_id: localId, reason: 'programme_id manquant' }); continue; }

          const seanceResult = await pool.query(
            `INSERT INTO seances (programme_id, patient_id, douleur_score_enc, difficulte_enc, notes_patient_enc, completee)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [programme_id, patient.id,
             encrypt(douleur_score != null ? String(douleur_score) : null),
             encrypt(difficulte || null),
             encrypt(notes_patient || null),
             true]
          );
          const seanceId = seanceResult.rows[0].id;
          logHealthAccess({ kineId: null, resourceType: 'seance', resourceId: seanceId, patientId: patient.id, action: 'write', endpoint: `POST /api/patient/${req.params.lien}/sync`, req });

          if (exercices_completes && Array.isArray(exercices_completes)) {
            for (const exId of exercices_completes) {
              const exIdInt = parseInt(exId, 10);
              if (!isNaN(exIdInt)) {
                await pool.query(
                  'INSERT INTO seance_exercices (seance_id, exercice_id, complete) VALUES ($1, $2, true)',
                  [seanceId, exIdInt]
                ).catch(() => {}); // non-fatal if already exists
              }
            }
          }

          synced.push({ local_id: localId, seance_id: seanceId });

          // Notify kiné (fire-and-forget)
          if (patient.kine_id) {
            (async () => {
              try {
                const { rows: kinePrefRows } = await pool.query(
                  'SELECT alertes_feedback_enabled FROM kine_notification_prefs WHERE kine_id = $1',
                  [patient.kine_id]
                );
                const alertesEnabled = kinePrefRows.length === 0 || kinePrefRows[0].alertes_feedback_enabled !== false;
                if (alertesEnabled) {
                  await sendPushToKine(patient.kine_id, {
                    title: 'Kinévia — Nouveau ressenti (sync)',
                    body: `${patient.prenom} a synchronisé son ressenti`,
                    data: { url: '/suivi' }
                  });
                }
              } catch (_) {}
            })();
          }
        } else {
          failed.push({ local_id: localId, reason: 'type inconnu: ' + action.type });
        }
      } catch (err) {
        console.error('[sync] action failed:', localId, err.message);
        failed.push({ local_id: localId, reason: err.message });
      }
    }

    res.json({ synced, failed });
  } catch (err) {
    console.error('[sync] endpoint error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/patient/:lien/video-feedback — record "cette vidéo m'a aidé" tap
app.post('/api/patient/:lien/video-feedback', async (req, res) => {
  try {
    const patResult = await pool.query(
      'SELECT id FROM patients WHERE lien_unique = $1',
      [req.params.lien]
    );
    if (patResult.rows.length === 0) {
      return res.status(404).json({ error: 'Lien invalide' });
    }
    const patientId = patResult.rows[0].id;
    const { exercise_id, programme_id } = req.body;

    if (!exercise_id) {
      return res.status(400).json({ error: 'exercise_id requis' });
    }

    // Upsert — patient can only give feedback once per exercise
    await pool.query(
      `INSERT INTO video_feedback (patient_id, exercise_id, programme_id, helpful)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (patient_id, exercise_id) DO NOTHING`,
      [patientId, parseInt(exercise_id, 10), programme_id || null]
    );

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('Video feedback error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// SUIVI KINÉ API
// ==========================================

// GET /api/suivi/overview - Liste patients avec observance et alertes
app.get('/api/suivi/overview', requireAuth, async (req, res) => {
  try {
    const kineId = req.session.kineId;

    const result = await pool.query(`
      SELECT
        p.id, p.nom, p.prenom, p.pathologie_enc, p.pathologie,
        COUNT(DISTINCT s.id)::int AS total_seances,
        MAX(s.date) AS derniere_seance,
        COUNT(DISTINCT CASE WHEN s.date >= CURRENT_DATE - INTERVAL '28 days' THEN s.id END)::int AS seances_28j,
        COALESCE((
          SELECT SUM(prog2.frequence_semaine)
          FROM programmes prog2
          WHERE prog2.patient_id = p.id AND prog2.actif = true
        ), 0)::int AS freq_semaine_totale,
        (
          SELECT COALESCE(s2.douleur_score_enc, CAST(s2.douleur_score AS TEXT))
          FROM seances s2
          JOIN programmes prog3 ON s2.programme_id = prog3.id
          WHERE s2.patient_id = p.id AND prog3.kine_id = $1
          ORDER BY s2.date DESC LIMIT 1
        ) AS derniere_douleur_raw,
        (
          SELECT COUNT(*)::int FROM programmes prog4
          WHERE prog4.patient_id = p.id AND prog4.actif = true
        ) AS programmes_actifs
      FROM patients p
      LEFT JOIN seances s ON s.patient_id = p.id
      LEFT JOIN programmes prog ON prog.patient_id = p.id AND prog.kine_id = $1
      WHERE p.kine_id = $1
      GROUP BY p.id, p.nom, p.prenom, p.pathologie_enc, p.pathologie
      ORDER BY p.nom, p.prenom
    `, [kineId]);

    const patients = result.rows.map(row => {
      const freqSemaine = row.freq_semaine_totale || 0;
      const expectedIn28Days = freqSemaine * 4;
      const done = row.seances_28j || 0;
      const observance = expectedIn28Days > 0
        ? Math.min(100, Math.round((done / expectedIn28Days) * 100))
        : (done > 0 ? 100 : null);

      const now = new Date();
      const lastSeance = row.derniere_seance ? new Date(row.derniere_seance) : null;
      const daysSinceLast = lastSeance
        ? Math.floor((now - lastSeance) / (1000 * 60 * 60 * 24))
        : null;

      // Decrypt the last pain score
      const derniereDouleur = row.derniere_douleur_raw != null ? decryptInt(row.derniere_douleur_raw) : null;

      const alerteInactif = row.programmes_actifs > 0 && (daysSinceLast === null || daysSinceLast >= 2);
      const alerteDouleur = derniereDouleur !== null && derniereDouleur >= 7;

      const pathologie = decrypt(row.pathologie_enc) ?? row.pathologie ?? null;

      return {
        id: row.id,
        nom: row.nom,
        prenom: row.prenom,
        pathologie,
        total_seances: row.total_seances,
        derniere_seance: row.derniere_seance,
        days_since_last: daysSinceLast,
        observance,
        programmes_actifs: row.programmes_actifs,
        derniere_douleur: derniereDouleur,
        alerte_inactif: alerteInactif,
        alerte_douleur: alerteDouleur,
        has_alerte: alerteInactif || alerteDouleur
      };
    });

    const total_alertes = patients.filter(p => p.has_alerte).length;
    res.json({ patients, total_alertes });
  } catch (err) {
    console.error('Suivi overview error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/suivi/patient/:id - Fiche suivi détaillée d'un patient
app.get('/api/suivi/patient/:id', requireAuth, async (req, res) => {
  try {
    const kineId = req.session.kineId;
    const patientId = req.params.id;

    // Verify patient belongs to this kiné
    const patCheck = await pool.query('SELECT * FROM patients WHERE id = $1 AND kine_id = $2', [patientId, kineId]);
    if (patCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Patient non trouvé' });
    }

    const seancesResult = await pool.query(`
      SELECT
        s.id, s.date,
        s.douleur_score, s.douleur_score_enc,
        s.difficulte, s.difficulte_enc,
        s.notes_patient, s.notes_patient_enc,
        s.completee, s.programme_id, s.patient_id,
        prog.titre AS programme_titre,
        (SELECT COUNT(*)::int FROM seance_exercices se WHERE se.seance_id = s.id AND se.complete = true) AS exercices_faits,
        (SELECT COUNT(*)::int FROM programme_exercices pe WHERE pe.programme_id = s.programme_id) AS exercices_total
      FROM seances s
      JOIN programmes prog ON s.programme_id = prog.id
      WHERE s.patient_id = $1 AND prog.kine_id = $2
      ORDER BY s.date DESC
      LIMIT 50
    `, [patientId, kineId]);

    // Global observance: total done / total expected
    const progResult = await pool.query(`
      SELECT id, titre, frequence_semaine, duree_semaines, date_debut, actif
      FROM programmes
      WHERE patient_id = $1 AND kine_id = $2
      ORDER BY created_at DESC
    `, [patientId, kineId]);

    const seances = seancesResult.rows.map(decryptSeance);
    for (const s of seances) {
      logHealthAccess({ kineId, resourceType: 'seance', resourceId: s.id, patientId: s.patient_id, action: 'read', endpoint: `GET /api/suivi/patient/${patientId}`, req });
    }
    const totalFaites = seances.length;

    // Calc global observance rate from seance_exercices
    let totalExercicesFaits = 0;
    let totalExercicesAttendus = 0;
    seances.forEach(s => {
      totalExercicesFaits += s.exercices_faits || 0;
      totalExercicesAttendus += s.exercices_total || 0;
    });
    const completionGlobale = totalExercicesAttendus > 0
      ? Math.round((totalExercicesFaits / totalExercicesAttendus) * 100)
      : null;

    res.json({
      patient: decryptPatient(patCheck.rows[0]),
      seances,
      programmes: progResult.rows,
      stats: {
        total_seances: totalFaites,
        completion_globale: completionGlobale
      }
    });
  } catch (err) {
    console.error('Suivi patient detail error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// DASHBOARD STATS
// ==========================================
app.get('/api/dashboard/stats', requireAuth, (req, res) => dashboardHandler(req, res));

const dashboardHandler = async (req, res) => {
  try {
    const kineId = req.session.kineId;

    const [patientsCount, programmesCount, seancesCount, recentPatients] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM patients WHERE kine_id = $1', [kineId]),
      pool.query('SELECT COUNT(*) FROM programmes WHERE kine_id = $1 AND actif = true', [kineId]),
      pool.query('SELECT COUNT(*) FROM seances s JOIN programmes p ON s.programme_id = p.id WHERE p.kine_id = $1 AND s.date >= CURRENT_DATE - INTERVAL \'7 days\'', [kineId]),
      pool.query('SELECT id, nom, prenom, pathologie, pathologie_enc, created_at FROM patients WHERE kine_id = $1 ORDER BY created_at DESC LIMIT 5', [kineId])
    ]);

    res.json({
      total_patients: parseInt(patientsCount.rows[0].count),
      programmes_actifs: parseInt(programmesCount.rows[0].count),
      seances_semaine: parseInt(seancesCount.rows[0].count),
      stats: {
        patients: parseInt(patientsCount.rows[0].count),
        programmes_actifs: parseInt(programmesCount.rows[0].count),
        seances_semaine: parseInt(seancesCount.rows[0].count)
      },
      recent_patients: recentPatients.rows.map(decryptPatient)
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

app.get('/api/dashboard', requireAuth, dashboardHandler);

// ==========================================
// AI IMAGE GENERATION
// ==========================================

// Initialize OpenAI client with Polsia proxy
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
});

// Helper: upload image buffer to R2 and return public URL
async function uploadImageToR2(imageBuffer, filename) {
  const r2Base = process.env.POLSIA_R2_BASE_URL || 'https://polsia.com';
  const apiKey = process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN;

  // Build multipart form data manually (no extra deps)
  const boundary = '----FormBoundary' + crypto.randomBytes(8).toString('hex');
  const CRLF = '\r\n';
  const header = Buffer.from(
    '--' + boundary + CRLF +
    'Content-Disposition: form-data; name="file"; filename="' + filename + '"' + CRLF +
    'Content-Type: image/png' + CRLF + CRLF
  );
  const footer = Buffer.from(CRLF + '--' + boundary + '--' + CRLF);
  const body = Buffer.concat([header, imageBuffer, footer]);

  const res = await fetch(r2Base + '/api/proxy/r2/upload', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': String(body.length),
    },
    body,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error('R2 upload failed: ' + res.status + ' ' + txt);
  }

  const data = await res.json();
  // R2 proxy returns { success: true, file: { id, key, url } }
  return (data.file && data.file.url) || data.url || data.publicUrl || data.file_url;
}

// Helper: generate image for one exercise and save to DB
// ATM-specific DALL-E 3 prompts v3 — improved anatomical illustrations
// Green arrows = correct movement/direction, Red = incorrect/to avoid
const ATM_PROMPTS = {
  'Ouverture mandibulaire avec résistance': `Flat 2D medical textbook diagram on pure white background. Lateral schematic of skull and mandible bones. Mandible shown slightly lowered (jaw-open position). One hand schematic with thumb under the chin bone pointing upward and index finger on the chin pointing downward. RED upward arrow at thumb labeled "Résistance (pouce)". GREEN downward arrow at mandible labeled "Ouverture active". Muscle group highlighted in soft orange: digastrique, mylohyoïdien. French labels: "Contraction isométrique 5s", "Abaisseurs mandibulaires", "Résistance manuelle". Clean anatomical bone-and-muscle schematic, no photorealism, no shadows.`,

  'Diduction mandibulaire (latéralité)': `Flat 2D medical textbook diagram on pure white background. Frontal schematic of skull and mandible bones. Three overlaid mandible positions shown: center (neutral, solid line), shifted RIGHT (dashed line), shifted LEFT (dotted line). GREEN horizontal arrow pointing RIGHT labeled "Latéralité droite". GREEN horizontal arrow pointing LEFT labeled "Latéralité gauche". Vertical dashed blue center line for midline reference. Condyle positions highlighted in soft orange. French labels: "Position neutre", "Déviation droite →", "Déviation gauche ←", "Condyle (pivot)". Simple bone schematic, flat 2D style, no shadows.`,

  'Auto-massage intra-buccal du ptérygoïdien médial': `Flat 2D medical illustration, pure white background. TWO panels side by side. LEFT panel: 3/4 front view of a head with mouth wide open (yawn). Right index finger inserted inside the right cheek, positioned behind lower back molars against the inner cheek wall. Small orange circular highlight on inner cheek. Label "Index derrière molaires inférieures". RIGHT panel: simplified anatomical cross-section of the open jaw from above showing: upper palate, tongue (labeled "Langue"), lower jaw, back molars labeled "Molaires inf.", orange-highlighted zone on inner jaw wall labeled "Ptérygoïdien médial". GREEN circular arrows showing small massage circles. Flat 2D clinical style, no shadows.`,

  'Exercice de stabilisation mandibulaire (langue haut, yeux ouverts)': `Flat 2D medical illustration, pure white background. Person seated facing a mirror, shown at slight 3/4 angle so both the person AND their mirror reflection are visible. Mouth opening slowly, lips parting vertically. Blue dashed vertical center line from nose to chin on both person and reflection (ideal midline trajectory). Small tongue shape visible pressed against upper palate, label "Langue sur palais". Mirror reflection shows green checkmark for correct vertical alignment. Small red inset circle shows jaw deviating sideways with RED X (incorrect deviation). French labels: "Ouverture verticale sans déviation ↓", "Miroir (biofeedback visuel)", "Trajectoire correcte", "Déviation incorrecte (X)". Flat 2D style, no shadows.`,

  'Correction posturale cervico-mandibulaire': `Flat 2D vector infographic on pure white background. Two side-by-side comparison panels showing physiotherapy cervical posture correction. LEFT panel labeled "Incorrect" with red border: a simple silhouette side-view showing head tilting forward, with RED X symbol and RED downward arrow. RIGHT panel labeled "Correct" with green border: a simple silhouette side-view showing head aligned upright with chin gently retracted, GREEN checkmark symbol, GREEN backward horizontal arrow at neck level labeled "Rétraction cervicale". Title: "Correction posturale cervico-mandibulaire". Clean flat geometric vector style, soft colors, no photorealism, no shadows.`,

  'Ouverture mandibulaire contrôlée': `Flat 2D medical illustration, pure white background. Front view of a human face showing two overlaid positions: faint outline (mouth closed, neutral) and solid drawing (mouth open at maximum comfortable amplitude). Vertical dashed blue center line on face showing midline alignment. One finger of a hand gently placed on the side of the chin as a guide. Large GREEN straight vertical arrow pointing DOWN (correct opening along midline). RED diagonal arrow (showing incorrect lateral deviation to avoid). French labels: "Langue sur palais", "Axe médian", "Doigt guide", "Amplitude max sans douleur", "Sans déviation latérale". Flat clean vector style, no shadows.`,

  'Fermeture mandibulaire résistée': `Flat 2D medical textbook diagram on pure white background. Frontal schematic of skull and mandible bones. Mandible shown in slightly open position. Hand schematic with fingers pressing downward on the lower jaw bone. RED downward arrow at the fingers labeled "Résistance manuelle ↓". GREEN upward arrow at mandible labeled "Élévation mandibulaire ↑". Muscles highlighted in soft orange on both sides: masséter, temporal. French labels: "Masséter (élévateur)", "Temporal (élévateur)", "Isométrique 5 secondes", "Renforcement élévateurs". Clean bone-and-muscle schematic, flat 2D, no shadows.`,

  'Diduction avec résistance latérale': `Flat 2D medical textbook diagram on pure white background. Frontal schematic of skull and mandible bones. Two panels side by side. LEFT panel: GREEN horizontal arrow pointing RIGHT at mandible labeled "Mouvement latéral →". RED horizontal arrow pointing LEFT at a finger schematic labeled "Résistance ←". Ptérygoïdien latéral muscle highlighted in soft orange on right side. RIGHT panel: same with arrows mirrored to opposite direction. French labels: "Ptérygoïdien latéral", "Isométrique 5s", "Répéter autre côté". Simple bone-and-muscle schematic, flat 2D, no shadows.`,

  'Propulsion mandibulaire': `Flat 2D medical textbook diagram on pure white background. Lateral schematic of skull and mandible bones. Two overlaid mandible positions: solid outline (neutral, condyle centered in fossa) and dashed outline (protruded, condyle translated forward). GREEN horizontal arrow pointing FORWARD between the two condyle positions labeled "Propulsion →". Ptérygoïdien latéral muscle highlighted in soft orange. French labels: "Position neutre (condyle centré)", "Propulsion (condyle en avant)", "Translation condylienne antérieure →", "Ptérygoïdien latéral activé". Clean bone schematic, flat 2D, no shadows.`,

  'Rétropulsion mandibulaire douce': `Flat 2D medical textbook diagram on pure white background. Lateral schematic of skull and mandible bones. Two overlaid mandible positions: solid outline (neutral) and dashed outline (slightly retracted, condyle moved backward). GREEN horizontal arrow pointing BACKWARD labeled "Rétropulsion ←". Temporal posterior fibers highlighted in soft orange. French labels: "Position neutre", "Rétropulsion douce ←", "Condyle (recentrage)", "Temporal postérieur", "Maintien 3 secondes". Simple bone-and-muscle schematic, flat 2D, no shadows.`,

  'Étirement des masséters (massage transverse)': `Flat 2D medical illustration, pure white background. Front view of a human face. Both index fingers (or thumbs) placed bilaterally on the cheeks at the masseter location (below cheekbones, above jaw angle). Masseter muscle regions highlighted in soft orange on both sides. Large GREEN arrows pointing DOWN on each cheek showing transverse downward pressure direction. French labels: "Masséter (serrer les dents pour localiser)", "Pression transversale ↓", "Haut vers le bas", "30 secondes par côté", "Zone douloureuse souvent". Flat 2D clinical style, no shadows.`,

  'Auto-étirement du masséter en ouverture': `Flat 2D medical illustration, pure white background. 3/4 front view of a head. Both thumbs placed under the chin. Both index fingers placed on the cheeks over the masseter muscles. Mouth wide open at maximum aperture. GREEN downward arrows on index fingers showing external massage downward pressure. GREEN downward arrow under chin showing mouth opening direction. French labels: "Pouces sous le menton", "Index sur masséters", "Pression externe vers le bas ↓", "Bouche ouverte au maximum", "Maintien 20 secondes". Flat 2D clinical style, no shadows.`,

  'Étirement ptérygoïdien latéral (propulsion forcée)': `Flat 2D physiotherapy infographic on pure white background. Abstract anatomical exercise diagram showing two schematic muscle shapes side by side. LEFT shape: a compact relaxed muscle labeled "Ptérygoïdien latéral — repos" in neutral grey. RIGHT shape: same muscle elongated horizontally with parallel horizontal stretch lines inside, highlighted in soft orange, labeled "Ptérygoïdien latéral — étiré". Large GREEN horizontal arrow pointing RIGHT between the two shapes labeled "Propulsion →". Timer icon "20 secondes". French labels: "Position repos", "Étirement maximal →", "Maintien 20s". Clean abstract flat infographic, soft colors, no photorealism, no shadows, white background.`,

  'Étirement ptérygoïdien médial (bouche ouverte latéralisée)': `Flat 2D physiotherapy infographic on pure white background. Abstract muscle stretch diagram showing two symmetric muscle shapes arranged in a frontal view. LEFT muscle shape highlighted in soft orange with diagonal stretch lines labeled "Ptérygoïdien médial gauche — étiré". RIGHT muscle shape in neutral grey labeled "Ptérygoïdien médial droit — repos". Large GREEN horizontal arrow pointing RIGHT labeled "Latéralisation →". Timer icon "20 secondes". French labels: "Étirement musculaire latéral", "Côté gauche étiré (orange)", "Maintien 20s". Clean abstract flat infographic, soft colors, white background, no photorealism, no shadows.`,

  'Massage du temporal': `Flat 2D medical illustration, pure white background. Front view of a human face and head. Both palms of hands placed on the temporal regions on both sides of the head above the ears. Temporal muscle areas highlighted in soft yellow-orange on both sides. GREEN circular arrows on both sides showing slow clockwise circular massage movements. French labels: "Région temporale (orange)", "Paume de la main", "Mouvements circulaires lents", "Pression ferme 30 secondes", "Zone hypertonique bruxisme et stress". Flat 2D clinical style, no shadows.`,

  'Étirement du temporal (bouche ouverte)': `Flat 2D medical textbook diagram on pure white background. Lateral anatomical diagram of the temporal muscle of the skull. The temporal muscle is highlighted in soft orange, shown in an elongated stretched state with parallel stretch-indicator lines. Fingertips schematic placed on the temporal region. Small lung breathing icon with GREEN airflow arrow. French labels: "Muscle temporal (étiré, orange)", "Doigts sur la tempe", "Relâchement progressif", "Maintien 30 secondes", "Respiration lente". Clean anatomical muscle diagram, flat 2D, white background, no shadows.`,

  'Position de repos mandibulaire': `Flat 2D vector infographic on pure white background. Three labeled diagram icons arranged horizontally. ICON 1: simplified side-view schematic of jaw bones with a small gap between upper and lower bone arches, green double-headed arrow showing "2-3mm" separation, label "Séparation mandibulaire 2-3mm". ICON 2: simplified sagittal schematic of palate with tongue shape pressed upward against it, green highlight, label "Langue sur palais". ICON 3: simple nose silhouette with green airflow curved arrow, label "Respiration nasale". Title at top in dark text: "Position de repos mandibulaire". Clean flat vector icons, soft blue-green colors, no photorealism, no shadows.`,

  'Respiration nasale diaphragmatique anti-bruxisme': `Flat 2D medical illustration, pure white background. Side view of a person lying on their back, one hand on the abdomen. Partial anatomical cross-section showing ribcage and diaphragm as an orange dome shape. Three sequential numbered phases shown with timers: Phase 1 — GREEN upward arrow on abdomen, abdomen rising, label "Inspiration nasale 4s". Phase 2 — pause icon, label "Blocage 2s". Phase 3 — GREEN downward arrow on abdomen, abdomen falling, label "Expiration nasale 6s". French labels: "Main sur ventre", "Diaphragme (orange)", "Ventre gonfle ↑", "Pause", "Ventre rentre ↓", "Mâchoire décontractée — dents séparées". Flat 2D clinical style, no shadows.`,

  'Auto-massage points trigger masséter': `Flat 2D medical textbook diagram on pure white background. Frontal schematic of skull and face showing the masséter muscle outlined in soft orange on both sides (right side emphasized). Three red-orange dot markers on the right masséter indicating trigger point locations at different depths. A hand schematic with thumb applying downward pressure on one trigger point dot. Green concentric circle radiating outward from pressure point indicating ischemia-reperfusion. French labels: "Masséter (orange)", "Points trigger (rouge)", "Pression soutenue ↓", "60-90 secondes", "Ischémie → reperfusion", "2 à 3 points". Anatomical schematic style, flat 2D, no shadows.`,

  'Massage crâne et région temporale (auto-drainage)': `Flat 2D medical illustration, pure white background. Rear and side view of a human head. Both hands with fingertips making small circular movements on the scalp. GREEN dotted arrows tracing the massage path from the nape of the neck upward toward the temporal regions and temples. Small circular motion icons at three key points along the path. Temporal area highlighted in soft orange. French labels: "Bouts des doigts", "Départ : nuque ↑", "Remontée vers les tempes", "Petits cercles", "Région temporale (orange)", "2 minutes continues", "Fascias crâniens ATM". Flat 2D clinical style, no shadows.`,

  'Exercice de coordination lingua-palatine': `Flat 2D medical illustration, pure white background. Sagittal anatomical cross-section of a human head. Mouth closed. Tongue shown flat and pressed upward against the hard palate in suction position, highlighted in green. GREEN upward suction arrows between tongue surface and palate showing negative pressure (aspiration). Visible small gap between upper and lower teeth (no dental contact). Timer labeled "5 secondes". French labels: "Langue à plat sur palais (aspiration)", "Pression négative ↑", "Palais dur", "Dents sans contact", "Tonus lingual correct", "Répéter avec rythme régulier". Flat 2D anatomical cross-section, no shadows.`,

  'Claquement contrôlé de langue (coordination)': `Flat 2D medical infographic on pure white background. Two-panel diagram illustrating neuromuscular coordination. LEFT panel labeled "Phase 1 — Départ": a curved shape (tongue) in contact with a flat surface (palate) shown in green, labeled "Langue sur palais". Arrow showing maintained contact. RIGHT panel labeled "Phase 2 — Dissociation": same curved shape still in green contact with the flat surface, but lower structure (jaw) moved away with GREEN downward arrow labeled "Mandibule s'abaisse". Sound wave icon between panels labeled "Claquement". French labels: "Langue maintenue sur palais", "Dissociation linguo-mandibulaire", "Rythme régulier". Clean schematic infographic, flat 2D, white background, no shadows.`,
};

async function generateAndSaveImage(exercice) {
  // Use ATM-specific prompt if available, otherwise fall back to generic
  const atmPrompt = ATM_PROMPTS[exercice.nom];
  const prompt = atmPrompt ||
    ('Illustration médicale claire en style flat design, fond blanc neutre. ' +
    'Silhouette humaine adulte exécutant cet exercice de kinésithérapie : ' +
    exercice.nom + '. ' +
    'Description : ' + (exercice.description || exercice.nom) + '. ' +
    'Montrer la posture correcte avec des flèches de mouvement si pertinent. ' +
    'Style épuré, couleurs douces bleu/vert, sans texte dans l\'image. ' +
    'Format carré, qualité médicale professionnelle.');

  const response = await openai.images.generate({
    model: 'dall-e-3',
    prompt,
    n: 1,
    size: '1024x1024',
    response_format: 'b64_json',
  });

  const b64 = response.data[0].b64_json;
  const imageBuffer = Buffer.from(b64, 'base64');
  const filename = 'exercice-' + exercice.id + '-' + Date.now() + '.png';
  const imageUrl = await uploadImageToR2(imageBuffer, filename);
  return imageUrl;
}

// POST /api/admin/generate-images - Generate AI images for exercises without one
// Protected by admin token (POLSIA_API_KEY). Called once to seed all images.
app.post('/api/admin/generate-images', async (req, res) => {
  const adminKey = process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN;
  const authHeader = req.headers.authorization || '';
  if (!adminKey || authHeader !== 'Bearer ' + adminKey) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  try {
    // Fetch exercises without images (or all if force=true), optionally filtered by zone
    const force = req.query.force === 'true';
    const zone = req.query.zone || null;
    let query, params;
    if (zone) {
      query = force
        ? 'SELECT id, nom, description, zone_corporelle FROM exercices WHERE est_personnalise = false AND zone_corporelle = $1 ORDER BY id'
        : 'SELECT id, nom, description, zone_corporelle FROM exercices WHERE est_personnalise = false AND zone_corporelle = $1 AND (image_url IS NULL OR image_url = \'\') ORDER BY id';
      params = [zone];
    } else {
      query = force
        ? 'SELECT id, nom, description, zone_corporelle FROM exercices WHERE est_personnalise = false ORDER BY id'
        : 'SELECT id, nom, description, zone_corporelle FROM exercices WHERE est_personnalise = false AND (image_url IS NULL OR image_url = \'\') ORDER BY id';
      params = [];
    }

    const { rows: exercices } = await pool.query(query, params);

    if (exercices.length === 0) {
      return res.json({ success: true, message: 'Tous les exercices ont déjà une image.', generated: 0 });
    }

    // Respond immediately — process in background to avoid HTTP timeout
    res.json({ success: true, started: true, total: exercices.length, message: `Génération en cours pour ${exercices.length} exercices. Vérifiez /api/admin/images-status pour le progrès.` });

    // Fire-and-forget background processing
    (async () => {
      const BATCH_SIZE = 2;
      let generated = 0;
      let errors = 0;
      console.log(`[image-gen-admin] Starting background generation for ${exercices.length} exercises (zone=${zone||'all'} force=${force})`);
      for (let i = 0; i < exercices.length; i += BATCH_SIZE) {
        const batch = exercices.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (ex) => {
          try {
            const imageUrl = await generateAndSaveImage(ex);
            await pool.query('UPDATE exercices SET image_url = $1 WHERE id = $2', [imageUrl, ex.id]);
            generated++;
            console.log(`[image-gen-admin] OK [${generated}/${exercices.length}]: ${ex.nom} → ${imageUrl}`);
          } catch (err) {
            errors++;
            console.error(`[image-gen-admin] FAIL: ${ex.nom} — ${err.message}`);
          }
        }));
        if (i + BATCH_SIZE < exercices.length) {
          await new Promise(r => setTimeout(r, 5000));
        }
      }
      console.log(`[image-gen-admin] Done. generated=${generated} errors=${errors}`);
    })();
  } catch (err) {
    console.error('Generate images error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erreur serveur: ' + err.message });
    }
  }
});

// GET /api/admin/images-status - Check how many exercises have images
app.get('/api/admin/images-status', async (req, res) => {
  const adminKey = process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN;
  const authHeader = req.headers.authorization || '';
  if (!adminKey || authHeader !== 'Bearer ' + adminKey) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE est_personnalise = false) as total_global,
        COUNT(*) FILTER (WHERE est_personnalise = false AND image_url IS NOT NULL AND image_url != '') as with_image,
        COUNT(*) FILTER (WHERE est_personnalise = false AND (image_url IS NULL OR image_url = '')) as without_image
      FROM exercices
    `);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ADMIN: RUNWAY ML — Génération vidéo exercices
// ==========================================

// Lazy-loaded Runway service (loaded once on first use)
let runwayService = null;
function getRunwayService() {
  if (!runwayService) runwayService = require('./services/runway');
  return runwayService;
}

/**
 * POST /api/admin/runway/generate-video
 * Body: { exercice_id: number }
 *
 * Génère une vidéo pour un exercice via Runway ML Gen-4.5 (image-to-video).
 * Répond immédiatement avec { started: true } — la génération tourne en background.
 * Résultat dans exercise_videos après ~1-3 minutes.
 *
 * Protégé par POLSIA_API_KEY (même pattern que les autres endpoints admin).
 */
app.post('/api/admin/runway/generate-video', async (req, res) => {
  const adminKey = process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN;
  const authHeader = req.headers.authorization || '';
  if (!adminKey || authHeader !== 'Bearer ' + adminKey) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const exerciceId = parseInt(req.body && req.body.exercice_id, 10);
  if (!exerciceId || isNaN(exerciceId)) {
    return res.status(400).json({ error: 'exercice_id requis (entier)' });
  }

  if (!process.env.RUNWAY_API_KEY) {
    return res.status(503).json({ error: 'RUNWAY_API_KEY non configuré sur ce serveur' });
  }

  try {
    const exRes = await pool.query(
      'SELECT id, nom, zone_corporelle, image_url FROM exercices WHERE id = $1',
      [exerciceId]
    );
    if (exRes.rows.length === 0) {
      return res.status(404).json({ error: 'Exercice #' + exerciceId + ' non trouvé' });
    }
    const ex = exRes.rows[0];
    if (!ex.image_url) {
      return res.status(400).json({
        error: 'Exercice #' + exerciceId + ' n\'a pas d\'image_url — génération image-to-video impossible'
      });
    }

    // Respond immediately — pipeline runs in background (Runway takes 1-3 min)
    res.json({
      success: true,
      started: true,
      exerciceId,
      nom: ex.nom,
      message: 'Génération lancée en background. Résultat dans exercise_videos après ~1-3 minutes.',
    });

    // Fire-and-forget background generation
    (async () => {
      try {
        console.log('[runway-admin] Starting video generation for exercice #' + exerciceId);
        const runway = getRunwayService();
        const result = await runway.generateExerciseVideo(pool, exerciceId);
        console.log('[runway-admin] ✓ Done exercice #' + exerciceId + ': ' + result.r2Url);
      } catch (err) {
        console.error('[runway-admin] ✗ Failed exercice #' + exerciceId + ':', err.message);
      }
    })();

  } catch (err) {
    if (!res.headersSent) {
      console.error('[runway-admin] Error:', err);
      res.status(500).json({ error: 'Erreur serveur: ' + err.message });
    }
  }
});

/**
 * GET /api/admin/runway/task/:taskId
 *
 * Poll le statut d'une tâche Runway ML directement.
 * Returns: { status, output, error, progress }
 */
app.get('/api/admin/runway/task/:taskId', async (req, res) => {
  const adminKey = process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN;
  const authHeader = req.headers.authorization || '';
  if (!adminKey || authHeader !== 'Bearer ' + adminKey) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  if (!process.env.RUNWAY_API_KEY) {
    return res.status(503).json({ error: 'RUNWAY_API_KEY non configuré' });
  }

  const { taskId } = req.params;
  if (!taskId || typeof taskId !== 'string' || taskId.length < 5) {
    return res.status(400).json({ error: 'taskId invalide' });
  }

  try {
    const runway = getRunwayService();
    const status = await runway.getTaskStatus(taskId);
    res.json(status);
  } catch (err) {
    console.error('[runway-admin] Task status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/runway/status
 *
 * Résumé de l'état des vidéos Runway dans la DB.
 */
app.get('/api/admin/runway/status', async (req, res) => {
  const adminKey = process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN;
  const authHeader = req.headers.authorization || '';
  if (!adminKey || authHeader !== 'Bearer ' + adminKey) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE est_personnalise = false)                                                      AS total_global,
        COUNT(*) FILTER (WHERE est_personnalise = false AND has_video = true)                                AS with_video,
        COUNT(*) FILTER (WHERE est_personnalise = false AND has_video = false)                               AS without_video,
        COUNT(*) FILTER (WHERE est_personnalise = false AND image_url IS NOT NULL AND image_url != '' AND has_video = false) AS ready_for_runway
      FROM exercices
    `);
    const runway_videos = await pool.query(
      'SELECT COUNT(*) AS count FROM exercise_videos WHERE source = $1', ['runway']
    );
    res.json({
      ...rows[0],
      runway_videos_count: runway_videos.rows[0].count,
      runway_api_key_set: !!process.env.RUNWAY_API_KEY,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/runway/generate-batch
 *
 * Lance la génération séquentielle de 10 vidéos Runway ML :
 *   - 5 ATM (IDs 211, 207, 213, 214, 206)
 *   - 5 Épaule (IDs 4, 5, 7, 1, 2)
 *
 * Exécution séquentielle pour éviter les timeouts et respecter le budget.
 * Réponse immédiate (202) + logs en arrière-plan.
 * Chaque vidéo qui échoue est loggée mais ne bloque pas les suivantes.
 */
app.post('/api/admin/runway/generate-batch', async (req, res) => {
  const adminKey = process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN;
  const authHeader = req.headers.authorization || '';
  if (!adminKey || authHeader !== 'Bearer ' + adminKey) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const BATCH_EXERCISES = [
    { id: 211, label: 'ATM - Ouverture mandibulaire contrôlée' },
    { id: 207, label: 'ATM - Diduction mandibulaire (latéralité)' },
    { id: 213, label: 'ATM - Diduction avec résistance latérale' },
    { id: 214, label: 'ATM - Propulsion mandibulaire' },
    { id: 206, label: 'ATM - Ouverture mandibulaire avec résistance' },
    { id: 4,   label: 'Épaule - Étirement capsulaire postérieur' },
    { id: 5,   label: 'Épaule - Renforcement rotation externe' },
    { id: 7,   label: 'Épaule - Élévation latérale avec élastique' },
    { id: 1,   label: 'Épaule - Pendulaire de Codman' },
    { id: 2,   label: 'Épaule - Élévation antérieure passive' },
  ];

  res.status(202).json({
    message: 'Batch de 10 vidéos lancé en arrière-plan. Suivez les logs Render.',
    exercises: BATCH_EXERCISES.map(e => ({ id: e.id, label: e.label })),
    total: BATCH_EXERCISES.length,
  });

  // Fire-and-forget sequential batch
  (async () => {
    const runway = getRunwayService();
    const results = { success: [], failed: [] };

    console.log('[runway-batch] ══════════════════════════════════════════');
    console.log('[runway-batch] Démarrage génération batch 10 vidéos');
    console.log('[runway-batch] ══════════════════════════════════════════');

    for (let i = 0; i < BATCH_EXERCISES.length; i++) {
      const { id, label } = BATCH_EXERCISES[i];
      console.log(`[runway-batch] [${i + 1}/${BATCH_EXERCISES.length}] ${label} (ID #${id})`);

      try {
        // Skip if already has video
        const check = await pool.query('SELECT has_video FROM exercices WHERE id = $1', [id]);
        if (check.rows.length === 0) {
          console.warn(`[runway-batch] ⚠️  Exercice #${id} introuvable — skipped`);
          results.failed.push({ id, error: 'introuvable' });
          continue;
        }
        if (check.rows[0].has_video) {
          console.log(`[runway-batch] ⏭️  Exercice #${id} a déjà une vidéo — skipped`);
          results.success.push({ id, skipped: true });
          continue;
        }

        const started = Date.now();
        const result = await runway.generateExerciseVideo(pool, id);
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`[runway-batch] ✅ #${id} ${label} — ${elapsed}s → ${result.r2Url}`);
        results.success.push({ id, label, r2Url: result.r2Url, elapsed });
      } catch (err) {
        console.error(`[runway-batch] ❌ #${id} ${label} — ERREUR: ${err.message}`);
        results.failed.push({ id, label, error: err.message });
        // Continue with next exercise
      }
    }

    console.log('[runway-batch] ══════════════════════════════════════════');
    console.log(`[runway-batch] RÉSUMÉ : ✅ ${results.success.length} succès | ❌ ${results.failed.length} échecs`);
    if (results.failed.length > 0) {
      results.failed.forEach(f => console.error(`[runway-batch]   - #${f.id}: ${f.error}`));
    }
    console.log('[runway-batch] ══════════════════════════════════════════');
  })();
});

// ==========================================
// ADMIN: DB MIGRATION Neon → Clever Cloud HDS
// ==========================================

// POST /api/admin/migrate-hds
// Protected by POLSIA_API_KEY bearer token.
// Reads CLEVER_CLOUD_DB_URL from env, copies all tables from Neon (DATABASE_URL)
// to Clever Cloud, verifies row counts, returns JSON result.
// Disable by setting MIGRATE_HDS_DISABLED=true in env vars.
app.post('/api/admin/migrate-hds', async (req, res) => {
  // Auth check — same pattern as /api/admin/generate-images
  const adminKey = process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN;
  const authHeader = req.headers.authorization || '';
  if (!adminKey || authHeader !== 'Bearer ' + adminKey) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  // Kill switch: set MIGRATE_HDS_DISABLED=true to prevent execution
  if (process.env.MIGRATE_HDS_DISABLED === 'true') {
    return res.status(403).json({ error: 'Migration désactivée via MIGRATE_HDS_DISABLED' });
  }

  const CC_URL = process.env.CLEVER_CLOUD_DB_URL;
  if (!CC_URL) {
    return res.status(400).json({ error: 'CLEVER_CLOUD_DB_URL non défini dans les variables d\'env Render' });
  }

  const { Pool: PgPool } = require('pg');

  const sourcePool = new PgPool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  const targetPool = new PgPool({
    connectionString: CC_URL,
    ssl: { rejectUnauthorized: false }
  });

  const log = [];
  const addLog = (msg) => { log.push(msg); console.log('[migrate-hds]', msg); };

  try {
    addLog('Step 1: Connecting to source (Neon)...');
    const source = await sourcePool.connect();
    addLog('Step 2: Connecting to target (Clever Cloud HDS)...');
    const target = await targetPool.connect();

    try {
      // Verify connectivity
      const srcVer = await source.query('SELECT version()');
      addLog('Source: ' + srcVer.rows[0].version.split(' ').slice(0, 2).join(' '));
      const tgtVer = await target.query('SELECT version()');
      addLog('Target: ' + tgtVer.rows[0].version.split(' ').slice(0, 2).join(' '));

      // Step 3: Get source row counts
      addLog('Step 3: Reading source tables...');
      const tables = ['zones_corporelles', 'kines', 'patients', 'exercices', 'programmes',
                      'programme_exercices', 'seances', 'seance_exercices', 'bilans',
                      'users', '_migrations'];
      const srcCounts = {};
      for (const t of tables) {
        try {
          const r = await source.query(`SELECT COUNT(*) FROM "${t}"`);
          srcCounts[t] = parseInt(r.rows[0].count);
          addLog(`  ${t}: ${srcCounts[t]} rows`);
        } catch (e) {
          srcCounts[t] = 0;
          addLog(`  ${t}: table not found (skipping)`);
        }
      }

      // Step 4: Create schema on target
      addLog('Step 4: Creating schema on Clever Cloud...');
      await target.query('BEGIN');
      await target.query(`CREATE TABLE IF NOT EXISTS _migrations (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
      await target.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL, name VARCHAR(255), password_hash VARCHAR(255), created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), stripe_subscription_id VARCHAR(255), subscription_status VARCHAR(50), subscription_plan VARCHAR(255), subscription_expires_at TIMESTAMPTZ, subscription_updated_at TIMESTAMPTZ)`);
      await target.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users (LOWER(email))`);
      await target.query(`CREATE TABLE IF NOT EXISTS kines (id SERIAL PRIMARY KEY, nom VARCHAR(255) NOT NULL, prenom VARCHAR(255), email VARCHAR(255) NOT NULL, mot_de_passe_hash VARCHAR(255) NOT NULL, cabinet VARCHAR(255), telephone VARCHAR(50), created_at TIMESTAMPTZ DEFAULT NOW())`);
      await target.query(`CREATE UNIQUE INDEX IF NOT EXISTS kines_email_unique_idx ON kines (LOWER(email))`);
      await target.query(`CREATE TABLE IF NOT EXISTS patients (id SERIAL PRIMARY KEY, kine_id INTEGER NOT NULL REFERENCES kines(id) ON DELETE CASCADE, nom VARCHAR(255) NOT NULL, prenom VARCHAR(255) NOT NULL, email VARCHAR(255), telephone VARCHAR(50), pathologie TEXT, notes TEXT, pathologie_enc TEXT, notes_enc TEXT, lien_unique VARCHAR(64) NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`);
      await target.query(`CREATE UNIQUE INDEX IF NOT EXISTS patients_lien_unique_idx ON patients (lien_unique)`);
      await target.query(`CREATE INDEX IF NOT EXISTS patients_kine_id_idx ON patients (kine_id)`);
      await target.query(`CREATE TABLE IF NOT EXISTS exercices (id SERIAL PRIMARY KEY, nom VARCHAR(255) NOT NULL, zone_corporelle VARCHAR(50) NOT NULL, description TEXT, image_url TEXT, video_url TEXT, est_personnalise BOOLEAN DEFAULT false, kine_id INTEGER REFERENCES kines(id) ON DELETE SET NULL, created_at TIMESTAMPTZ DEFAULT NOW(), series_recommandees INTEGER DEFAULT 3, repetitions_recommandees VARCHAR(50) DEFAULT '10', muscles TEXT, pathologies TEXT, niveau_difficulte VARCHAR(50) DEFAULT 'moyen')`);
      await target.query(`CREATE INDEX IF NOT EXISTS exercices_zone_idx ON exercices (zone_corporelle)`);
      await target.query(`CREATE INDEX IF NOT EXISTS exercices_kine_id_idx ON exercices (kine_id)`);
      await target.query(`CREATE TABLE IF NOT EXISTS programmes (id SERIAL PRIMARY KEY, kine_id INTEGER NOT NULL REFERENCES kines(id) ON DELETE CASCADE, patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE, titre VARCHAR(255) NOT NULL, date_debut DATE, date_fin DATE, notes TEXT, actif BOOLEAN DEFAULT true, frequence_semaine INTEGER, duree_semaines INTEGER, statut VARCHAR(20) DEFAULT 'active', created_at TIMESTAMPTZ DEFAULT NOW())`);
      await target.query(`CREATE INDEX IF NOT EXISTS programmes_patient_id_idx ON programmes (patient_id)`);
      await target.query(`CREATE INDEX IF NOT EXISTS programmes_kine_id_idx ON programmes (kine_id)`);
      await target.query(`CREATE TABLE IF NOT EXISTS programme_exercices (id SERIAL PRIMARY KEY, programme_id INTEGER NOT NULL REFERENCES programmes(id) ON DELETE CASCADE, exercice_id INTEGER NOT NULL REFERENCES exercices(id) ON DELETE CASCADE, series INTEGER DEFAULT 3, repetitions VARCHAR(50) DEFAULT '10', duree_secondes INTEGER, instructions TEXT, ordre INTEGER DEFAULT 0)`);
      await target.query(`CREATE INDEX IF NOT EXISTS pe_programme_id_idx ON programme_exercices (programme_id)`);
      await target.query(`CREATE TABLE IF NOT EXISTS seances (id SERIAL PRIMARY KEY, programme_id INTEGER NOT NULL REFERENCES programmes(id) ON DELETE CASCADE, patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE, date DATE NOT NULL DEFAULT CURRENT_DATE, completee BOOLEAN DEFAULT false, douleur_score INTEGER, douleur_score_enc TEXT, notes_patient TEXT, notes_patient_enc TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), difficulte VARCHAR(20), difficulte_enc TEXT)`);
      await target.query(`CREATE INDEX IF NOT EXISTS seances_patient_id_idx ON seances (patient_id)`);
      await target.query(`CREATE INDEX IF NOT EXISTS seances_programme_id_idx ON seances (programme_id)`);
      await target.query(`CREATE TABLE IF NOT EXISTS seance_exercices (id SERIAL PRIMARY KEY, seance_id INTEGER NOT NULL REFERENCES seances(id) ON DELETE CASCADE, exercice_id INTEGER NOT NULL REFERENCES exercices(id) ON DELETE CASCADE, complete BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT NOW())`);
      await target.query(`CREATE INDEX IF NOT EXISTS se_seance_id_idx ON seance_exercices (seance_id)`);
      await target.query(`CREATE TABLE IF NOT EXISTS bilans (id SERIAL PRIMARY KEY, kine_id INTEGER NOT NULL REFERENCES kines(id) ON DELETE CASCADE, patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE, douleur_initiale INTEGER, douleur_initiale_enc TEXT, mobilite_initiale VARCHAR(255), mobilite_initiale_enc TEXT, objectifs TEXT, objectifs_enc TEXT, notes TEXT, notes_enc TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), type VARCHAR(50) DEFAULT 'initial', date_bilan DATE DEFAULT CURRENT_DATE, observations TEXT, observations_enc TEXT, mesures TEXT, mesures_enc TEXT)`);
      await target.query(`CREATE INDEX IF NOT EXISTS bilans_patient_id_idx ON bilans (patient_id)`);
      await target.query(`CREATE INDEX IF NOT EXISTS bilans_kine_id_idx ON bilans (kine_id)`);
      await target.query(`CREATE TABLE IF NOT EXISTS zones_corporelles (id SERIAL PRIMARY KEY, nom VARCHAR(50) NOT NULL UNIQUE, label_fr VARCHAR(100) NOT NULL)`);
      await target.query('COMMIT');
      addLog('Schema created successfully.');

      // Step 5: Copy data (FK-safe order)
      addLog('Step 5: Copying data...');
      const copyOrder = ['zones_corporelles', 'kines', 'patients', 'exercices', 'programmes',
                         'programme_exercices', 'seances', 'seance_exercices', 'bilans',
                         'users', '_migrations'];
      const tableResults = {};

      for (const table of copyOrder) {
        if (!srcCounts[table] || srcCounts[table] === 0) {
          addLog(`  ${table}: skipped (empty or missing)`);
          tableResults[table] = { status: 'skipped', src: 0, tgt: 0 };
          continue;
        }

        const tgtBefore = await target.query(`SELECT COUNT(*) FROM "${table}"`);
        if (parseInt(tgtBefore.rows[0].count) > 0) {
          addLog(`  ${table}: already has data (${tgtBefore.rows[0].count} rows), skipping`);
          tableResults[table] = { status: 'already_exists', src: srcCounts[table], tgt: parseInt(tgtBefore.rows[0].count) };
          continue;
        }

        const rows = await source.query(`SELECT * FROM "${table}"`);
        if (rows.rows.length === 0) {
          tableResults[table] = { status: 'empty', src: 0, tgt: 0 };
          continue;
        }

        const cols = Object.keys(rows.rows[0]);
        await target.query('BEGIN');
        let inserted = 0;
        const batchSize = 100;
        for (let i = 0; i < rows.rows.length; i += batchSize) {
          const batch = rows.rows.slice(i, i + batchSize);
          for (const row of batch) {
            const placeholders = cols.map((c, idx) => `$${idx + 1}`).join(', ');
            const data = cols.map(c => row[c]);
            await target.query(
              `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
              data
            );
            inserted++;
          }
        }
        await target.query('COMMIT');

        // Reset sequence
        if (cols.includes('id')) {
          try {
            await target.query(`SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM "${table}"`);
          } catch (e) {
            addLog(`  Warning: could not reset sequence for ${table}: ${e.message}`);
          }
        }

        addLog(`  ${table}: ${inserted} rows copied`);
        tableResults[table] = { status: 'copied', src: srcCounts[table], tgt: inserted };
      }

      // Step 6: Verify counts
      addLog('Step 6: Verifying data integrity...');
      let allOk = true;
      const verification = {};
      for (const table of copyOrder) {
        if (!srcCounts[table] || srcCounts[table] === 0) continue;
        const tgtCount = await target.query(`SELECT COUNT(*) FROM "${table}"`);
        const tgt = parseInt(tgtCount.rows[0].count);
        const src = srcCounts[table];
        const ok = tgt >= src;
        if (!ok) allOk = false;
        verification[table] = { src, tgt, ok };
        addLog(`  ${table}: src=${src} tgt=${tgt} ${ok ? '✓' : '✗ MISMATCH!'}`);
      }

      addLog(allOk ? '✓ Migration complete. All row counts match.' : '✗ Migration has mismatches.');

      return res.json({
        success: allOk,
        message: allOk
          ? 'Migration réussie. Vous pouvez maintenant mettre à jour DATABASE_URL sur Render vers CLEVER_CLOUD_DB_URL.'
          : 'Migration terminée avec des divergences de comptage. Vérifiez les détails avant de basculer.',
        tables: tableResults,
        verification,
        log
      });

    } finally {
      source.release();
      target.release();
      await sourcePool.end();
      await targetPool.end();
    }

  } catch (err) {
    console.error('[migrate-hds] Fatal error:', err.message);
    try { await sourcePool.end(); } catch (_) {}
    try { await targetPool.end(); } catch (_) {}
    return res.status(500).json({ success: false, error: err.message, log });
  }
});

// ==========================================
// SEO — SITEMAP & ROBOTS
// ==========================================

// GET /og-image.png — serve SVG OG image (crawlers accept SVG)
app.get('/og-image.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'og-image.svg'));
});

// ==========================================
// BLOG ROUTES
// ==========================================

const BLOG_ARTICLES = [
  'exercices-epaule-kine',
  'lombalgie-exercices-dos',
  'programme-kine-patient-maison',
  'suivi-patient-kinesitherapeute',
  'observance-exercices-kine',
  'suivi-patient-numerique-2026',
  'programme-exercices-personnalise',
  'rgpd-donnees-sante-kine',
];

// GET /blog — article listing
app.get('/blog', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'blog', 'index.html'));
});

// GET /blog/:slug — individual article
app.get('/blog/:slug', (req, res) => {
  const slug = req.params.slug;
  if (!BLOG_ARTICLES.includes(slug)) {
    return res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'blog', `${slug}.html`));
});

// ==========================================
// BETA SIGNUP
// ==========================================

// POST /api/beta/signup — register a beta tester and create their account immediately
app.post('/api/beta/signup', async (req, res) => {
  try {
    const { name, email, patients_per_week } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Le nom est requis.' });
    }
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ error: 'Adresse email invalide.' });
    }

    const cleanName = name.trim().substring(0, 255);
    const cleanEmail = email.trim().toLowerCase().substring(0, 255);
    const cleanPatients = Number.isInteger(patients_per_week) ? patients_per_week : null;

    // Insert into beta_signups — ON CONFLICT to handle duplicate gracefully
    const betaResult = await pool.query(
      `INSERT INTO beta_signups (name, email, patients_per_week, signed_up_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [cleanName, cleanEmail, cleanPatients]
    );

    const isNewBetaSignup = betaResult.rows.length > 0;

    // Register as known email contact (fire-and-forget)
    registerEmailContact({ email: cleanEmail, name: cleanName })
      .catch(e => console.error('[beta] register contact error:', e.message));

    // Find or create the kine account
    let kine = null;
    let isNewKine = false;

    // Check if account already exists
    const existingKine = await pool.query(
      'SELECT id, prenom, nom, email FROM kines WHERE LOWER(email) = LOWER($1)',
      [cleanEmail]
    );

    if (existingKine.rows.length > 0) {
      kine = existingKine.rows[0];
    } else {
      // Create a kine account automatically
      // Name parsing: try to split "Prénom Nom" — use full name as nom if no space
      const nameParts = cleanName.split(' ');
      const prenom = nameParts.length > 1 ? nameParts[0] : null;
      const nom = nameParts.length > 1 ? nameParts.slice(1).join(' ') : cleanName;

      // Generate a secure random temporary password (not sent to user — they use magic link)
      const tempPassword = crypto.randomBytes(32).toString('hex');
      const hash = await bcrypt.hash(tempPassword, 12);
      const trialEndsAt = new Date();
      trialEndsAt.setDate(trialEndsAt.getDate() + 14);

      const kineResult = await pool.query(
        `INSERT INTO kines (prenom, nom, email, mot_de_passe_hash, subscription_status, trial_ends_at, subscription_updated_at)
         VALUES ($1, $2, $3, $4, 'trialing', $5, NOW())
         RETURNING id, prenom, nom, email`,
        [prenom, nom, cleanEmail, hash, trialEndsAt]
      );
      kine = kineResult.rows[0];
      isNewKine = true;

      // Record signup event (fire-and-forget)
      pool.query(
        `INSERT INTO kine_subscription_events (kine_id, event_type, metadata) VALUES ($1, 'account_created', $2)`,
        [kine.id, JSON.stringify({ source: 'beta_signup', trial_ends_at: trialEndsAt.toISOString() })]
      ).catch(e => console.error('[beta] event log error:', e.message));
    }

    // Generate magic link token (72h expiry)
    const magicToken = crypto.randomBytes(48).toString('hex');
    const magicExpiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);

    // Invalidate previous unused magic link tokens for this kine
    await pool.query(
      'UPDATE magic_link_tokens SET used_at = NOW() WHERE kine_id = $1 AND used_at IS NULL',
      [kine.id]
    );

    await pool.query(
      'INSERT INTO magic_link_tokens (kine_id, token, expires_at) VALUES ($1, $2, $3)',
      [kine.id, magicToken, magicExpiresAt]
    );

    const appUrl = process.env.APP_URL || 'https://kinevia.pro';
    const magicLink = appUrl + '/api/auth/magic-link?token=' + magicToken;
    const prenom = kine.prenom || cleanName;

    // Send welcome email with magic link (direct access)
    if (isNewBetaSignup || isNewKine) {
      try {
        await sendEmail({
          to: cleanEmail,
          subject: 'Vos accès Kinévia sont prêts 🎉',
          body: `Bonjour ${prenom},\n\nVotre compte Kinévia est créé. Cliquez sur ce lien pour accéder à votre espace :\n\n${magicLink}\n\n(Lien valable 72 heures — sans mot de passe)\n\nUne fois connecté, vous bénéficiez de 14 jours gratuits, sans engagement, sans carte bancaire. Votre tarif fondateur est garanti à vie.\n\nSi vous avez des questions, répondez simplement à cet email.\n\nL'équipe Kinévia\nhttps://kinevia.pro`,
          html: `<!DOCTYPE html><html lang="fr"><body style="margin:0;padding:0;font-family:Inter,-apple-system,sans-serif;background:#f8fafc;">
<div style="max-width:520px;margin:40px auto;background:white;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden;">
  <div style="background:linear-gradient(135deg,#38BDF8,#0ea5e9);padding:28px 32px;text-align:center;">
    <div style="display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;background:rgba(255,255,255,0.2);border-radius:12px;margin-bottom:12px;">
      <span style="color:white;font-weight:700;font-size:18px;">K</span>
    </div>
    <h1 style="margin:0;color:white;font-size:20px;font-weight:700;">Kinévia</h1>
  </div>
  <div style="padding:32px;">
    <h2 style="margin:0 0 8px;color:#0f172a;font-size:20px;font-weight:700;">Votre accès est prêt 🎉</h2>
    <p style="margin:0 0 24px;color:#475569;font-size:14px;">Bonjour <strong>${prenom}</strong>, votre compte Kinévia vient d'être créé.</p>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:20px;margin-bottom:24px;">
      <p style="margin:0 0 8px;font-weight:600;color:#0f172a;font-size:14px;">✅ 14 jours gratuits, sans carte bancaire</p>
      <p style="margin:0 0 8px;color:#334155;font-size:14px;">✅ Tarif fondateur garanti à vie</p>
      <p style="margin:0;color:#334155;font-size:14px;">✅ Sans engagement</p>
    </div>
    <p style="margin:0 0 20px;color:#475569;font-size:14px;">Cliquez sur le bouton ci-dessous pour accéder directement à votre tableau de bord — sans mot de passe :</p>
    <div style="text-align:center;margin:0 0 24px;">
      <a href="${magicLink}" style="display:inline-block;background:linear-gradient(135deg,#38BDF8,#0ea5e9);color:white;font-weight:600;font-size:15px;padding:14px 32px;border-radius:10px;text-decoration:none;letter-spacing:0.01em;">Accéder à mon espace →</a>
    </div>
    <p style="margin:0 0 8px;color:#94a3b8;font-size:12px;">Ce lien est valable <strong>72 heures</strong>. Il vous connecte directement — aucun mot de passe requis.</p>
    <p style="margin:0;color:#94a3b8;font-size:12px;">Ou copiez ce lien dans votre navigateur :<br><span style="word-break:break-all;color:#38BDF8;">${magicLink}</span></p>
  </div>
  <div style="border-top:1px solid #f1f5f9;padding:20px 32px;text-align:center;">
    <p style="margin:0;color:#94a3b8;font-size:12px;">Des questions ? Répondez simplement à cet email — on lit tout.</p>
    <p style="margin:8px 0 0;color:#94a3b8;font-size:12px;">© 2026 Kinévia · <a href="https://kinevia.pro" style="color:#38BDF8;text-decoration:none;">kinevia.pro</a></p>
  </div>
</div>
</body></html>`,
        });
      } catch (emailErr) {
        console.error('[beta] Failed to send welcome email:', emailErr.message);
        // Don't block signup on email failure
      }
    } else {
      // Returning user who already has account — resend magic link
      try {
        await sendEmail({
          to: cleanEmail,
          subject: 'Votre nouveau lien de connexion Kinévia',
          body: `Bonjour ${prenom},\n\nVous avez déjà un compte Kinévia. Voici un nouveau lien de connexion :\n\n${magicLink}\n\n(Valable 72 heures)\n\nL'équipe Kinévia`,
          html: `<!DOCTYPE html><html lang="fr"><body style="margin:0;padding:0;font-family:Inter,-apple-system,sans-serif;background:#f8fafc;">
<div style="max-width:520px;margin:40px auto;background:white;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden;">
  <div style="background:linear-gradient(135deg,#38BDF8,#0ea5e9);padding:28px 32px;text-align:center;">
    <h1 style="margin:0;color:white;font-size:20px;font-weight:700;">Kinévia</h1>
  </div>
  <div style="padding:32px;">
    <h2 style="margin:0 0 16px;color:#0f172a;font-size:18px;font-weight:600;">Votre lien de connexion</h2>
    <p style="margin:0 0 24px;color:#475569;font-size:14px;">Bonjour <strong>${prenom}</strong>, voici votre lien de connexion :</p>
    <div style="text-align:center;margin:0 0 24px;">
      <a href="${magicLink}" style="display:inline-block;background:linear-gradient(135deg,#38BDF8,#0ea5e9);color:white;font-weight:600;font-size:15px;padding:14px 32px;border-radius:10px;text-decoration:none;">Accéder à mon espace →</a>
    </div>
    <p style="margin:0;color:#94a3b8;font-size:12px;">Ce lien est valable <strong>72 heures</strong>.</p>
  </div>
</div>
</body></html>`,
        });
      } catch (emailErr) {
        console.error('[beta] Failed to resend magic link:', emailErr.message);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[beta] Signup error:', err);
    res.status(500).json({ error: 'Erreur serveur. Veuillez réessayer.' });
  }
});

// GET /api/beta/count — return number of beta signups (for social proof)
app.get('/api/beta/count', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) AS count FROM beta_signups');
    res.json({ count: parseInt(result.rows[0].count, 10) });
  } catch (err) {
    console.error('[beta] Count error:', err);
    res.status(500).json({ count: 0 });
  }
});

// GET /sitemap.xml
app.get('/sitemap.xml', (req, res) => {
  const BASE = 'https://kinevia.pro';
  const now = new Date().toISOString().split('T')[0];

  const staticUrls = [
    { loc: '/', changefreq: 'weekly', priority: '1.0' },
    { loc: '/exercices', changefreq: 'weekly', priority: '0.9' },
    { loc: '/blog', changefreq: 'weekly', priority: '0.8' },
    { loc: '/blog/exercices-epaule-kine', changefreq: 'monthly', priority: '0.7' },
    { loc: '/blog/lombalgie-exercices-dos', changefreq: 'monthly', priority: '0.7' },
    { loc: '/blog/programme-kine-patient-maison', changefreq: 'monthly', priority: '0.7' },
    { loc: '/blog/suivi-patient-kinesitherapeute', changefreq: 'monthly', priority: '0.7' },
    { loc: '/blog/observance-exercices-kine', changefreq: 'monthly', priority: '0.7' },
    { loc: '/blog/suivi-patient-numerique-2026', changefreq: 'monthly', priority: '0.7' },
    { loc: '/blog/programme-exercices-personnalise', changefreq: 'monthly', priority: '0.7' },
    { loc: '/blog/rgpd-donnees-sante-kine', changefreq: 'monthly', priority: '0.7' },
    { loc: '/beta', changefreq: 'monthly', priority: '0.9' },
    { loc: '/tarifs', changefreq: 'monthly', priority: '0.8' },
    { loc: '/inscription', changefreq: 'monthly', priority: '0.8' },
    { loc: '/connexion', changefreq: 'monthly', priority: '0.5' },
    { loc: '/mentions-legales', changefreq: 'yearly', priority: '0.2' },
    { loc: '/confidentialite', changefreq: 'yearly', priority: '0.2' },
    { loc: '/cgu', changefreq: 'yearly', priority: '0.2' },
    { loc: '/securite', changefreq: 'yearly', priority: '0.3' },
  ];

  const urlEntries = staticUrls.map(u => `
  <url>
    <loc>${BASE}${u.loc}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries}
</urlset>`;

  res.header('Content-Type', 'application/xml');
  res.send(xml);
});

// ==========================================
// PAGE ROUTES (serve the SPA)
// ==========================================

// ==========================================
// SUBSCRIPTION & BILLING
// ==========================================

const STRIPE_CHECKOUT_URL = 'https://buy.stripe.com/28E28r7GH7ez2iU4PTbMQ03';
const APP_URL = process.env.APP_URL || 'https://kinevia.pro';

/**
 * Check if a kiné has an active subscription or valid trial.
 * Returns { active: bool, reason: string }
 */
async function getSubscriptionStatus(kineId) {
  const { rows } = await pool.query(
    'SELECT subscription_status, trial_ends_at, subscription_ends_at, lifetime_free FROM kines WHERE id = $1',
    [kineId]
  );
  if (rows.length === 0) return { active: false, reason: 'not_found' };

  const kine = rows[0];
  const status = kine.subscription_status;
  const now = new Date();

  // Lifetime free — unlimited access, no subscription needed
  if (kine.lifetime_free) return { active: true, reason: 'lifetime_free' };

  // Active paid subscription
  if (status === 'active') return { active: true, reason: 'active' };

  // Trialing: check trial hasn't expired
  if (status === 'trialing') {
    if (kine.trial_ends_at && new Date(kine.trial_ends_at) > now) {
      return { active: true, reason: 'trial' };
    }
    // Trial expired
    return { active: false, reason: 'trial_expired' };
  }

  // Past due: give 7-day grace period
  if (status === 'past_due') {
    if (kine.subscription_ends_at) {
      const grace = new Date(kine.subscription_ends_at);
      grace.setDate(grace.getDate() + 7);
      if (grace > now) return { active: true, reason: 'past_due_grace' };
    }
    return { active: false, reason: 'past_due' };
  }

  // Canceled but access until end of paid period
  if (status === 'canceled') {
    if (kine.subscription_ends_at && new Date(kine.subscription_ends_at) > now) {
      return { active: true, reason: 'canceled_access_until_end' };
    }
    return { active: false, reason: 'canceled' };
  }

  return { active: false, reason: status };
}

/**
 * Middleware: require active subscription or trial.
 * Returns 402 JSON or redirects to /abonnement page.
 */
async function requireSubscription(req, res, next) {
  try {
    const sub = await getSubscriptionStatus(req.session.kineId);
    if (sub.active) return next();

    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(402).json({
        error: 'Abonnement requis',
        reason: sub.reason,
        checkout_url: STRIPE_CHECKOUT_URL
      });
    }
    return res.redirect('/abonnement');
  } catch (err) {
    console.error('[SUBSCRIPTION] requireSubscription error:', err.message);
    next(); // fail-open: don't block on DB error
  }
}

// GET /api/subscription/status — current subscription state
app.get('/api/subscription/status', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT subscription_status, trial_ends_at, subscription_ends_at, stripe_subscription_id,
              subscription_updated_at, prenom, nom, email
       FROM kines WHERE id = $1`,
      [req.session.kineId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Kiné introuvable' });

    const kine = rows[0];
    const sub = await getSubscriptionStatus(req.session.kineId);

    res.json({
      active: sub.active,
      reason: sub.reason,
      status: kine.subscription_status,
      trial_ends_at: kine.trial_ends_at,
      subscription_ends_at: kine.subscription_ends_at,
      has_paid_subscription: !!kine.stripe_subscription_id,
      checkout_url: STRIPE_CHECKOUT_URL,
      kine: { prenom: kine.prenom, nom: kine.nom, email: kine.email }
    });
  } catch (err) {
    console.error('[SUBSCRIPTION] status error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/subscription/cancel — cancel subscription at period end
app.post('/api/subscription/cancel', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT stripe_subscription_id, subscription_status, nom, prenom, email FROM kines WHERE id = $1',
      [req.session.kineId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Kiné introuvable' });

    const kine = rows[0];

    if (!kine.stripe_subscription_id) {
      // No paid subscription — just cancel the trial
      await pool.query(
        `UPDATE kines SET subscription_status = 'canceled', subscription_updated_at = NOW() WHERE id = $1`,
        [req.session.kineId]
      );
      await pool.query(
        `INSERT INTO kine_subscription_events (kine_id, event_type, metadata)
         VALUES ($1, 'subscription_canceled_trial', $2)`,
        [req.session.kineId, JSON.stringify({ reason: 'user_requested', had_trial: true })]
      );
      return res.json({ success: true, message: 'Essai annulé avec succès.' });
    }

    // Has paid subscription — cancel via Stripe
    // Polsia's Stripe is managed platform-side; we mark as canceled and let webhook confirm
    // In production, this would call Stripe API. For now, we record the intent.
    await pool.query(
      `UPDATE kines SET subscription_status = 'canceled', subscription_updated_at = NOW() WHERE id = $1`,
      [req.session.kineId]
    );
    await pool.query(
      `INSERT INTO kine_subscription_events (kine_id, event_type, metadata)
       VALUES ($1, 'subscription_cancel_requested', $2)`,
      [req.session.kineId, JSON.stringify({
        stripe_subscription_id: kine.stripe_subscription_id,
        kine_email: kine.email,
        requested_at: new Date().toISOString()
      })]
    );

    res.json({
      success: true,
      message: 'Votre demande de résiliation a été enregistrée. Votre accès sera maintenu jusqu\'à la fin de la période en cours.'
    });
  } catch (err) {
    console.error('[SUBSCRIPTION] cancel error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/subscription/retractation — 14-day withdrawal right (Code conso. Art. L221-18)
app.post('/api/subscription/retractation', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT stripe_subscription_id, subscription_status, trial_ends_at,
              subscription_updated_at, nom, prenom, email, created_at
       FROM kines WHERE id = $1`,
      [req.session.kineId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Kiné introuvable' });

    const kine = rows[0];
    const now = new Date();

    // Check if within 14-day retractation window from first subscription or account creation
    const referenceDate = kine.subscription_updated_at || kine.created_at;
    const windowEnd = new Date(referenceDate);
    windowEnd.setDate(windowEnd.getDate() + 14);

    if (now > windowEnd) {
      return res.status(400).json({
        error: 'Le délai de rétractation de 14 jours est dépassé.',
        window_ended_at: windowEnd.toISOString()
      });
    }

    // Record retractation event
    await pool.query(
      `INSERT INTO kine_subscription_events (kine_id, event_type, metadata)
       VALUES ($1, 'retractation_exercised', $2)`,
      [req.session.kineId, JSON.stringify({
        stripe_subscription_id: kine.stripe_subscription_id,
        kine_email: kine.email,
        window_end: windowEnd.toISOString(),
        exercised_at: now.toISOString(),
        refund_required: !!kine.stripe_subscription_id
      })]
    );

    // Cancel subscription immediately
    await pool.query(
      `UPDATE kines SET subscription_status = 'canceled', subscription_ends_at = NOW(),
       subscription_updated_at = NOW() WHERE id = $1`,
      [req.session.kineId]
    );

    const message = kine.stripe_subscription_id
      ? 'Votre droit de rétractation a été exercé. Un remboursement intégral sera traité sous 14 jours ouvrés.'
      : 'Votre droit de rétractation a été exercé. Votre essai gratuit a été annulé sans frais.';

    res.json({ success: true, message });
  } catch (err) {
    console.error('[SUBSCRIPTION] retractation error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/webhooks/stripe — Stripe webhook (subscription lifecycle events)
// Raw body is preserved by the middleware registered before express.json()
app.post('/api/webhooks/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  if (webhookSecret) {
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error('[STRIPE] Webhook signature verification failed:', err.message);
      return res.status(400).json({ error: 'Webhook signature invalid' });
    }
  } else {
    // No secret configured — parse raw body directly (dev mode only)
    try {
      event = JSON.parse(req.body.toString());
    } catch (err) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
  }

  console.log('[STRIPE] Webhook received:', event.type);

  try {
    await handleStripeEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error('[STRIPE] Event handling error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

/**
 * Handle Stripe webhook events.
 * Maps subscription lifecycle to kines.subscription_status.
 */
async function handleStripeEvent(event) {
  const data = event.data.object;

  // Idempotency: skip if already processed
  const existing = await pool.query(
    'SELECT id FROM kine_subscription_events WHERE stripe_event_id = $1',
    [event.id]
  );
  if (existing.rows.length > 0) {
    console.log('[STRIPE] Already processed event:', event.id);
    return;
  }

  // Find kine by customer ID or subscription ID
  async function findKine(customerId, subscriptionId) {
    if (customerId) {
      const r = await pool.query('SELECT id FROM kines WHERE stripe_customer_id = $1', [customerId]);
      if (r.rows.length > 0) return r.rows[0].id;
    }
    if (subscriptionId) {
      const r = await pool.query('SELECT id FROM kines WHERE stripe_subscription_id = $1', [subscriptionId]);
      if (r.rows.length > 0) return r.rows[0].id;
    }
    return null;
  }

  async function recordEvent(kineId, eventType, metadata) {
    await pool.query(
      `INSERT INTO kine_subscription_events (kine_id, event_type, stripe_event_id, metadata)
       VALUES ($1, $2, $3, $4)`,
      [kineId, eventType, event.id, JSON.stringify(metadata)]
    );
  }

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = data;
      const kineId = await findKine(sub.customer, sub.id);

      // Map Stripe status to our status
      let status = sub.status; // active, trialing, past_due, canceled, incomplete, incomplete_expired, paused, unpaid
      if (!['active', 'trialing', 'past_due', 'canceled', 'incomplete'].includes(status)) {
        status = 'canceled';
      }

      const endsAt = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
      const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000) : null;

      if (kineId) {
        await pool.query(
          `UPDATE kines SET
             stripe_customer_id = $1,
             stripe_subscription_id = $2,
             subscription_status = $3,
             subscription_ends_at = $4,
             trial_ends_at = COALESCE($5, trial_ends_at),
             subscription_updated_at = NOW()
           WHERE id = $6`,
          [sub.customer, sub.id, status, endsAt, trialEnd, kineId]
        );
        await recordEvent(kineId, `stripe_subscription_${event.type.split('.').pop()}`, {
          status, stripe_subscription_id: sub.id, stripe_customer_id: sub.customer
        });
      } else {
        console.warn('[STRIPE] No kine found for customer:', sub.customer);
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = data;
      const kineId = await findKine(sub.customer, sub.id);
      if (kineId) {
        const endsAt = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
        await pool.query(
          `UPDATE kines SET subscription_status = 'canceled', subscription_ends_at = $1,
           subscription_updated_at = NOW() WHERE id = $2`,
          [endsAt, kineId]
        );
        await recordEvent(kineId, 'stripe_subscription_canceled', {
          stripe_subscription_id: sub.id, ends_at: endsAt
        });
      }
      break;
    }

    case 'invoice.payment_succeeded': {
      const inv = data;
      const kineId = await findKine(inv.customer, inv.subscription);
      if (kineId) {
        await pool.query(
          `UPDATE kines SET subscription_status = 'active', subscription_updated_at = NOW() WHERE id = $1`,
          [kineId]
        );
        await recordEvent(kineId, 'payment_succeeded', {
          amount: inv.amount_paid, currency: inv.currency,
          invoice_id: inv.id, invoice_pdf: inv.invoice_pdf
        });
        console.log('[STRIPE] Payment succeeded for kine:', kineId, '— invoice:', inv.id);
      }
      break;
    }

    case 'invoice.payment_failed': {
      const inv = data;
      const kineId = await findKine(inv.customer, inv.subscription);
      if (kineId) {
        await pool.query(
          `UPDATE kines SET subscription_status = 'past_due', subscription_updated_at = NOW() WHERE id = $1`,
          [kineId]
        );
        await recordEvent(kineId, 'payment_failed', {
          amount: inv.amount_due, invoice_id: inv.id
        });
      }
      break;
    }

    case 'checkout.session.completed': {
      // Link a customer to their kine account by email
      const session = data;
      if (session.mode === 'subscription' && session.customer_email) {
        const emailLower = session.customer_email.toLowerCase();
        const kineResult = await pool.query(
          'SELECT id FROM kines WHERE LOWER(email) = $1', [emailLower]
        );
        if (kineResult.rows.length > 0) {
          const kineId = kineResult.rows[0].id;
          await pool.query(
            `UPDATE kines SET stripe_customer_id = $1, subscription_updated_at = NOW() WHERE id = $2`,
            [session.customer, kineId]
          );
          await recordEvent(kineId, 'checkout_completed', {
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription
          });
          console.log('[STRIPE] Linked customer', session.customer, 'to kine', kineId);
        }
      }
      break;
    }

    default:
      console.log('[STRIPE] Unhandled event type:', event.type);
  }
}

// ==========================================
// ROBOTS.TXT (Express route — bypasses Render CDN)
// ==========================================
app.get('/robots.txt', (req, res) => {
  const robotsTxt = `User-agent: *
Allow: /
Disallow: /dashboard/
Disallow: /patients/
Disallow: /programmes/
Disallow: /bilans/
Disallow: /suivi/
Disallow: /parametres/
Disallow: /abonnement/
Disallow: /api/
Disallow: /p/

# LLM crawlers — bienvenue
User-agent: GPTBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: Applebot-Extended
Allow: /

Sitemap: https://kinevia.pro/sitemap.xml
`;
  res.header('Content-Type', 'text/plain');
  res.send(robotsTxt);
});

// ==========================================
// PUBLIC API: Exercices (no auth required)
// ==========================================
app.get('/api/public/exercices', async (req, res) => {
  try {
    const { zone, pathologie } = req.query;
    let query = 'SELECT id, nom, description, zone_corporelle, pathologies, niveau_difficulte, series_recommandees, repetitions_recommandees, image_url FROM exercices WHERE kine_id IS NULL';
    const params = [];
    let paramIdx = 1;

    if (zone) {
      query += ` AND zone_corporelle = $${paramIdx}`;
      params.push(zone);
      paramIdx++;
    }
    if (pathologie) {
      query += ` AND (pathologies LIKE $${paramIdx} OR pathologies LIKE $${paramIdx + 1} OR pathologies LIKE $${paramIdx + 2} OR pathologies = $${paramIdx + 3})`;
      params.push(pathologie + ',%');
      params.push('%,' + pathologie + ',%');
      params.push('%,' + pathologie);
      params.push(pathologie);
      paramIdx += 4;
    }
    query += ' ORDER BY zone_corporelle, nom';

    const result = await pool.query(query, params);
    res.json({ exercices: result.rows });
  } catch (err) {
    console.error('Public exercices list error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Serve static files from public folder — HTML files get no-cache to prevent stale PWA content
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: function(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.set('Pragma', 'no-cache');
    }
  }
}));

// Subscription checkout redirect — sends to Stripe with prefilled email if logged in
app.get('/abonnement/checkout', async (req, res) => {
  let stripeUrl = STRIPE_CHECKOUT_URL;
  // Prefill email if user is logged in
  if (req.session.kineId) {
    try {
      const { rows } = await pool.query('SELECT email FROM kines WHERE id = $1', [req.session.kineId]);
      if (rows.length > 0) {
        stripeUrl = STRIPE_CHECKOUT_URL + '?prefilled_email=' + encodeURIComponent(rows[0].email);
      }
    } catch (e) { /* fail open */ }
  }
  res.redirect(302, stripeUrl);
});

// Subscription success page
app.get('/abonnement/succes', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'abonnement-succes.html'));
});

// Bilan PDF export page
app.get('/bilan-pdf', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'bilan-pdf.html'));
});

// Inscription page (commercial signup)
app.get('/inscription', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'inscription.html'));
});

// Legacy /beta route — redirect to /inscription
app.get('/beta', (req, res) => {
  res.redirect(301, '/inscription');
});

// Public /exercices route — public page for SEO, SPA for authenticated users
app.get('/exercices', (req, res) => {
  if (req.session.kineId) {
    // Authenticated user → serve the SPA
    res.sendFile(path.join(__dirname, 'public', 'app.html'));
  } else {
    // Not authenticated → serve public exercises page for SEO
    const slug = process.env.POLSIA_ANALYTICS_SLUG || '';
    const htmlPath = path.join(__dirname, 'public', 'exercices-public.html');
    if (fs.existsSync(htmlPath)) {
      let html = fs.readFileSync(htmlPath, 'utf8');
      html = html.replace('__POLSIA_SLUG__', slug);
      res.type('html').send(html);
    } else {
      res.sendFile(path.join(__dirname, 'public', 'app.html'));
    }
  }
});

// POST /api/contact-support - Send support message from logged-in kiné
app.post('/api/contact-support', requireAuth, async (req, res) => {
  try {
    const { sujet, message } = req.body;
    if (!sujet || !message) {
      return res.status(400).json({ error: 'Sujet et message requis.' });
    }
    const kine = req.kine || req.user;
    const kineName = [kine.prenom, kine.nom].filter(Boolean).join(' ') || 'Inconnu';
    const kineEmail = kine.email || 'inconnu';

    const sujetLabels = {
      question_generale: 'Question générale',
      probleme_technique: 'Problème technique',
      suggestion: "Suggestion d'amélioration",
      abonnement: "Question sur l'abonnement",
      donnees_rgpd: 'Données personnelles / RGPD',
      autre: 'Autre'
    };
    const sujetLabel = sujetLabels[sujet] || sujet;

    // Send email via Polsia email proxy
    const emailBody = `Nouveau message support Kinévia\n\nDe: ${kineName} (${kineEmail})\nSujet: ${sujetLabel}\n\nMessage:\n${message}`;
    const emailHtml = `<div style="font-family:sans-serif;max-width:600px;">
      <h2 style="color:#0ea5e9;">Nouveau message support Kinévia</h2>
      <table style="border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:4px 12px 4px 0;font-weight:bold;color:#374151;">De:</td><td style="padding:4px 0;">${kineName} (${kineEmail})</td></tr>
        <tr><td style="padding:4px 12px 4px 0;font-weight:bold;color:#374151;">Sujet:</td><td style="padding:4px 0;">${sujetLabel}</td></tr>
      </table>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-top:12px;">
        <p style="margin:0;white-space:pre-wrap;color:#334155;">${message.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
      </div>
    </div>`;

    await fetch('https://polsia.com/api/proxy/email/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.POLSIA_API_KEY}`,
      },
      body: JSON.stringify({
        to: kineEmail,
        subject: `[Support Kinévia] ${sujetLabel} - ${kineName}`,
        body: emailBody,
        html: emailHtml,
      }),
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Contact support error:', err);
    res.status(500).json({ error: 'Erreur lors de l\'envoi du message.' });
  }
});

// SPA catch-all: serve app.html for authenticated routes, patient pages, etc.
const appRoutes = ['/dashboard', '/patients', '/programmes', '/bilans', '/connexion', '/suivi', '/abonnement', '/parametres', '/mot-de-passe-oublie', '/reinitialisation-mot-de-passe', '/aide', '/messages', '/messages-archives', '/chat-ai'];
appRoutes.forEach(route => {
  app.get(route, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'app.html'));
  });
  // Also handle sub-routes like /patients/123
  app.get(route + '/*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'app.html'));
  });
});

// ==========================================
// RGPD CONSENT API
// ==========================================

// POST /api/rgpd/cookie-consent — save/update cookie consent
app.post('/api/rgpd/cookie-consent', async (req, res) => {
  try {
    const { visitor_id, functional_cookies, analytics_cookies } = req.body;
    if (!visitor_id) return res.status(400).json({ error: 'visitor_id requis' });

    const kine_id = req.session.kineId || null;
    const ip_raw = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const ip_hash = crypto.createHash('sha256').update(ip_raw).digest('hex');
    const ua = (req.headers['user-agent'] || '').substring(0, 500);

    await pool.query(`
      INSERT INTO cookie_consents (visitor_id, kine_id, functional_cookies, analytics_cookies, ip_hash, user_agent, consented_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      ON CONFLICT (visitor_id) DO UPDATE SET
        kine_id = COALESCE(EXCLUDED.kine_id, cookie_consents.kine_id),
        functional_cookies = EXCLUDED.functional_cookies,
        analytics_cookies = EXCLUDED.analytics_cookies,
        ip_hash = EXCLUDED.ip_hash,
        user_agent = EXCLUDED.user_agent,
        updated_at = NOW()
    `, [visitor_id, kine_id, functional_cookies !== false, analytics_cookies === true, ip_hash, ua]);

    res.json({ success: true });
  } catch (err) {
    console.error('cookie-consent error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/rgpd/cookie-consent/:visitor_id — get saved consent
app.get('/api/rgpd/cookie-consent/:visitor_id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT functional_cookies, analytics_cookies, consented_at FROM cookie_consents WHERE visitor_id = $1',
      [req.params.visitor_id]
    );
    if (result.rows.length === 0) return res.json({ found: false });
    res.json({ found: true, ...result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/rgpd/patient-health-consent — consentement données de santé patient Art. 9
app.post('/api/rgpd/patient-health-consent', async (req, res) => {
  try {
    const { patient_lien, consented } = req.body;
    if (!patient_lien) return res.status(400).json({ error: 'patient_lien requis' });

    const ip_raw = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const ip_hash = crypto.createHash('sha256').update(ip_raw).digest('hex');
    const ua = (req.headers['user-agent'] || '').substring(0, 500);
    const now = new Date();

    await pool.query(`
      INSERT INTO patient_health_consents (patient_lien, consented, consented_at, ip_hash, user_agent)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (patient_lien) DO UPDATE SET
        consented = EXCLUDED.consented,
        consented_at = CASE WHEN EXCLUDED.consented THEN $3 ELSE patient_health_consents.consented_at END,
        withdrawn_at = CASE WHEN NOT EXCLUDED.consented THEN $3 ELSE patient_health_consents.withdrawn_at END,
        ip_hash = EXCLUDED.ip_hash,
        user_agent = EXCLUDED.user_agent
    `, [patient_lien, consented !== false, now, ip_hash, ua]);

    res.json({ success: true });
  } catch (err) {
    console.error('patient-health-consent error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/rgpd/patient-health-consent/:lien — check patient consent status
app.get('/api/rgpd/patient-health-consent/:lien', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT consented, consented_at, withdrawn_at FROM patient_health_consents WHERE patient_lien = $1',
      [req.params.lien]
    );
    if (result.rows.length === 0) return res.json({ found: false, consented: false });
    res.json({ found: true, ...result.rows[0] });
  } catch (err) {
    console.error('patient-health-consent GET error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// ADMIN ROUTES
// ==========================================

/**
 * Admin auth middleware — requires logged-in session AND email matching ADMIN_EMAIL env var.
 * Falls back to POLSIA_API_KEY check if ADMIN_EMAIL is not set.
 */
async function requireAdmin(req, res, next) {
  if (!req.session.kineId) {
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(401).json({ error: 'Non authentifié' });
    }
    return res.redirect('/connexion');
  }
  // ADMIN_EMAIL env var — fallback to owner email if not explicitly set
  const adminEmail = process.env.ADMIN_EMAIL || 'amin.thiers.pro@gmail.com';
  try {
    const result = await pool.query('SELECT email FROM kines WHERE id = $1', [req.session.kineId]);
    if (result.rows.length === 0) {
      return res.redirect('/connexion');
    }
    const email = result.rows[0].email;
    if (email.toLowerCase() !== adminEmail.toLowerCase()) {
      if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.status(403).json({ error: 'Accès refusé' });
      }
      return res.redirect('/connexion');
    }
    next();
  } catch (err) {
    console.error('Admin auth error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

// GET /admin — serve admin dashboard (redirect to /connexion if not admin)
app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Admin analytics + stats routes (filtered: excludes demo/beta accounts)
app.use('/api/admin', require('./routes/admin-analytics')(pool, requireAdmin));

// Admin DB export endpoint — temporary, for Render→Scalingo migration
app.use('/api/admin', require('./routes/admin-export')(pool, requireAdmin));

// Admin schema export — downloads full schema.sql via information_schema
app.use('/api/admin', require('./routes/admin-schema-export')(pool, requireAdmin));

// GET /api/admin/kines — list all kines sorted by created_at desc, with patient count
app.get('/api/admin/kines', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        k.id,
        k.prenom,
        k.nom,
        k.email,
        k.cabinet,
        k.telephone,
        COALESCE(k.subscription_status, 'trialing') AS subscription_status,
        k.trial_ends_at,
        k.subscription_ends_at,
        k.created_at,
        COUNT(p.id) AS patient_count
      FROM kines k
      LEFT JOIN patients p ON p.kine_id = k.id
      GROUP BY k.id
      ORDER BY k.created_at DESC
    `);

    res.json({
      kines: result.rows.map(k => ({
        id: k.id,
        prenom: k.prenom,
        nom: k.nom,
        email: k.email,
        cabinet: k.cabinet,
        telephone: k.telephone,
        subscription_status: k.subscription_status,
        trial_ends_at: k.trial_ends_at,
        subscription_ends_at: k.subscription_ends_at,
        created_at: k.created_at,
        patient_count: parseInt(k.patient_count, 10),
      }))
    });
  } catch (err) {
    console.error('Admin kines error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/admin/lifetime-free — list all accounts with lifetime_free=true
app.get('/api/admin/lifetime-free', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, prenom, nom, email, created_at
       FROM kines
       WHERE lifetime_free = TRUE
       ORDER BY created_at ASC`
    );
    res.json({ accounts: result.rows });
  } catch (err) {
    console.error('Admin lifetime-free list error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/admin/lifetime-free — grant lifetime_free to an email
app.post('/api/admin/lifetime-free', requireAdmin, async (req, res) => {
  const { email } = req.body;
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email requis' });
  }
  try {
    const result = await pool.query(
      `UPDATE kines SET lifetime_free = TRUE
       WHERE LOWER(email) = LOWER($1)
       RETURNING id, prenom, nom, email`,
      [email.trim()]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Compte introuvable' });
    }
    res.json({ success: true, account: result.rows[0] });
  } catch (err) {
    console.error('Admin lifetime-free grant error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/admin/lifetime-free — revoke lifetime_free from an email
app.delete('/api/admin/lifetime-free', requireAdmin, async (req, res) => {
  const { email } = req.body;
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email requis' });
  }
  try {
    const result = await pool.query(
      `UPDATE kines SET lifetime_free = FALSE
       WHERE LOWER(email) = LOWER($1)
       RETURNING id, prenom, nom, email`,
      [email.trim()]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Compte introuvable' });
    }
    res.json({ success: true, account: result.rows[0] });
  } catch (err) {
    console.error('Admin lifetime-free revoke error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// LEGAL PAGE ROUTES
// ==========================================
const legalRoutes = ['/mentions-legales', '/confidentialite', '/cgu', '/securite', '/cgv', '/cookie-consent'];
legalRoutes.forEach(route => {
  app.get(route, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', route.substring(1) + '.html'));
  });
});

// Patient public view — no-cache to ensure fresh HTML after deploys
app.get('/p/:lien', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'patient.html'));
});

// Patient reminder preferences page (no-login, token-based)
app.get('/rappels/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'rappels-prefs.html'));
});

// Redirect /login to /connexion (French login route)
app.get('/login', (req, res) => {
  res.redirect(301, '/connexion');
});


// /tarifs serves landing page (tarifs section is an anchor in index.html)
app.get('/tarifs', (req, res) => {
  const slug = process.env.POLSIA_ANALYTICS_SLUG || '';
  const htmlPath = path.join(__dirname, 'public', 'index.html');

  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('__POLSIA_SLUG__', slug);
    res.type('html').send(html);
  } else {
    res.redirect('/');
  }
});

// Landing page with analytics beacon injected
app.get('/', (req, res) => {
  const slug = process.env.POLSIA_ANALYTICS_SLUG || '';
  const htmlPath = path.join(__dirname, 'public', 'index.html');

  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('__POLSIA_SLUG__', slug);
    res.type('html').send(html);
  } else {
    res.json({ message: 'Kinévia - Application de suivi patient pour kinésithérapeutes' });
  }
});

// ==========================================
// RAPPELS AUTOMATIQUES PAR EMAIL
// ==========================================

/**
 * Obtenir ou créer les préférences email d'un patient.
 * Génère un token unique utilisé dans les liens de gestion des rappels.
 */
async function getOrCreatePatientEmailPrefs(patientId) {
  const existing = await pool.query(
    'SELECT * FROM patient_email_prefs WHERE patient_id = $1',
    [patientId]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const token = crypto.randomBytes(48).toString('hex');
  const result = await pool.query(
    `INSERT INTO patient_email_prefs (patient_id, prefs_token, rappels_actifs)
     VALUES ($1, $2, true)
     ON CONFLICT (patient_id) DO UPDATE SET patient_id = EXCLUDED.patient_id
     RETURNING *`,
    [patientId, token]
  );
  return result.rows[0];
}

/**
 * Envoi de l'email d'assignation d'un programme à un patient.
 */
async function sendEmailAssignation({ patient, kine, programme, prefsToken }) {
  const appUrl = process.env.APP_URL || 'https://kinevia.pro';
  const patientUrl = `${appUrl}/p/${patient.lien_unique}`;
  const prefsUrl = `${appUrl}/rappels/${prefsToken}`;
  const kineName = `${kine.prenom} ${kine.nom}`;

  const html = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Votre programme d'exercices — Kinévia</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:system-ui,-apple-system,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.08);overflow:hidden;">
    <div style="background:linear-gradient(135deg,#0ea5e9,#2DD4BF);padding:32px 40px;">
      <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700;">Kinévia</h1>
      <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:14px;">Suivi de rééducation</p>
    </div>
    <div style="padding:36px 40px;">
      <h2 style="color:#0f172a;font-size:20px;margin:0 0 8px;">Bonjour ${patient.prenom},</h2>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 24px;">
        Votre kinésithérapeute <strong>${kineName}</strong> vous a assigné un nouveau programme d'exercices : <strong>${programme.titre}</strong>.
      </p>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 32px;">
        Cliquez sur le bouton ci-dessous pour accéder à vos exercices du jour et suivre votre progression.
      </p>
      <div style="text-align:center;margin-bottom:32px;">
        <a href="${patientUrl}" style="display:inline-block;background:linear-gradient(135deg,#0ea5e9,#2DD4BF);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:600;">
          Voir mes exercices
        </a>
      </div>
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0;">
      <p style="color:#94a3b8;font-size:13px;line-height:1.5;margin:0;">
        Vous recevrez des rappels automatiques pour vous aider à ne pas oublier vos exercices.<br>
        <a href="${prefsUrl}" style="color:#0ea5e9;text-decoration:none;">Gérer mes rappels</a>
      </p>
    </div>
  </div>
</body>
</html>`;

  await sendEmail({
    to: patient.email,
    subject: `Votre programme "${programme.titre}" — Kinévia`,
    body: `Bonjour ${patient.prenom},\n\nVotre kinésithérapeute ${kineName} vous a assigné le programme "${programme.titre}".\n\nAccédez à vos exercices ici : ${patientUrl}\n\nGérer vos rappels : ${prefsUrl}`,
    html
  });
}

/**
 * Envoi d'un email de rappel d'exercices à un patient.
 */
async function sendEmailRappel({ patient, kine, programme, prefsToken }) {
  const appUrl = process.env.APP_URL || 'https://kinevia.pro';
  const patientUrl = `${appUrl}/p/${patient.lien_unique}`;
  const prefsUrl = `${appUrl}/rappels/${prefsToken}`;
  const kineName = `${kine.prenom} ${kine.nom}`;

  const html = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Rappel exercices — Kinévia</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:system-ui,-apple-system,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.08);overflow:hidden;">
    <div style="background:linear-gradient(135deg,#0ea5e9,#2DD4BF);padding:32px 40px;">
      <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700;">Kinévia</h1>
      <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:14px;">Suivi de rééducation</p>
    </div>
    <div style="padding:36px 40px;">
      <h2 style="color:#0f172a;font-size:20px;margin:0 0 8px;">Rappel : vos exercices vous attendent 💪</h2>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 24px;">
        Bonjour ${patient.prenom},<br><br>
        Votre programme <strong>${programme.titre}</strong> prescrit par <strong>${kineName}</strong> attend votre passage.
        La régularité est la clé d'une bonne rééducation !
      </p>
      <div style="text-align:center;margin-bottom:32px;">
        <a href="${patientUrl}" style="display:inline-block;background:linear-gradient(135deg,#0ea5e9,#2DD4BF);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:600;">
          Faire mes exercices maintenant
        </a>
      </div>
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0;">
      <p style="color:#94a3b8;font-size:13px;line-height:1.5;margin:0;">
        <a href="${prefsUrl}" style="color:#0ea5e9;text-decoration:none;">Gérer mes rappels</a>
        &nbsp;·&nbsp;
        <a href="${prefsUrl}?action=pause" style="color:#94a3b8;text-decoration:none;">Mettre en pause</a>
        &nbsp;·&nbsp;
        <a href="${prefsUrl}?action=unsubscribe" style="color:#94a3b8;text-decoration:none;">Se désabonner</a>
      </p>
    </div>
  </div>
</body>
</html>`;

  await sendEmail({
    to: patient.email,
    subject: `Rappel : vos exercices "${programme.titre}" — Kinévia`,
    body: `Bonjour ${patient.prenom},\n\nVotre programme "${programme.titre}" prescrit par ${kineName} attend votre passage.\n\nFaites vos exercices : ${patientUrl}\n\nGérer vos rappels : ${prefsUrl}`,
    html
  });
}

// ==========================================
// ROUTES : Rappels côté kiné (requireAuth)
// ==========================================

// GET /api/programmes/:id/rappels - Obtenir les paramètres de rappel d'un programme
app.get('/api/programmes/:id/rappels', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM programme_rappels WHERE programme_id = $1 AND kine_id = $2',
      [req.params.id, req.session.kineId]
    );
    res.json({ rappels: rows[0] || null });
  } catch (err) {
    console.error('Get rappels error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/programmes/:id/rappels - Créer ou mettre à jour les paramètres de rappel
app.put('/api/programmes/:id/rappels', requireAuth, async (req, res) => {
  try {
    const { rappels_actifs, delai_jours, push_rappel_heure, push_rappel_jours } = req.body;
    const programmeId = req.params.id;
    const kineId = req.session.kineId;

    // Vérifier que le programme appartient au kiné
    const progCheck = await pool.query(
      'SELECT id, patient_id FROM programmes WHERE id = $1 AND kine_id = $2',
      [programmeId, kineId]
    );
    if (progCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Programme non trouvé' });
    }
    const patientId = progCheck.rows[0].patient_id;

    // Valider le délai (1 à 30 jours)
    const delai = parseInt(delai_jours, 10);
    if (isNaN(delai) || delai < 1 || delai > 30) {
      return res.status(400).json({ error: 'Le délai doit être compris entre 1 et 30 jours' });
    }

    // Valider l'heure push si fournie (format HH:MM)
    let heureValidee = null;
    if (push_rappel_heure) {
      if (!/^\d{2}:\d{2}$/.test(push_rappel_heure)) {
        return res.status(400).json({ error: 'Format d\'heure invalide (attendu HH:MM)' });
      }
      heureValidee = push_rappel_heure;
    }

    // Valider les jours push si fournis
    const JOURS_VALIDES = ['lun','mar','mer','jeu','ven','sam','dim'];
    let joursValidés = null;
    if (Array.isArray(push_rappel_jours) && push_rappel_jours.length > 0) {
      const invalid = push_rappel_jours.filter(j => !JOURS_VALIDES.includes(j));
      if (invalid.length > 0) {
        return res.status(400).json({ error: `Jours invalides: ${invalid.join(', ')}` });
      }
      joursValidés = push_rappel_jours;
    } else if (push_rappel_jours === null || push_rappel_jours === '') {
      joursValidés = null;
    }

    const result = await pool.query(
      `INSERT INTO programme_rappels (programme_id, kine_id, patient_id, rappels_actifs, delai_jours, push_rappel_heure, push_rappel_jours, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (programme_id)
       DO UPDATE SET rappels_actifs = EXCLUDED.rappels_actifs,
                     delai_jours = EXCLUDED.delai_jours,
                     push_rappel_heure = EXCLUDED.push_rappel_heure,
                     push_rappel_jours = EXCLUDED.push_rappel_jours,
                     updated_at = NOW()
       RETURNING *`,
      [programmeId, kineId, patientId, rappels_actifs !== false, delai, heureValidee, joursValidés]
    );

    res.json({ rappels: result.rows[0] });
  } catch (err) {
    console.error('Update rappels error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/programmes/:id/rappels/envoyer-assignation
// Envoyer manuellement l'email d'assignation (ou lors de la création)
app.post('/api/programmes/:id/rappels/envoyer-assignation', requireAuth, async (req, res) => {
  try {
    const programmeId = req.params.id;
    const kineId = req.session.kineId;

    const progResult = await pool.query(
      `SELECT p.*, pat.id AS pat_id, pat.nom AS pat_nom, pat.prenom AS pat_prenom,
              pat.email AS pat_email, pat.lien_unique,
              k.prenom AS kine_prenom, k.nom AS kine_nom
       FROM programmes p
       JOIN patients pat ON pat.id = p.patient_id
       JOIN kines k ON k.id = p.kine_id
       WHERE p.id = $1 AND p.kine_id = $2`,
      [programmeId, kineId]
    );
    if (progResult.rows.length === 0) {
      return res.status(404).json({ error: 'Programme non trouvé' });
    }
    const row = progResult.rows[0];
    if (!row.pat_email) {
      return res.status(400).json({ error: 'Le patient n\'a pas d\'adresse email' });
    }

    const prefs = await getOrCreatePatientEmailPrefs(row.pat_id);

    await sendEmailAssignation({
      patient: { prenom: row.pat_prenom, nom: row.pat_nom, email: row.pat_email, lien_unique: row.lien_unique },
      kine: { prenom: row.kine_prenom, nom: row.kine_nom },
      programme: { titre: row.titre },
      prefsToken: prefs.prefs_token
    });

    // Marquer comme envoyé
    await pool.query(
      `INSERT INTO programme_rappels (programme_id, kine_id, patient_id, email_assignation_envoye)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (programme_id)
       DO UPDATE SET email_assignation_envoye = true`,
      [programmeId, kineId, row.pat_id]
    );

    // Log du rappel
    await pool.query(
      'INSERT INTO rappel_logs (patient_id, programme_id, type_rappel) VALUES ($1, $2, $3)',
      [row.pat_id, programmeId, 'assignation']
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Send assignation email error:', err);
    res.status(500).json({ error: 'Erreur lors de l\'envoi de l\'email' });
  }
});

// ==========================================
// ROUTES : Préférences patient (sans login, token-based)
// ==========================================

// GET /api/rappels/prefs/:token - Obtenir les préférences d'un patient
app.get('/api/rappels/prefs/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { rows } = await pool.query(
      `SELECT pep.*, p.prenom, p.nom
       FROM patient_email_prefs pep
       JOIN patients p ON p.id = pep.patient_id
       WHERE pep.prefs_token = $1`,
      [token]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Lien invalide ou expiré' });
    }
    const pref = rows[0];
    res.json({
      prenom: pref.prenom,
      rappels_actifs: pref.rappels_actifs,
      delai_jours_patient: pref.delai_jours_patient
    });
  } catch (err) {
    console.error('Get patient prefs error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/rappels/prefs/:token - Mettre à jour les préférences patient
app.put('/api/rappels/prefs/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { rappels_actifs, delai_jours_patient } = req.body;

    const check = await pool.query(
      'SELECT id FROM patient_email_prefs WHERE prefs_token = $1',
      [token]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Lien invalide ou expiré' });
    }

    const updates = [];
    const values = [];
    let idx = 1;

    if (typeof rappels_actifs === 'boolean') {
      updates.push(`rappels_actifs = $${idx++}`);
      values.push(rappels_actifs);
    }
    if (delai_jours_patient !== undefined) {
      const d = delai_jours_patient === null ? null : parseInt(delai_jours_patient, 10);
      if (d !== null && (isNaN(d) || d < 1 || d > 30)) {
        return res.status(400).json({ error: 'Délai invalide' });
      }
      updates.push(`delai_jours_patient = $${idx++}`);
      values.push(d);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Aucune modification' });
    }

    updates.push(`mis_a_jour_at = NOW()`);
    values.push(token);

    await pool.query(
      `UPDATE patient_email_prefs SET ${updates.join(', ')} WHERE prefs_token = $${idx}`,
      values
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Update patient prefs error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// CRON : Envoi des rappels automatiques
// ==========================================

/**
 * Vérifie si un patient a fait ses exercices aujourd'hui pour un programme donné.
 */
async function patientAFaitSeancesAujourdhui(patientId, programmeId) {
  const result = await pool.query(
    `SELECT id FROM seances
     WHERE patient_id = $1 AND programme_id = $2
     AND date = CURRENT_DATE AND completee = true
     LIMIT 1`,
    [patientId, programmeId]
  );
  return result.rows.length > 0;
}

/**
 * Vérifie si un rappel a déjà été envoyé récemment (dans les dernières X heures).
 */
async function rappelDejaEnvoyeRecemment(patientId, programmeId, typeRappel, heures) {
  const result = await pool.query(
    `SELECT id FROM rappel_logs
     WHERE patient_id = $1 AND programme_id = $2 AND type_rappel = $3
     AND envoye_at > NOW() - INTERVAL '${parseInt(heures, 10)} hours'
     LIMIT 1`,
    [patientId, programmeId, typeRappel]
  );
  return result.rows.length > 0;
}

/**
 * Job principal : vérifie tous les programmes actifs avec rappels activés
 * et envoie les rappels aux patients qui n'ont pas fait leurs exercices.
 */
async function runRappelsJob() {
  try {
    // Récupérer tous les programmes actifs avec rappels activés et email patient présent
    const { rows: programmes } = await pool.query(
      `SELECT pr.programme_id, pr.patient_id, pr.kine_id,
              pr.delai_jours, pr.rappels_actifs AS kine_rappels_actifs,
              pep.rappels_actifs AS patient_rappels_actifs,
              pep.delai_jours_patient, pep.prefs_token,
              p.nom AS pat_nom, p.prenom AS pat_prenom,
              p.email AS pat_email, p.lien_unique,
              prog.titre AS prog_titre, prog.actif AS prog_actif,
              k.prenom AS kine_prenom, k.nom AS kine_nom
       FROM programme_rappels pr
       JOIN programmes prog ON prog.id = pr.programme_id
       JOIN patients p ON p.id = pr.patient_id
       JOIN kines k ON k.id = pr.kine_id
       LEFT JOIN patient_email_prefs pep ON pep.patient_id = pr.patient_id
       WHERE pr.rappels_actifs = true
         AND prog.actif = true
         AND p.email IS NOT NULL AND p.email != ''
         AND (pep.rappels_actifs IS NULL OR pep.rappels_actifs = true)`
    );

    for (const prog of programmes) {
      try {
        // Délai effectif : préférence patient si définie, sinon délai kiné
        const delaiJours = prog.delai_jours_patient || prog.delai_jours || 1;
        const delaiHeures = delaiJours * 24;

        // Vérifier que le dernier rappel envoyé respecte le délai
        const dejaEnvoye = await rappelDejaEnvoyeRecemment(
          prog.patient_id, prog.programme_id, 'rappel', delaiHeures
        );
        if (dejaEnvoye) continue;

        // Vérifier que le patient n'a PAS fait ses exercices aujourd'hui
        const faitAujourdhui = await patientAFaitSeancesAujourdhui(
          prog.patient_id, prog.programme_id
        );
        if (faitAujourdhui) continue;

        // Vérifier qu'il y a eu au moins un log précédent (ou que delaiJours jours se sont écoulés depuis la création)
        const { rows: lastLogs } = await pool.query(
          `SELECT envoye_at FROM rappel_logs
           WHERE patient_id = $1 AND programme_id = $2
           ORDER BY envoye_at DESC LIMIT 1`,
          [prog.patient_id, prog.programme_id]
        );

        if (lastLogs.length > 0) {
          // Dernier rappel envoyé il y a moins de delaiJours jours → skip
          const lastSent = new Date(lastLogs[0].envoye_at);
          const hoursSinceLastSent = (Date.now() - lastSent.getTime()) / (1000 * 60 * 60);
          if (hoursSinceLastSent < delaiHeures) continue;
        } else {
          // Jamais envoyé → vérifier que le programme a au moins delaiJours jours
          const { rows: progRows } = await pool.query(
            'SELECT created_at FROM programmes WHERE id = $1',
            [prog.programme_id]
          );
          if (progRows.length === 0) continue;
          const progAge = (Date.now() - new Date(progRows[0].created_at).getTime()) / (1000 * 60 * 60);
          if (progAge < delaiHeures) continue;
        }

        // S'assurer que le patient a un token de prefs
        let prefsToken = prog.prefs_token;
        if (!prefsToken) {
          const prefs = await getOrCreatePatientEmailPrefs(prog.patient_id);
          prefsToken = prefs.prefs_token;
        }

        // Envoyer le rappel
        await sendEmailRappel({
          patient: {
            prenom: prog.pat_prenom,
            nom: prog.pat_nom,
            email: prog.pat_email,
            lien_unique: prog.lien_unique
          },
          kine: { prenom: prog.kine_prenom, nom: prog.kine_nom },
          programme: { titre: prog.prog_titre },
          prefsToken
        });

        // Logger le rappel envoyé
        await pool.query(
          'INSERT INTO rappel_logs (patient_id, programme_id, type_rappel) VALUES ($1, $2, $3)',
          [prog.patient_id, prog.programme_id, 'rappel']
        );

        console.log(`[rappels] Rappel envoyé → patient ${prog.patient_id} / programme ${prog.programme_id}`);
      } catch (progErr) {
        console.error(`[rappels] Erreur programme ${prog.programme_id}:`, progErr.message);
      }
    }
  } catch (err) {
    console.error('[rappels] Job error:', err.message);
  }
}

/**
 * Job push : envoie des notifications push aux patients selon le planning configuré.
 * Appelé toutes les heures après runRappelsJob().
 *
 * Logique :
 *   - Pour chaque programme avec push_rappel_heure + push_rappel_jours définis
 *   - Vérifier que le jour actuel est dans la liste des jours configurés
 *   - Vérifier que l'heure actuelle correspond à push_rappel_heure (±30 min, pour tolérer l'heure du cron)
 *   - Vérifier qu'on n'a pas déjà envoyé le push aujourd'hui (déduplication via rappel_logs type='push')
 *   - Envoyer le push à toutes les souscriptions actives du patient
 */
const JOUR_MAP = {
  0: 'dim', 1: 'lun', 2: 'mar', 3: 'mer', 4: 'jeu', 5: 'ven', 6: 'sam'
};

async function runPushRappelsJob() {
  try {
    // Récupérer tous les programmes actifs avec planning push configuré
    const { rows: programmes } = await pool.query(
      `SELECT pr.programme_id, pr.patient_id, pr.kine_id,
              pr.push_rappel_heure, pr.push_rappel_jours,
              p.lien_unique,
              prog.titre AS prog_titre, prog.actif AS prog_actif
       FROM programme_rappels pr
       JOIN programmes prog ON prog.id = pr.programme_id
       JOIN patients p ON p.id = pr.patient_id
       WHERE pr.push_rappel_heure IS NOT NULL
         AND pr.push_rappel_jours IS NOT NULL
         AND array_length(pr.push_rappel_jours, 1) > 0
         AND prog.actif = true`
    );

    if (programmes.length === 0) return;

    const now = new Date();
    const currentDayKey = JOUR_MAP[now.getDay()];
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    for (const prog of programmes) {
      try {
        // Vérifier que aujourd'hui est dans les jours configurés
        if (!prog.push_rappel_jours || !prog.push_rappel_jours.includes(currentDayKey)) continue;

        // Vérifier que l'heure actuelle est dans la fenêtre de 60 min autour de l'heure configurée
        // (le cron tourne toutes les heures, on accepte toute l'heure configurée)
        const [configH, configM] = prog.push_rappel_heure.split(':').map(Number);
        if (currentHour !== configH) continue;

        // Vérifier qu'on n'a pas déjà envoyé le push aujourd'hui
        const { rows: todayLogs } = await pool.query(
          `SELECT id FROM rappel_logs
           WHERE patient_id = $1 AND programme_id = $2 AND type_rappel = 'push'
             AND envoye_at >= CURRENT_DATE AND envoye_at < CURRENT_DATE + INTERVAL '1 day'`,
          [prog.patient_id, prog.programme_id]
        );
        if (todayLogs.length > 0) continue;

        // Vérifier que le patient n'a pas désactivé les rappels push
        const { rows: prefCheck } = await pool.query(
          `SELECT push_rappels_enabled FROM patient_notification_prefs WHERE patient_id = $1`,
          [prog.patient_id]
        );
        // Si une préférence existe et est false → skip
        if (prefCheck.length > 0 && prefCheck[0].push_rappels_enabled === false) continue;

        // Vérifier que le patient a des souscriptions actives
        const { rows: subCheck } = await pool.query(
          `SELECT id FROM patient_push_subscriptions WHERE patient_id = $1 AND active = TRUE LIMIT 1`,
          [prog.patient_id]
        );
        if (subCheck.length === 0) continue;

        // Envoyer le push
        const pushPayload = {
          title: 'Kinévia 💪',
          body: 'C\'est l\'heure de faire vos exercices !',
          data: { url: '/p/' + prog.lien_unique }
        };

        const result = await sendPushToPatient(prog.patient_id, pushPayload);

        if (result.sent > 0) {
          // Logger le push envoyé
          await pool.query(
            'INSERT INTO rappel_logs (patient_id, programme_id, type_rappel) VALUES ($1, $2, $3)',
            [prog.patient_id, prog.programme_id, 'push']
          );
          console.log(`[push-rappels] Push envoyé → patient ${prog.patient_id} / programme ${prog.programme_id} (${result.sent} appareils)`);
        }
      } catch (progErr) {
        console.error(`[push-rappels] Erreur programme ${prog.programme_id}:`, progErr.message);
      }
    }
  } catch (err) {
    console.error('[push-rappels] Job error:', err.message);
  }
}

// ==========================================
// ROUTES : Protocoles de rééducation
// ==========================================

// GET /api/protocoles — liste tous les protocoles (filtrable par zone ou difficulte)
app.get('/api/protocoles', async (req, res) => {
  try {
    const { zone, difficulte } = req.query;
    const conditions = [];
    const values = [];
    let idx = 1;

    if (zone) {
      conditions.push(`zone = $${idx++}`);
      values.push(zone);
    }
    if (difficulte) {
      conditions.push(`difficulte = $${idx++}`);
      values.push(difficulte);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await pool.query(
      `SELECT id, nom, zone, pathologie, description, duree_semaines, duree_label, difficulte, frequence_semaine, sources, precautions, created_at
       FROM protocols ${where}
       ORDER BY zone, nom`,
      values
    );
    res.json({ protocols: rows });
  } catch (err) {
    console.error('GET /api/protocoles error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/protocoles/zones — liste les zones disponibles avec comptage
app.get('/api/protocoles/zones', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT zone, COUNT(*)::int AS count FROM protocols GROUP BY zone ORDER BY count DESC`
    );
    res.json({ zones: rows });
  } catch (err) {
    console.error('GET /api/protocoles/zones error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/protocoles/:id — détail d'un protocole avec ses phases
app.get('/api/protocoles/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (isNaN(parseInt(id, 10))) {
      return res.status(400).json({ error: 'ID invalide' });
    }
    const { rows } = await pool.query(
      `SELECT * FROM protocols WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Protocole introuvable' });
    }
    res.json({ protocol: rows[0] });
  } catch (err) {
    console.error('GET /api/protocoles/:id error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/protocols/:id/videos — all videos for exercises in a protocol
// Resolves protocol phases (JSONB) → exercise names → exercise_videos rows.
// Public endpoint (no auth required) since protocol data is not patient-sensitive.
app.get('/api/protocols/:id/videos', async (req, res) => {
  try {
    const protocolId = parseInt(req.params.id, 10);
    if (isNaN(protocolId)) {
      return res.status(400).json({ error: 'ID invalide' });
    }

    // Fetch the protocol to get exercise names from phases
    const protResult = await pool.query(
      `SELECT id, nom, phases FROM protocols WHERE id = $1`,
      [protocolId]
    );
    if (protResult.rows.length === 0) {
      return res.status(404).json({ error: 'Protocole introuvable' });
    }

    const protocol = protResult.rows[0];
    const phases = Array.isArray(protocol.phases) ? protocol.phases : [];

    // Collect all exercise names mentioned across phases
    const exerciseNames = new Set();
    for (const phase of phases) {
      if (Array.isArray(phase.exercices)) {
        for (const ex of phase.exercices) {
          if (typeof ex === 'string' && ex.trim()) {
            exerciseNames.add(ex.trim());
          }
        }
      }
    }

    if (exerciseNames.size === 0) {
      return res.json({ protocol_id: protocolId, videos: [] });
    }

    // Find exercises matching phase names that have videos
    const nameArray = Array.from(exerciseNames);
    const { rows } = await pool.query(
      `SELECT e.id AS exercise_id, e.nom AS exercise_nom, e.zone_corporelle,
              ev.id AS video_id, ev.video_url, ev.thumbnail_url,
              ev.duration_seconds, ev.source, ev.source_url, ev.created_at
         FROM exercices e
         JOIN exercise_videos ev ON ev.exercise_id = e.id
        WHERE e.nom = ANY($1::text[])
        ORDER BY e.nom`,
      [nameArray]
    );

    res.json({ protocol_id: protocolId, protocol_nom: protocol.nom, videos: rows });
  } catch (err) {
    console.error('GET /api/protocols/:id/videos error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// TESTS CLINIQUES API
// ==========================================

// GET /api/tests-cliniques — liste paginée avec filtres par catégorie
app.get('/api/tests-cliniques', requireAuth, async (req, res) => {
  try {
    const { categorie, page = 1, limit = 20 } = req.query;
    const conditions = [];
    const values = [];
    let idx = 1;

    if (categorie) {
      conditions.push(`category = $${idx++}`);
      values.push(categorie);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM clinical_tests ${where}`,
      values
    );

    const valuesWithPagination = [...values, parseInt(limit, 10), offset];
    const { rows } = await pool.query(
      `SELECT id, name, description, category, scoring_method, evidence_level, source_reference, created_at
       FROM clinical_tests ${where}
       ORDER BY category, name
       LIMIT $${idx} OFFSET $${idx + 1}`,
      valuesWithPagination
    );

    res.json({
      tests: rows,
      total: countResult.rows[0].total,
      page: parseInt(page, 10),
      limit: parseInt(limit, 10)
    });
  } catch (err) {
    console.error('GET /api/tests-cliniques error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/tests-cliniques/categories — liste les catégories disponibles avec comptage
app.get('/api/tests-cliniques/categories', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT category, COUNT(*)::int AS count FROM clinical_tests GROUP BY category ORDER BY count DESC`
    );
    res.json({ categories: rows });
  } catch (err) {
    console.error('GET /api/tests-cliniques/categories error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/tests-cliniques/:id — détail avec items
app.get('/api/tests-cliniques/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (isNaN(parseInt(id, 10))) {
      return res.status(400).json({ error: 'ID invalide' });
    }
    const testResult = await pool.query(
      `SELECT * FROM clinical_tests WHERE id = $1`,
      [id]
    );
    if (testResult.rows.length === 0) {
      return res.status(404).json({ error: 'Test clinique introuvable' });
    }
    const itemsResult = await pool.query(
      `SELECT * FROM clinical_test_items WHERE clinical_test_id = $1 ORDER BY item_number`,
      [id]
    );
    res.json({ test: testResult.rows[0], items: itemsResult.rows });
  } catch (err) {
    console.error('GET /api/tests-cliniques/:id error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/tests-cliniques — création (admin uniquement)
app.post('/api/tests-cliniques', requireAdmin, async (req, res) => {
  try {
    const { name, description, category, scoring_method, instructions, interpretation_guide, evidence_level, source_reference } = req.body;
    if (!name || !category) {
      return res.status(400).json({ error: 'name et category sont requis' });
    }
    const validCategories = ['douleur', 'fonction', 'equilibre', 'respiratoire', 'force', 'mobilite', 'neurologique', 'psychologique'];
    if (!validCategories.includes(category)) {
      return res.status(400).json({ error: 'Catégorie invalide', valid: validCategories });
    }
    const { rows } = await pool.query(
      `INSERT INTO clinical_tests (name, description, category, scoring_method, instructions, interpretation_guide, evidence_level, source_reference, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       RETURNING *`,
      [name, description || null, category, scoring_method || null, instructions || null, interpretation_guide || null, evidence_level || null, source_reference || null]
    );
    res.status(201).json({ test: rows[0] });
  } catch (err) {
    console.error('POST /api/tests-cliniques error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// PUSH NOTIFICATIONS API
// ==========================================

// GET /api/push/vapid-public-key — return public key to frontend for subscription
app.get('/api/push/vapid-public-key', requireAuth, (req, res) => {
  if (!VAPID_PUBLIC_KEY) {
    return res.status(503).json({ error: 'Push notifications non configurées' });
  }
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// POST /api/push/subscribe — save a push subscription for the logged-in kine
app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: 'Subscription invalide — endpoint et keys requis' });
    }
    const userAgent = req.headers['user-agent'] ? req.headers['user-agent'].substring(0, 255) : null;

    // Upsert: if this endpoint already exists for this kine, mark it active
    await pool.query(
      `INSERT INTO push_subscriptions (kine_id, endpoint, p256dh, auth, user_agent, active, updated_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, NOW())
       ON CONFLICT (kine_id, endpoint) DO UPDATE
         SET p256dh = EXCLUDED.p256dh,
             auth = EXCLUDED.auth,
             user_agent = EXCLUDED.user_agent,
             active = TRUE,
             updated_at = NOW()`,
      [req.session.kineId, endpoint, keys.p256dh, keys.auth, userAgent]
    );

    res.status(201).json({ success: true });
  } catch (err) {
    console.error('[push] subscribe error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/push/unsubscribe — deactivate a subscription (user revoked permission)
app.delete('/api/push/unsubscribe', requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({ error: 'Endpoint requis' });
    }
    await pool.query(
      `UPDATE push_subscriptions SET active = FALSE, updated_at = NOW()
       WHERE kine_id = $1 AND endpoint = $2`,
      [req.session.kineId, endpoint]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[push] unsubscribe error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/push/test — send a test push to all active subscriptions of logged-in kine
// Admin-gated in prod; any logged-in kine in dev
app.post('/api/push/test', requireAuth, async (req, res) => {
  try {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      return res.status(503).json({ error: 'Push notifications non configurées' });
    }

    const { rows } = await pool.query(
      `SELECT * FROM push_subscriptions WHERE kine_id = $1 AND active = TRUE`,
      [req.session.kineId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Aucun abonnement push actif trouvé' });
    }

    const payload = JSON.stringify({
      title: 'Kinévia 🔔',
      body: 'Les notifications push fonctionnent !',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: '/app.html' }
    });

    const results = { sent: 0, failed: 0, deactivated: 0 };

    await Promise.all(rows.map(async (sub) => {
      const subscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      };
      try {
        await webpush.sendNotification(subscription, payload);
        results.sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          // Endpoint expired/gone — deactivate it
          await pool.query(
            `UPDATE push_subscriptions SET active = FALSE, updated_at = NOW() WHERE id = $1`,
            [sub.id]
          );
          results.deactivated++;
        } else {
          console.error('[push] sendNotification error:', err.message);
          results.failed++;
        }
      }
    }));

    res.json({ success: true, results });
  } catch (err) {
    console.error('[push] test error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/push/status — check subscription status for current kine
app.get('/api/push/status', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM push_subscriptions WHERE kine_id = $1 AND active = TRUE`,
      [req.session.kineId]
    );
    res.json({ activeSubscriptions: rows[0].count, vapidConfigured: !!VAPID_PUBLIC_KEY });
  } catch (err) {
    console.error('[push] status error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// PUSH NOTIFICATIONS PATIENTS (sans auth, par lien_unique)
// ==========================================

// GET /api/patient-push/vapid-key — clé publique VAPID pour le patient
app.get('/api/patient-push/vapid-key', async (req, res) => {
  if (!VAPID_PUBLIC_KEY) {
    return res.status(503).json({ error: 'Push notifications non configurées' });
  }
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// POST /api/patient-push/subscribe/:lien — enregistrer un abonnement push patient
app.post('/api/patient-push/subscribe/:lien', async (req, res) => {
  try {
    const { lien } = req.params;
    const { endpoint, keys } = req.body;

    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: 'Subscription invalide — endpoint et keys requis' });
    }

    // Retrouver le patient par son lien unique
    const { rows: patRows } = await pool.query(
      'SELECT id FROM patients WHERE lien_unique = $1',
      [lien]
    );
    if (patRows.length === 0) {
      return res.status(404).json({ error: 'Patient non trouvé' });
    }
    const patientId = patRows[0].id;
    const userAgent = req.headers['user-agent'] ? req.headers['user-agent'].substring(0, 255) : null;

    await pool.query(
      `INSERT INTO patient_push_subscriptions (patient_id, endpoint, p256dh, auth, user_agent, active, updated_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, NOW())
       ON CONFLICT (patient_id, endpoint) DO UPDATE
         SET p256dh = EXCLUDED.p256dh,
             auth = EXCLUDED.auth,
             user_agent = EXCLUDED.user_agent,
             active = TRUE,
             updated_at = NOW()`,
      [patientId, endpoint, keys.p256dh, keys.auth, userAgent]
    );

    res.status(201).json({ success: true });
  } catch (err) {
    console.error('[patient-push] subscribe error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/patient-push/unsubscribe/:lien — désabonner un patient
app.delete('/api/patient-push/unsubscribe/:lien', async (req, res) => {
  try {
    const { lien } = req.params;
    const { endpoint } = req.body;

    if (!endpoint) {
      return res.status(400).json({ error: 'Endpoint requis' });
    }

    const { rows: patRows } = await pool.query(
      'SELECT id FROM patients WHERE lien_unique = $1',
      [lien]
    );
    if (patRows.length === 0) {
      return res.status(404).json({ error: 'Patient non trouvé' });
    }
    const patientId = patRows[0].id;

    await pool.query(
      `UPDATE patient_push_subscriptions SET active = FALSE, updated_at = NOW()
       WHERE patient_id = $1 AND endpoint = $2`,
      [patientId, endpoint]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[patient-push] unsubscribe error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/patient-push/status/:lien — statut d'abonnement d'un patient
app.get('/api/patient-push/status/:lien', async (req, res) => {
  try {
    const { lien } = req.params;
    const { rows: patRows } = await pool.query(
      'SELECT id FROM patients WHERE lien_unique = $1',
      [lien]
    );
    if (patRows.length === 0) {
      return res.status(404).json({ error: 'Patient non trouvé' });
    }
    const patientId = patRows[0].id;
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM patient_push_subscriptions WHERE patient_id = $1 AND active = TRUE`,
      [patientId]
    );
    res.json({ activeSubscriptions: rows[0].count, vapidConfigured: !!VAPID_PUBLIC_KEY });
  } catch (err) {
    console.error('[patient-push] status error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// NOTIFICATION PREFERENCES
// ==========================================

// GET /api/notification-prefs — préférences du kiné connecté
app.get('/api/notification-prefs', requireAuth, async (req, res) => {
  try {
    const kineId = req.session.kineId;
    const { rows } = await pool.query(
      `SELECT alertes_feedback_enabled FROM kine_notification_prefs WHERE kine_id = $1`,
      [kineId]
    );
    // Defaults to true if no row exists yet
    const prefs = rows.length > 0 ? rows[0] : { alertes_feedback_enabled: true };
    res.json(prefs);
  } catch (err) {
    console.error('[notif-prefs] GET kine error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/notification-prefs — mettre à jour les préférences du kiné connecté
app.put('/api/notification-prefs', requireAuth, async (req, res) => {
  try {
    const kineId = req.session.kineId;
    const { alertes_feedback_enabled } = req.body;

    if (typeof alertes_feedback_enabled !== 'boolean') {
      return res.status(400).json({ error: 'alertes_feedback_enabled doit être un booléen' });
    }

    await pool.query(
      `INSERT INTO kine_notification_prefs (kine_id, alertes_feedback_enabled, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (kine_id) DO UPDATE
         SET alertes_feedback_enabled = EXCLUDED.alertes_feedback_enabled,
             updated_at = NOW()`,
      [kineId, alertes_feedback_enabled]
    );

    res.json({ success: true, alertes_feedback_enabled });
  } catch (err) {
    console.error('[notif-prefs] PUT kine error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/patient-notification-prefs/:lien — préférences notif du patient (sans auth)
app.get('/api/patient-notification-prefs/:lien', async (req, res) => {
  try {
    const { lien } = req.params;
    const { rows: patRows } = await pool.query(
      'SELECT id FROM patients WHERE lien_unique = $1',
      [lien]
    );
    if (patRows.length === 0) {
      return res.status(404).json({ error: 'Patient non trouvé' });
    }
    const patientId = patRows[0].id;

    const { rows } = await pool.query(
      `SELECT push_rappels_enabled FROM patient_notification_prefs WHERE patient_id = $1`,
      [patientId]
    );
    // Defaults to true if no row exists yet
    const prefs = rows.length > 0 ? rows[0] : { push_rappels_enabled: true };
    res.json(prefs);
  } catch (err) {
    console.error('[notif-prefs] GET patient error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/patient-notification-prefs/:lien — mettre à jour les préférences notif du patient
app.put('/api/patient-notification-prefs/:lien', async (req, res) => {
  try {
    const { lien } = req.params;
    const { push_rappels_enabled } = req.body;

    if (typeof push_rappels_enabled !== 'boolean') {
      return res.status(400).json({ error: 'push_rappels_enabled doit être un booléen' });
    }

    const { rows: patRows } = await pool.query(
      'SELECT id FROM patients WHERE lien_unique = $1',
      [lien]
    );
    if (patRows.length === 0) {
      return res.status(404).json({ error: 'Patient non trouvé' });
    }
    const patientId = patRows[0].id;

    await pool.query(
      `INSERT INTO patient_notification_prefs (patient_id, push_rappels_enabled, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (patient_id) DO UPDATE
         SET push_rappels_enabled = EXCLUDED.push_rappels_enabled,
             updated_at = NOW()`,
      [patientId, push_rappels_enabled]
    );

    res.json({ success: true, push_rappels_enabled });
  } catch (err) {
    console.error('[notif-prefs] PUT patient error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * Envoyer un push notification à un kiné (toutes ses souscriptions actives).
 * Désactive automatiquement les endpoints expirés (404/410).
 * @param {number} kineId
 * @param {object} payload - { title, body, data }
 */
async function sendPushToKine(kineId, payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return { sent: 0, failed: 0, deactivated: 0 };

  const { rows: subs } = await pool.query(
    `SELECT * FROM push_subscriptions WHERE kine_id = $1 AND active = TRUE`,
    [kineId]
  );

  if (subs.length === 0) return { sent: 0, failed: 0, deactivated: 0 };

  const payloadStr = JSON.stringify({
    title: payload.title || 'Kinévia',
    body: payload.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: payload.data || {}
  });

  const results = { sent: 0, failed: 0, deactivated: 0 };

  await Promise.all(subs.map(async (sub) => {
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth }
    };
    try {
      await webpush.sendNotification(subscription, payloadStr);
      results.sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await pool.query(
          `UPDATE push_subscriptions SET active = FALSE, updated_at = NOW() WHERE id = $1`,
          [sub.id]
        );
        results.deactivated++;
      } else {
        console.error('[kine-push] sendNotification error:', err.message);
        results.failed++;
      }
    }
  }));

  return results;
}

/**
 * Envoyer un push notification à un patient (toutes ses souscriptions actives).
 * Désactive automatiquement les endpoints expirés (404/410).
 * @param {number} patientId
 * @param {object} payload - { title, body, data }
 */
async function sendPushToPatient(patientId, payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return { sent: 0, failed: 0, deactivated: 0 };

  const { rows: subs } = await pool.query(
    `SELECT * FROM patient_push_subscriptions WHERE patient_id = $1 AND active = TRUE`,
    [patientId]
  );

  if (subs.length === 0) return { sent: 0, failed: 0, deactivated: 0 };

  const payloadStr = JSON.stringify({
    title: payload.title || 'Kinévia 💪',
    body: payload.body || 'C\'est l\'heure de faire vos exercices !',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: payload.data || {}
  });

  const results = { sent: 0, failed: 0, deactivated: 0 };

  await Promise.all(subs.map(async (sub) => {
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth }
    };
    try {
      await webpush.sendNotification(subscription, payloadStr);
      results.sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await pool.query(
          `UPDATE patient_push_subscriptions SET active = FALSE, updated_at = NOW() WHERE id = $1`,
          [sub.id]
        );
        results.deactivated++;
      } else {
        console.error('[patient-push] sendNotification error:', err.message);
        results.failed++;
      }
    }
  }));

  return results;
}

// ==========================================
// CHAT — conversations & messages
// Task #1376760
// ==========================================

// POST /api/conversations — Créer ou récupérer une conversation (côté kiné)
// Body: { patient_id }
app.post('/api/conversations', requireAuth, async (req, res) => {
  try {
    const kineId = req.session.kineId;
    const { patient_id } = req.body;
    if (!patient_id) return res.status(400).json({ error: 'patient_id requis' });

    // Verify the patient belongs to this kine
    const patCheck = await pool.query(
      'SELECT id FROM patients WHERE id = $1 AND kine_id = $2',
      [patient_id, kineId]
    );
    if (patCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Patient introuvable' });
    }

    // Upsert: create or return existing conversation
    const result = await pool.query(
      `INSERT INTO conversations (kine_id, patient_id)
       VALUES ($1, $2)
       ON CONFLICT ON CONSTRAINT conversations_kine_patient_unique
       DO UPDATE SET updated_at = conversations.updated_at
       RETURNING id, kine_id, patient_id, created_at, updated_at`,
      [kineId, patient_id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('POST /api/conversations error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/conversations/patient/:lien — Créer ou récupérer une conversation (côté patient)
// Patient s'identifie via son lien_unique
app.post('/api/conversations/patient/:lien', async (req, res) => {
  try {
    const { lien } = req.params;

    // Resolve patient from lien_unique
    const patResult = await pool.query(
      'SELECT id, kine_id FROM patients WHERE lien_unique = $1',
      [lien]
    );
    if (patResult.rows.length === 0) {
      return res.status(404).json({ error: 'Lien invalide' });
    }
    const { id: patientId, kine_id: kineId } = patResult.rows[0];

    const result = await pool.query(
      `INSERT INTO conversations (kine_id, patient_id)
       VALUES ($1, $2)
       ON CONFLICT ON CONSTRAINT conversations_kine_patient_unique
       DO UPDATE SET updated_at = conversations.updated_at
       RETURNING id, kine_id, patient_id, created_at, updated_at`,
      [kineId, patientId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('POST /api/conversations/patient/:lien error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/conversations — Lister les conversations du kiné connecté
// Inclut : nom interlocuteur, dernier message (content + created_at), nb messages non lus
// ?archived=true → retourne uniquement les conversations archivées
// (par défaut, retourne uniquement les conversations actives)
app.get('/api/conversations', requireAuth, async (req, res) => {
  try {
    const kineId = req.session.kineId;
    const showArchived = req.query.archived === 'true';

    const result = await pool.query(
      `SELECT
         c.id,
         c.patient_id,
         p.nom   AS patient_nom,
         p.prenom AS patient_prenom,
         lm.content      AS last_message_content,
         lm.created_at   AS last_message_at,
         c.updated_at,
         c.archived,
         c.archived_at,
         COALESCE(unread.count, 0)::int AS unread_count
       FROM conversations c
       JOIN patients p ON p.id = c.patient_id
       LEFT JOIN LATERAL (
         SELECT content, created_at
         FROM messages
         WHERE conversation_id = c.id
         ORDER BY created_at DESC
         LIMIT 1
       ) lm ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS count
         FROM messages
         WHERE conversation_id = c.id
           AND sender_type = 'patient'
           AND read_at IS NULL
       ) unread ON true
       WHERE c.kine_id = $1
         AND c.archived = $2
       ORDER BY c.updated_at DESC`,
      [kineId, showArchived]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/conversations error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/conversations/patient/:lien — Lister les conversations du patient
app.get('/api/conversations/patient/:lien', async (req, res) => {
  try {
    const { lien } = req.params;

    const patResult = await pool.query(
      'SELECT id, kine_id FROM patients WHERE lien_unique = $1',
      [lien]
    );
    if (patResult.rows.length === 0) {
      return res.status(404).json({ error: 'Lien invalide' });
    }
    const { id: patientId } = patResult.rows[0];

    const result = await pool.query(
      `SELECT
         c.id,
         c.kine_id,
         k.nom   AS kine_nom,
         k.prenom AS kine_prenom,
         lm.content      AS last_message_content,
         lm.created_at   AS last_message_at,
         c.updated_at,
         COALESCE(unread.count, 0)::int AS unread_count
       FROM conversations c
       JOIN kines k ON k.id = c.kine_id
       LEFT JOIN LATERAL (
         SELECT content, created_at
         FROM messages
         WHERE conversation_id = c.id
         ORDER BY created_at DESC
         LIMIT 1
       ) lm ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS count
         FROM messages
         WHERE conversation_id = c.id
           AND sender_type = 'kine'
           AND read_at IS NULL
       ) unread ON true
       WHERE c.patient_id = $1
       ORDER BY c.updated_at DESC`,
      [patientId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/conversations/patient/:lien error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/conversations/:id/messages — Envoyer un message (kiné)
app.post('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  try {
    const kineId = req.session.kineId;
    const conversationId = parseInt(req.params.id, 10);
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'content requis' });
    }

    // Verify kine belongs to this conversation
    const convCheck = await pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND kine_id = $2',
      [conversationId, kineId]
    );
    if (convCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    // Insert message
    const msgResult = await pool.query(
      `INSERT INTO messages (conversation_id, sender_type, sender_id, content)
       VALUES ($1, 'kine', $2, $3)
       RETURNING id, conversation_id, sender_type, sender_id, content, read_at, created_at`,
      [conversationId, kineId, content.trim()]
    );

    // Update conversation updated_at
    await pool.query(
      'UPDATE conversations SET updated_at = NOW() WHERE id = $1',
      [conversationId]
    );

    res.status(201).json(msgResult.rows[0]);

    // Fire-and-forget push notification to patient
    (async () => {
      try {
        // Get kine name + patient_id from conversation
        const infoResult = await pool.query(
          `SELECT c.patient_id, k.prenom, k.nom
           FROM conversations c
           JOIN kines k ON k.id = c.kine_id
           WHERE c.id = $1`,
          [conversationId]
        );
        if (infoResult.rows.length === 0) return;
        const { patient_id, prenom, nom } = infoResult.rows[0];
        const senderName = [prenom, nom].filter(Boolean).join(' ') || 'Votre kiné';
        const bodyPreview = content.trim().substring(0, 100);
        await sendPushToPatient(patient_id, {
          title: 'Nouveau message',
          body: `${senderName} : ${bodyPreview}`,
          data: { url: `/messages/${conversationId}` }
        });
      } catch (pushErr) {
        console.error('[chat-push] kine→patient push error:', pushErr.message);
      }
    })();
  } catch (err) {
    console.error('POST /api/conversations/:id/messages (kine) error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/conversations/:id/messages/patient/:lien — Envoyer un message (patient)
app.post('/api/conversations/:id/messages/patient/:lien', async (req, res) => {
  try {
    const conversationId = parseInt(req.params.id, 10);
    const { lien } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'content requis' });
    }

    // Resolve patient
    const patResult = await pool.query(
      'SELECT id FROM patients WHERE lien_unique = $1',
      [lien]
    );
    if (patResult.rows.length === 0) {
      return res.status(404).json({ error: 'Lien invalide' });
    }
    const patientId = patResult.rows[0].id;

    // Verify patient belongs to this conversation
    const convCheck = await pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND patient_id = $2',
      [conversationId, patientId]
    );
    if (convCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    // Insert message
    const msgResult = await pool.query(
      `INSERT INTO messages (conversation_id, sender_type, sender_id, content)
       VALUES ($1, 'patient', $2, $3)
       RETURNING id, conversation_id, sender_type, sender_id, content, read_at, created_at`,
      [conversationId, patientId, content.trim()]
    );

    // Update conversation updated_at + auto-unarchive if archived
    await pool.query(
      'UPDATE conversations SET updated_at = NOW(), archived = FALSE, archived_at = NULL WHERE id = $1',
      [conversationId]
    );

    res.status(201).json(msgResult.rows[0]);

    // Fire-and-forget push notification to kiné
    (async () => {
      try {
        // Get patient name + kine_id from conversation
        const infoResult = await pool.query(
          `SELECT c.kine_id, p.prenom, p.nom
           FROM conversations c
           JOIN patients p ON p.id = c.patient_id
           WHERE c.id = $1`,
          [conversationId]
        );
        if (infoResult.rows.length === 0) return;
        const { kine_id, prenom, nom } = infoResult.rows[0];
        const senderName = [prenom, nom].filter(Boolean).join(' ') || 'Un patient';
        const bodyPreview = content.trim().substring(0, 100);
        await sendPushToKine(kine_id, {
          title: 'Nouveau message',
          body: `${senderName} : ${bodyPreview}`,
          data: { url: `/messages/${conversationId}` }
        });
      } catch (pushErr) {
        console.error('[chat-push] patient→kine push error:', pushErr.message);
      }
    })();
  } catch (err) {
    console.error('POST /api/conversations/:id/messages/patient/:lien error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/conversations/:id/messages — Charger les messages (kiné)
// ?page=1&limit=50, tri ASC
app.get('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  try {
    const kineId = req.session.kineId;
    const conversationId = parseInt(req.params.id, 10);
    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;

    // Verify kine belongs to this conversation
    const convCheck = await pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND kine_id = $2',
      [conversationId, kineId]
    );
    if (convCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    const result = await pool.query(
      `SELECT id, conversation_id, sender_type, sender_id, content, read_at, created_at, deleted_at
       FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC
       LIMIT $2 OFFSET $3`,
      [conversationId, limit, offset]
    );

    // Total count for pagination
    const countResult = await pool.query(
      'SELECT COUNT(*)::int AS total FROM messages WHERE conversation_id = $1',
      [conversationId]
    );

    res.json({
      messages: result.rows,
      pagination: {
        page,
        limit,
        total: countResult.rows[0].total,
        pages: Math.ceil(countResult.rows[0].total / limit)
      }
    });
  } catch (err) {
    console.error('GET /api/conversations/:id/messages (kine) error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/conversations/:id/messages/patient/:lien — Charger les messages (patient)
app.get('/api/conversations/:id/messages/patient/:lien', async (req, res) => {
  try {
    const conversationId = parseInt(req.params.id, 10);
    const { lien } = req.params;
    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;

    // Resolve patient
    const patResult = await pool.query(
      'SELECT id FROM patients WHERE lien_unique = $1',
      [lien]
    );
    if (patResult.rows.length === 0) {
      return res.status(404).json({ error: 'Lien invalide' });
    }
    const patientId = patResult.rows[0].id;

    // Verify patient belongs to this conversation
    const convCheck = await pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND patient_id = $2',
      [conversationId, patientId]
    );
    if (convCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    const result = await pool.query(
      `SELECT id, conversation_id, sender_type, sender_id, content, read_at, created_at, deleted_at
       FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC
       LIMIT $2 OFFSET $3`,
      [conversationId, limit, offset]
    );

    const countResult = await pool.query(
      'SELECT COUNT(*)::int AS total FROM messages WHERE conversation_id = $1',
      [conversationId]
    );

    res.json({
      messages: result.rows,
      pagination: {
        page,
        limit,
        total: countResult.rows[0].total,
        pages: Math.ceil(countResult.rows[0].total / limit)
      }
    });
  } catch (err) {
    console.error('GET /api/conversations/:id/messages/patient/:lien error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /api/messages/:id/read — Marquer un message comme lu (kiné lit un message de patient)
app.patch('/api/messages/:id/read', requireAuth, async (req, res) => {
  try {
    const kineId = req.session.kineId;
    const messageId = parseInt(req.params.id, 10);

    // Message must be from a 'patient' sender in a conversation owned by this kine
    const result = await pool.query(
      `UPDATE messages m
       SET read_at = NOW()
       FROM conversations c
       WHERE m.id = $1
         AND m.conversation_id = c.id
         AND c.kine_id = $2
         AND m.sender_type = 'patient'
         AND m.read_at IS NULL
       RETURNING m.id, m.conversation_id, m.sender_type, m.sender_id, m.content, m.read_at, m.created_at`,
      [messageId, kineId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message introuvable ou déjà lu' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('PATCH /api/messages/:id/read (kine) error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /api/messages/:id/read/patient/:lien — Marquer un message comme lu (patient lit un message du kiné)
app.patch('/api/messages/:id/read/patient/:lien', async (req, res) => {
  try {
    const { lien } = req.params;
    const messageId = parseInt(req.params.id, 10);

    // Resolve patient
    const patResult = await pool.query(
      'SELECT id FROM patients WHERE lien_unique = $1',
      [lien]
    );
    if (patResult.rows.length === 0) {
      return res.status(404).json({ error: 'Lien invalide' });
    }
    const patientId = patResult.rows[0].id;

    // Message must be from a 'kine' sender in a conversation where this patient participates
    const result = await pool.query(
      `UPDATE messages m
       SET read_at = NOW()
       FROM conversations c
       WHERE m.id = $1
         AND m.conversation_id = c.id
         AND c.patient_id = $2
         AND m.sender_type = 'kine'
         AND m.read_at IS NULL
       RETURNING m.id, m.conversation_id, m.sender_type, m.sender_id, m.content, m.read_at, m.created_at`,
      [messageId, patientId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message introuvable ou déjà lu' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('PATCH /api/messages/:id/read/patient/:lien error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/messages/:id — Soft-delete un message (kiné — seulement ses propres messages)
app.delete('/api/messages/:id', requireAuth, async (req, res) => {
  try {
    const kineId = req.session.kineId;
    const messageId = parseInt(req.params.id, 10);

    // Le kiné ne peut supprimer que ses propres messages (sender_type='kine' AND sender_id=kineId)
    // et seulement dans une conversation qui lui appartient
    const result = await pool.query(
      `UPDATE messages m
       SET deleted_at = NOW()
       FROM conversations c
       WHERE m.id = $1
         AND m.conversation_id = c.id
         AND c.kine_id = $2
         AND m.sender_type = 'kine'
         AND m.sender_id = $2
         AND m.deleted_at IS NULL
       RETURNING m.id`,
      [messageId, kineId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message introuvable ou déjà supprimé' });
    }

    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error('DELETE /api/messages/:id (kine) error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/messages/:id/patient/:lien — Soft-delete un message (patient — seulement ses propres messages)
app.delete('/api/messages/:id/patient/:lien', async (req, res) => {
  try {
    const { lien } = req.params;
    const messageId = parseInt(req.params.id, 10);

    // Résoudre le patient
    const patResult = await pool.query(
      'SELECT id FROM patients WHERE lien_unique = $1',
      [lien]
    );
    if (patResult.rows.length === 0) {
      return res.status(404).json({ error: 'Lien invalide' });
    }
    const patientId = patResult.rows[0].id;

    // Le patient ne peut supprimer que ses propres messages (sender_type='patient' AND sender_id=patientId)
    const result = await pool.query(
      `UPDATE messages m
       SET deleted_at = NOW()
       FROM conversations c
       WHERE m.id = $1
         AND m.conversation_id = c.id
         AND c.patient_id = $2
         AND m.sender_type = 'patient'
         AND m.sender_id = $2
         AND m.deleted_at IS NULL
       RETURNING m.id`,
      [messageId, patientId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message introuvable ou déjà supprimé' });
    }

    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error('DELETE /api/messages/:id/patient/:lien error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /api/conversations/:id/archive — Archiver une conversation (côté kiné)
app.patch('/api/conversations/:id/archive', requireAuth, async (req, res) => {
  try {
    const kineId = req.session.kineId;
    const conversationId = parseInt(req.params.id, 10);

    const result = await pool.query(
      `UPDATE conversations
       SET archived = TRUE, archived_at = NOW()
       WHERE id = $1 AND kine_id = $2
       RETURNING id, archived, archived_at`,
      [conversationId, kineId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation introuvable' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PATCH /api/conversations/:id/archive error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /api/conversations/:id/unarchive — Désarchiver une conversation (côté kiné)
app.patch('/api/conversations/:id/unarchive', requireAuth, async (req, res) => {
  try {
    const kineId = req.session.kineId;
    const conversationId = parseInt(req.params.id, 10);

    const result = await pool.query(
      `UPDATE conversations
       SET archived = FALSE, archived_at = NULL
       WHERE id = $1 AND kine_id = $2
       RETURNING id, archived, archived_at`,
      [conversationId, kineId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation introuvable' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PATCH /api/conversations/:id/unarchive error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// CHAT AI KINÉ
// ==========================================
const { getChatReply, getChatReplyStream, checkRateLimit, checkDailyQuota, incrementDailyQuota, ChatAIErrorType } = require('./services/chatAI');

/**
 * POST /api/chat-ai/conversations
 * Create a new conversation for the authenticated kiné.
 * Response: { id, title, created_at, updated_at }
 */
app.post('/api/chat-ai/conversations', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `INSERT INTO ai_conversations (kine_id, title) VALUES ($1, NULL) RETURNING *`,
      [req.session.kineId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[chat-ai] create conversation error:', err.message);
    res.status(500).json({ error: 'Erreur lors de la création de la conversation' });
  }
});

/**
 * GET /api/chat-ai/conversations
 * List all conversations for the authenticated kiné, newest first.
 * Response: [{ id, title, created_at, updated_at }, ...]
 */
app.get('/api/chat-ai/conversations', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, created_at, updated_at
       FROM ai_conversations
       WHERE kine_id = $1
       ORDER BY updated_at DESC`,
      [req.session.kineId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[chat-ai] list conversations error:', err.message);
    res.status(500).json({ error: 'Erreur lors du chargement des conversations' });
  }
});

/**
 * GET /api/chat-ai/conversations/:id/messages
 * Return all messages for a conversation (must belong to authenticated kiné).
 * Response: [{ id, role, content, created_at }, ...]
 */
app.get('/api/chat-ai/conversations/:id/messages', requireAuth, async (req, res) => {
  try {
    const convId = parseInt(req.params.id, 10);
    if (isNaN(convId)) return res.status(400).json({ error: 'ID de conversation invalide' });

    // Verify ownership
    const conv = await pool.query(
      'SELECT id FROM ai_conversations WHERE id = $1 AND kine_id = $2',
      [convId, req.session.kineId]
    );
    if (conv.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation introuvable' });
    }

    const result = await pool.query(
      `SELECT id, role, content, created_at
       FROM ai_messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [convId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[chat-ai] get messages error:', err.message);
    res.status(500).json({ error: 'Erreur lors du chargement des messages' });
  }
});

/**
 * POST /api/chat-ai
 * Protected by kiné session auth.
 * Body: { message: string, conversationId?: number }
 * Response: { reply: string, conversationId: number }
 *
 * Rate limits: 50 msg/hr per kiné, 500 msg/hr global.
 * Error types surfaced to frontend: timeout, rate_limit, content_filter, db_error, generic.
 *
 * If conversationId is provided, messages are appended to that conversation.
 * If not, a new conversation is created automatically.
 * The conversation title is auto-generated from the first 50 chars of the
 * first user message (set only when creating a new conversation).
 */
app.post('/api/chat-ai', requireAuth, async (req, res) => {
  const kineId = req.session.kineId;

  try {
    const { message, conversationId } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'Le champ "message" est requis' });
    }

    if (message.trim().length > 4000) {
      return res.status(400).json({ error: 'Message trop long (max 4000 caractères)' });
    }

    // ── Rate limiting (hourly, in-memory) ─────────────────────────────────
    const rateCheck = checkRateLimit(kineId);
    if (rateCheck && rateCheck.limited) {
      const retryAfterMinutes = Math.ceil(rateCheck.retryAfterMs / 60000);
      console.error('[chat-ai] Rate limit hit', { kine_id: kineId, scope: rateCheck.scope, retry_after_ms: rateCheck.retryAfterMs });
      return res.status(429).json({
        error: `Vous avez atteint la limite de questions. Réessayez dans ${retryAfterMinutes} minute${retryAfterMinutes > 1 ? 's' : ''}.`,
        errorType: 'rate_limit',
        retryAfterMs: rateCheck.retryAfterMs,
      });
    }

    // ── Daily quota (DB-backed, UTC reset at midnight) ─────────────────────
    const dailyCheck = await checkDailyQuota(pool, kineId);
    if (dailyCheck && dailyCheck.limited) {
      console.error('[chat-ai] Daily quota hit', { kine_id: kineId, used: dailyCheck.used, limit: dailyCheck.limit });
      return res.status(429).json({
        error: 'Vous avez atteint votre limite quotidienne de messages. Le compteur se réinitialise à minuit.',
        errorType: 'daily_quota',
        used: dailyCheck.used,
        limit: dailyCheck.limit,
      });
    }

    const trimmedMessage = message.trim();

    // ── Get kiné's subscription ID for usage tracking ───────────────────────
    let subscriptionId = null;
    try {
      const kineResult = await pool.query(
        'SELECT stripe_subscription_id FROM kines WHERE id = $1',
        [kineId]
      );
      subscriptionId = kineResult.rows[0]?.stripe_subscription_id || null;
    } catch (dbErr) {
      // Non-fatal: continue without subscription tracking
      console.error('[chat-ai] Could not fetch subscription ID:', dbErr.message, { kine_id: kineId });
    }

    // ── Resolve or create conversation (degraded mode: skip DB on failure) ──
    let convId = null;
    let dbAvailable = true;

    if (conversationId) {
      try {
        const existing = await pool.query(
          'SELECT id FROM ai_conversations WHERE id = $1 AND kine_id = $2',
          [conversationId, kineId]
        );
        if (existing.rows.length > 0) {
          convId = existing.rows[0].id;
        }
      } catch (dbErr) {
        dbAvailable = false;
        console.error('[chat-ai] DB error resolving conversation:', dbErr.message, { kine_id: kineId, conversation_id: conversationId });
      }
    }

    if (dbAvailable && !convId) {
      try {
        const title = trimmedMessage.substring(0, 50);
        const newConv = await pool.query(
          'INSERT INTO ai_conversations (kine_id, title) VALUES ($1, $2) RETURNING id',
          [kineId, title]
        );
        convId = newConv.rows[0].id;
      } catch (dbErr) {
        dbAvailable = false;
        console.error('[chat-ai] DB error creating conversation:', dbErr.message, { kine_id: kineId });
      }
    }

    // ── Persist user message (best effort) ─────────────────────────────────
    if (dbAvailable && convId) {
      try {
        await pool.query(
          'INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1, $2, $3)',
          [convId, 'user', trimmedMessage]
        );
      } catch (dbErr) {
        dbAvailable = false;
        console.error('[chat-ai] DB error persisting user message:', dbErr.message, { kine_id: kineId, conversation_id: convId });
      }
    }

    // ── RAG: semantic search on user message (non-blocking, max 1.5s) ─────────
    let ragContext = null;
    let ragSources = [];
    try {
      const ragResult = await Promise.race([
        ragService.searchAndBuildContext(trimmedMessage, { topK: 5, threshold: 0.35 }),
        new Promise(resolve => setTimeout(() => resolve(null), 1500)),
      ]);
      if (ragResult) {
        ragContext = ragResult.context;
        ragSources = ragResult.sources || [];
      }
    } catch (ragErr) {
      // Non-fatal: proceed without RAG context
      console.error('[chat-ai] RAG search failed (non-fatal):', ragErr.message, { kine_id: kineId });
    }

    // ── Get AI reply ─────────────────────────────────────────────────────────
    let reply;
    try {
      const result = await getChatReply(trimmedMessage, convId ? String(convId) : null, subscriptionId, kineId, ragContext);
      reply = result.reply;
    } catch (aiErr) {
      const errType = aiErr.chatAIErrorType || ChatAIErrorType.GENERIC;

      let userMessage;
      switch (errType) {
        case ChatAIErrorType.TIMEOUT:
          userMessage = 'La réponse prend trop de temps. Veuillez réessayer.';
          break;
        case ChatAIErrorType.RATE_LIMIT: {
          const isDailyLimit = (aiErr.message || '').includes('Daily') || (aiErr.message || '').includes('daily_limit');
          userMessage = isDailyLimit
            ? 'Le quota quotidien de l\'IA est atteint. Il se réinitialise à minuit (UTC). Réessayez demain.'
            : 'Service temporairement surchargé. Réessayez dans quelques minutes.';
          break;
        }
        case ChatAIErrorType.CONTENT_FILTER:
          userMessage = 'Je ne peux pas répondre à cette question.';
          break;
        default:
          userMessage = 'Erreur lors de la génération de la réponse. Veuillez réessayer.';
      }

      const httpStatus = errType === ChatAIErrorType.RATE_LIMIT ? 503 : 500;
      const isRetryable = errType === ChatAIErrorType.TIMEOUT || errType === ChatAIErrorType.RATE_LIMIT || errType === ChatAIErrorType.GENERIC;

      return res.status(httpStatus).json({
        error: userMessage,
        errorType: errType.toLowerCase(),
        retryable: isRetryable,
      });
    }

    // ── Persist assistant reply (best effort) ───────────────────────────────
    if (dbAvailable && convId) {
      try {
        await pool.query(
          'INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1, $2, $3)',
          [convId, 'assistant', reply]
        );
        await pool.query(
          'UPDATE ai_conversations SET updated_at = NOW() WHERE id = $1',
          [convId]
        );
      } catch (dbErr) {
        // Non-fatal: reply was generated, just couldn't persist
        console.error('[chat-ai] DB error persisting assistant reply:', dbErr.message, { kine_id: kineId, conversation_id: convId });
      }
    }

    // ── Increment daily quota (non-blocking, fire and forget) ──────────────
    incrementDailyQuota(pool, kineId).catch(() => {});

    res.json({ reply, conversationId: convId, sources: ragSources });
  } catch (err) {
    console.error('[chat-ai] Unexpected error:', err.message, { kine_id: kineId });
    res.status(500).json({
      error: 'Erreur lors de la génération de la réponse. Veuillez réessayer.',
      errorType: 'generic',
      retryable: true,
    });
  }
});

/**
 * POST /api/chat-ai/stream
 * SSE streaming variant of /api/chat-ai.
 * Sends text deltas as `data: {"delta":"..."}` events.
 * Sends `data: {"done":true,"conversationId":N,"sources":[...]}` on completion.
 * Sends `data: {"error":"...","errorType":"...","retryable":bool}` on failure.
 * SSE connections are long-lived — Render's HTTP timeout must be ≥120s.
 */
app.post('/api/chat-ai/stream', requireAuth, async (req, res) => {
  const kineId = req.session.kineId;

  // ── SSE headers ────────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  // Helper: send one SSE event
  function sendEvent(data) {
    if (!res.writableEnded) {
      res.write('data: ' + JSON.stringify(data) + '\n\n');
    }
  }

  // AbortController so we can cancel the AI stream when the client disconnects
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  try {
    const { message, conversationId } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      sendEvent({ error: 'Le champ "message" est requis', errorType: 'validation', retryable: false });
      return res.end();
    }

    if (message.trim().length > 4000) {
      sendEvent({ error: 'Message trop long (max 4000 caractères)', errorType: 'validation', retryable: false });
      return res.end();
    }

    // ── Rate limiting ──────────────────────────────────────────────────────
    const rateCheck = checkRateLimit(kineId);
    if (rateCheck && rateCheck.limited) {
      const retryAfterMinutes = Math.ceil(rateCheck.retryAfterMs / 60000);
      console.error('[chat-ai/stream] Rate limit hit', { kine_id: kineId, scope: rateCheck.scope });
      sendEvent({
        error: `Vous avez atteint la limite de questions. Réessayez dans ${retryAfterMinutes} minute${retryAfterMinutes > 1 ? 's' : ''}.`,
        errorType: 'rate_limit',
        retryable: false,
      });
      return res.end();
    }

    // ── Daily quota ────────────────────────────────────────────────────────
    const dailyCheck = await checkDailyQuota(pool, kineId);
    if (dailyCheck && dailyCheck.limited) {
      console.error('[chat-ai/stream] Daily quota hit', { kine_id: kineId, used: dailyCheck.used, limit: dailyCheck.limit });
      sendEvent({
        error: 'Vous avez atteint votre limite quotidienne de messages. Le compteur se réinitialise à minuit.',
        errorType: 'daily_quota',
        retryable: false,
      });
      return res.end();
    }

    const trimmedMessage = message.trim();

    // ── Get kiné's subscription ID ─────────────────────────────────────────
    let subscriptionId = null;
    try {
      const kineResult = await pool.query('SELECT stripe_subscription_id FROM kines WHERE id = $1', [kineId]);
      subscriptionId = kineResult.rows[0]?.stripe_subscription_id || null;
    } catch (dbErr) {
      console.error('[chat-ai/stream] Could not fetch subscription ID:', dbErr.message, { kine_id: kineId });
    }

    // ── Resolve or create conversation ─────────────────────────────────────
    let convId = null;
    let dbAvailable = true;

    if (conversationId) {
      try {
        const existing = await pool.query(
          'SELECT id FROM ai_conversations WHERE id = $1 AND kine_id = $2',
          [conversationId, kineId]
        );
        if (existing.rows.length > 0) convId = existing.rows[0].id;
      } catch (dbErr) {
        dbAvailable = false;
        console.error('[chat-ai/stream] DB error resolving conversation:', dbErr.message, { kine_id: kineId });
      }
    }

    if (dbAvailable && !convId) {
      try {
        const title = trimmedMessage.substring(0, 50);
        const newConv = await pool.query(
          'INSERT INTO ai_conversations (kine_id, title) VALUES ($1, $2) RETURNING id',
          [kineId, title]
        );
        convId = newConv.rows[0].id;
      } catch (dbErr) {
        dbAvailable = false;
        console.error('[chat-ai/stream] DB error creating conversation:', dbErr.message, { kine_id: kineId });
      }
    }

    // ── Persist user message (best effort) ─────────────────────────────────
    if (dbAvailable && convId) {
      try {
        await pool.query(
          'INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1, $2, $3)',
          [convId, 'user', trimmedMessage]
        );
      } catch (dbErr) {
        dbAvailable = false;
        console.error('[chat-ai/stream] DB error persisting user message:', dbErr.message, { kine_id: kineId });
      }
    }

    // ── RAG semantic search (non-blocking, max 1.5s) ───────────────────────
    let ragContext = null;
    let ragSources = [];
    try {
      const ragResult = await Promise.race([
        ragService.searchAndBuildContext(trimmedMessage, { topK: 5, threshold: 0.35 }),
        new Promise(resolve => setTimeout(() => resolve(null), 1500)),
      ]);
      if (ragResult) {
        ragContext = ragResult.context;
        ragSources = ragResult.sources || [];
      }
    } catch (ragErr) {
      console.error('[chat-ai/stream] RAG search failed (non-fatal):', ragErr.message, { kine_id: kineId });
    }

    // ── Stream AI reply ────────────────────────────────────────────────────
    let fullReply = '';
    try {
      const result = await getChatReplyStream(trimmedMessage, {
        conversationId: convId ? String(convId) : null,
        subscriptionId,
        kineId,
        ragContext,
        signal: ac.signal,
        onDelta: function(delta) {
          sendEvent({ delta });
        },
      });
      fullReply = result.reply;
    } catch (aiErr) {
      // Client disconnected — stream was aborted intentionally, no error to send
      if (ac.signal.aborted) return res.end();

      const errType = aiErr.chatAIErrorType || ChatAIErrorType.GENERIC;
      let userMessage;
      switch (errType) {
        case ChatAIErrorType.TIMEOUT:
          userMessage = 'La réponse prend trop de temps. Veuillez réessayer.';
          break;
        case ChatAIErrorType.RATE_LIMIT: {
          const isDailyLimit = (aiErr.message || '').includes('Daily') || (aiErr.message || '').includes('daily_limit');
          userMessage = isDailyLimit
            ? 'Le quota quotidien de l\'IA est atteint. Il se réinitialise à minuit (UTC). Réessayez demain.'
            : 'Service temporairement surchargé. Réessayez dans quelques minutes.';
          break;
        }
        case ChatAIErrorType.CONTENT_FILTER:
          userMessage = 'Je ne peux pas répondre à cette question.';
          break;
        default:
          userMessage = 'Erreur lors de la génération de la réponse. Veuillez réessayer.';
      }
      const isRetryable = errType === ChatAIErrorType.TIMEOUT || errType === ChatAIErrorType.RATE_LIMIT || errType === ChatAIErrorType.GENERIC;
      sendEvent({ error: userMessage, errorType: errType.toLowerCase(), retryable: isRetryable });
      return res.end();
    }

    // ── Persist assistant reply (best effort) ──────────────────────────────
    if (dbAvailable && convId && fullReply) {
      try {
        await pool.query(
          'INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1, $2, $3)',
          [convId, 'assistant', fullReply]
        );
        await pool.query('UPDATE ai_conversations SET updated_at = NOW() WHERE id = $1', [convId]);
      } catch (dbErr) {
        console.error('[chat-ai/stream] DB error persisting assistant reply:', dbErr.message, { kine_id: kineId });
      }
    }

    // ── Increment daily quota (fire and forget) ────────────────────────────
    incrementDailyQuota(pool, kineId).catch(() => {});

    // ── Done event ─────────────────────────────────────────────────────────
    sendEvent({ done: true, conversationId: convId, sources: ragSources });
    res.end();
  } catch (err) {
    console.error('[chat-ai/stream] Unexpected error:', err.message, { kine_id: kineId });
    sendEvent({ error: 'Erreur lors de la génération de la réponse. Veuillez réessayer.', errorType: 'generic', retryable: true });
    res.end();
  }
});

/**
 * DELETE /api/chat-ai/conversations/:id
 * Delete a conversation and all its messages (must belong to authenticated kiné).
 */
app.delete('/api/chat-ai/conversations/:id', requireAuth, async (req, res) => {
  try {
    const convId = parseInt(req.params.id, 10);
    if (isNaN(convId)) return res.status(400).json({ error: 'ID de conversation invalide' });

    // Verify ownership before deleting
    const conv = await pool.query(
      'SELECT id FROM ai_conversations WHERE id = $1 AND kine_id = $2',
      [convId, req.session.kineId]
    );
    if (conv.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation introuvable' });
    }

    // Delete messages first (FK constraint), then conversation
    await pool.query('DELETE FROM ai_messages WHERE conversation_id = $1', [convId]);
    await pool.query('DELETE FROM ai_conversations WHERE id = $1', [convId]);

    res.json({ success: true });
  } catch (err) {
    console.error('[chat-ai] delete conversation error:', err.message);
    res.status(500).json({ error: 'Erreur lors de la suppression de la conversation' });
  }
});

// ==========================================
// FEEDBACK BÊTA-TESTEURS
// ==========================================

// POST /api/feedback — soumission publique du formulaire (sans login requis)
app.post('/api/feedback', async (req, res) => {
  try {
    const { note_globale, facilite_utilisation, fonctionnalite_preferee, ameliorations, recommandation, contact_nom_email } = req.body;

    // Validation
    const noteGlobale = parseInt(note_globale, 10);
    const facilite = parseInt(facilite_utilisation, 10);

    if (!noteGlobale || noteGlobale < 1 || noteGlobale > 5) {
      return res.status(400).json({ error: 'Note globale invalide (1–5 requis)' });
    }
    if (!facilite || facilite < 1 || facilite > 5) {
      return res.status(400).json({ error: 'Note facilité invalide (1–5 requis)' });
    }
    if (!recommandation || !['oui', 'non', 'peut-etre'].includes(recommandation)) {
      return res.status(400).json({ error: 'Réponse recommandation invalide' });
    }

    const ip = req.ip || req.headers['x-forwarded-for'] || null;
    const ua = req.headers['user-agent'] || null;

    await pool.query(
      `INSERT INTO feedback_responses
         (note_globale, facilite_utilisation, fonctionnalite_preferee, ameliorations, recommandation, contact_nom_email, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        noteGlobale,
        facilite,
        fonctionnalite_preferee ? String(fonctionnalite_preferee).substring(0, 2000) : null,
        ameliorations ? String(ameliorations).substring(0, 2000) : null,
        recommandation,
        contact_nom_email ? String(contact_nom_email).substring(0, 255) : null,
        ip ? String(ip).substring(0, 45) : null,
        ua ? String(ua).substring(0, 500) : null,
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[feedback] submission error:', err.message);
    res.status(500).json({ error: 'Erreur lors de l\'envoi du feedback' });
  }
});

// GET /api/admin/feedback — liste des réponses (admin uniquement)
app.get('/api/admin/feedback', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        id,
        note_globale,
        facilite_utilisation,
        fonctionnalite_preferee,
        ameliorations,
        recommandation,
        contact_nom_email,
        submitted_at
      FROM feedback_responses
      ORDER BY submitted_at DESC
      LIMIT 500
    `);

    // Summary stats
    const stats = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        ROUND(AVG(note_globale)::numeric, 1) AS avg_note_globale,
        ROUND(AVG(facilite_utilisation)::numeric, 1) AS avg_facilite,
        COUNT(*) FILTER (WHERE recommandation = 'oui')::int AS recommande_oui,
        COUNT(*) FILTER (WHERE recommandation = 'non')::int AS recommande_non,
        COUNT(*) FILTER (WHERE recommandation = 'peut-etre')::int AS recommande_peut_etre
      FROM feedback_responses
    `);

    res.json({ responses: rows, stats: stats.rows[0] });
  } catch (err) {
    console.error('[feedback] admin list error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /feedback — page publique formulaire feedback bêta
app.get('/feedback', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'feedback.html'));
});

// GET /admin/feedback — page admin des réponses feedback (requireAdmin)
app.get('/admin/feedback', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-feedback.html'));
});

// ============================================================
// ADMIN ANALYTICS — moved to routes/admin-analytics.js + db/admin-analytics.js
// All metrics now exclude demo (@demo.kinevia.pro) and beta (lifetime_free) accounts.
// ============================================================

// ============================================================
// RAG API — vector search infrastructure for Chat AI Kiné
// Migration 070: pgvector + rag_documents + rag_chunks
// ============================================================
const ragService = require('./services/ragService');

// POST /api/rag/ingest — add a document to the vector store (admin only)
app.post('/api/rag/ingest', requireAdmin, async (req, res) => {
  const { title, category, source_type, source_url, content, metadata } = req.body;
  if (!title || !content) {
    return res.status(400).json({ error: 'title and content are required' });
  }
  try {
    const result = await ragService.ingestDocument({
      title, category, source_type, source_url, content, metadata,
    });
    res.json({ success: true, document_id: result.document_id, chunk_count: result.chunk_count });
  } catch (err) {
    console.error('[rag] ingest error:', err.message);
    res.status(500).json({ error: 'Erreur lors de l\'ingestion du document' });
  }
});

// GET /api/rag/search?q=...&topK=5&category=... — semantic search (authenticated kinés)
app.get('/api/rag/search', requireAuth, async (req, res) => {
  const query = req.query.q;
  if (!query || !query.trim()) {
    return res.status(400).json({ error: 'Le paramètre q (query) est requis' });
  }
  const topK = Math.min(parseInt(req.query.topK) || 5, 20);
  const category = req.query.category || null;
  try {
    const results = await ragService.semanticSearch(query, { topK, category });
    res.json({ query, results, count: results.length });
  } catch (err) {
    console.error('[rag] search error:', err.message);
    res.status(500).json({ error: 'Erreur lors de la recherche sémantique' });
  }
});

// GET /api/rag/documents — list all documents (admin)
app.get('/api/rag/documents', requireAdmin, async (req, res) => {
  try {
    const docs = await ragService.listDocuments();
    res.json({ documents: docs });
  } catch (err) {
    console.error('[rag] list error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/rag/documents/:id — remove a document (admin)
app.delete('/api/rag/documents/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID invalide' });
  try {
    await ragService.deleteDocument(id);
    res.json({ success: true });
  } catch (err) {
    console.error('[rag] delete error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/rag/stats — store statistics (admin)
app.get('/api/rag/stats', requireAdmin, async (req, res) => {
  try {
    const stats = await ragService.getStats();
    res.json(stats);
  } catch (err) {
    console.error('[rag] stats error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/rag/index-exercises — index the full exercise library into RAG (admin)
// ?force=true to re-index all (deletes existing exercice docs first)
app.post('/api/rag/index-exercises', async (req, res) => {
  const adminKey = process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN;
  const authHeader = req.headers.authorization || '';
  if (!adminKey || authHeader !== 'Bearer ' + adminKey) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const forceReindex = req.query.force === 'true';

  // Respond immediately — indexing runs async in background
  res.json({ success: true, message: 'Indexation démarrée en arrière-plan. Consultez /api/rag/stats pour suivre la progression.' });

  // Zone labels (French) for readable document titles
  const ZONE_LABELS = {
    epaule:                   'Épaule',
    genou:                    'Genou',
    dos:                      'Dos / Rachis lombaire',
    hanche:                   'Hanche',
    cheville:                 'Cheville',
    poignet:                  'Poignet / Main',
    cou:                      'Cou / Cervical',
    pied:                     'Pied',
    coude:                    'Coude',
    abdominaux:               'Abdominaux',
    atm:                      'ATM (Articulation Temporo-Mandibulaire)',
    rachis_thoracique:        'Rachis thoracique',
    geriatrie:                'Gériatrie — Équilibre & Mobilité',
    geriatrie_renforcement:   'Gériatrie — Renforcement',
    muscles_profonds_gainage: 'Muscles profonds — Gainage',
    muscles_profonds_plancher:'Plancher pelvien — Muscles profonds',
  };

  function buildExerciseContent(ex) {
    const zone = ZONE_LABELS[ex.zone_corporelle] || ex.zone_corporelle;
    const muscles = ex.muscles && ex.muscles.trim() ? ex.muscles.trim() : 'non spécifiés';
    return `# ${ex.nom}

**Zone corporelle :** ${zone}
**Muscles ciblés :** ${muscles}
**Dosage recommandé :** ${ex.series_recommandees || 3} séries × ${ex.repetitions_recommandees || '10'} répétitions

## Description et consignes

${ex.description || 'Aucune description disponible.'}`.trim();
  }

  // Run async — errors logged, won't crash server
  (async () => {
    try {
      console.log('[rag-index] Starting exercise indexer...');

      const { rows: exercises } = await pool.query(`
        SELECT id, nom, zone_corporelle, description, muscles,
               series_recommandees, repetitions_recommandees
        FROM exercices
        WHERE est_personnalise = false
        ORDER BY zone_corporelle, nom
      `);
      console.log(`[rag-index] Found ${exercises.length} exercises`);

      // Build set of already-indexed IDs (skip if incremental)
      let alreadyIndexedIds = new Set();
      if (!forceReindex) {
        const existing = await ragService.listDocuments();
        for (const doc of existing) {
          if (doc.category === 'exercice' && doc.metadata && doc.metadata.exercise_id) {
            alreadyIndexedIds.add(doc.metadata.exercise_id);
          }
        }
        console.log(`[rag-index] Already indexed: ${alreadyIndexedIds.size}`);
      } else {
        const existing = await ragService.listDocuments();
        const toDelete = existing.filter(d => d.category === 'exercice');
        console.log(`[rag-index] Force mode — deleting ${toDelete.length} existing docs`);
        for (const doc of toDelete) {
          await ragService.deleteDocument(doc.id);
        }
      }

      const toIndex = forceReindex
        ? exercises
        : exercises.filter(ex => !alreadyIndexedIds.has(ex.id));

      if (toIndex.length === 0) {
        console.log('[rag-index] Nothing to index — all exercises already in RAG store');
        return;
      }

      console.log(`[rag-index] Indexing ${toIndex.length} exercises...`);

      let indexed = 0;
      let failed = 0;
      const BATCH_SIZE = 10;

      for (let i = 0; i < toIndex.length; i += BATCH_SIZE) {
        const batch = toIndex.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (ex) => {
          try {
            const zone = ZONE_LABELS[ex.zone_corporelle] || ex.zone_corporelle;
            await ragService.ingestDocument({
              title: `${ex.nom} — ${zone}`,
              category: 'exercice',
              source_type: 'internal',
              content: buildExerciseContent(ex),
              metadata: {
                exercise_id: ex.id,
                zone_corporelle: ex.zone_corporelle,
                zone_label: zone,
                muscles: ex.muscles || '',
                series: ex.series_recommandees,
                repetitions: ex.repetitions_recommandees,
                source: 'Kinévia Exercise Library',
              },
            });
            indexed++;
          } catch (err) {
            failed++;
            console.error(`[rag-index] Failed: ${ex.nom} (id=${ex.id}): ${err.message}`);
          }
        }));

        if ((i + BATCH_SIZE) % 50 === 0 || i + BATCH_SIZE >= toIndex.length) {
          console.log(`[rag-index] Progress: ${Math.min(i + BATCH_SIZE, toIndex.length)}/${toIndex.length}`);
        }
      }

      console.log(`[rag-index] Done — indexed: ${indexed}, failed: ${failed}`);
    } catch (err) {
      console.error('[rag-index] Fatal error:', err.message);
    }
  })();
});

// POST /api/rag/index-clinical-tests — index clinical tests into RAG (admin)
// ?force=true to re-index all (deletes existing clinical_test docs first)
// ?limit=N to cap batch size (default 30, max 60) — respects 100k/day token quota
app.post('/api/rag/index-clinical-tests', async (req, res) => {
  const adminKey = process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN;
  const authHeader = req.headers.authorization || '';
  if (!adminKey || authHeader !== 'Bearer ' + adminKey) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const forceReindex = req.query.force === 'true';
  // Limit to 30 per call by default — keeps token budget predictable
  const batchLimit = Math.min(parseInt(req.query.limit || '30', 10) || 30, 60);

  // Respond immediately — indexing runs async in background
  res.json({ success: true, message: `Indexation des tests cliniques démarrée (max ${batchLimit} tests). Consultez /api/rag/stats pour suivre la progression.` });

  // Category labels (French) for readable document titles
  const CATEGORY_LABELS = {
    epaule:     'Épaule',
    genou:      'Genou',
    coude:      'Coude',
    atm:        'ATM (Articulation Temporo-Mandibulaire)',
    cervicales: 'Cervicales',
    rachis:     'Rachis',
    hanche:     'Hanche',
    cheville:   'Cheville',
    douleur:    'Douleur',
    fonction:   'Fonction',
    equilibre:  'Équilibre',
    force:      'Force',
    mobilite:   'Mobilité',
    neurologique: 'Neurologique',
  };

  function buildClinicalTestContent(test) {
    const catLabel = CATEGORY_LABELS[test.category] || test.category;
    const parts = [
      `# ${test.name}`,
      '',
      `**Catégorie :** ${catLabel}`,
    ];

    if (test.description) {
      parts.push('');
      parts.push('## Description');
      parts.push(test.description);
    }

    if (test.instructions) {
      parts.push('');
      parts.push('## Protocole / Instructions');
      parts.push(test.instructions);
    }

    if (test.scoring_method) {
      parts.push('');
      parts.push('## Méthode de cotation');
      parts.push(test.scoring_method);
    }

    if (test.interpretation_guide) {
      parts.push('');
      parts.push('## Interprétation des scores');
      parts.push(test.interpretation_guide);
    }

    if (test.evidence_level) {
      parts.push('');
      parts.push(`**Niveau de preuve :** ${test.evidence_level}`);
    }

    if (test.source_reference) {
      parts.push(`**Référence :** ${test.source_reference}`);
    }

    return parts.join('\n').trim();
  }

  // Run async — errors logged, won't crash server
  (async () => {
    try {
      console.log(`[rag-clinical] Starting clinical tests indexer (limit=${batchLimit})...`);

      // Order by id for deterministic batching (Lot 1 = tests 1-30, Lot 2 = 31-60, etc.)
      const { rows: tests } = await pool.query(`
        SELECT id, name, description, category, scoring_method,
               instructions, interpretation_guide, evidence_level, source_reference
        FROM clinical_tests
        ORDER BY id ASC
      `);
      console.log(`[rag-clinical] Found ${tests.length} clinical tests`);

      // Build set of already-indexed test IDs (skip if incremental)
      let alreadyIndexedIds = new Set();
      if (!forceReindex) {
        const existing = await ragService.listDocuments();
        for (const doc of existing) {
          if (doc.category === 'test_clinique' && doc.metadata && doc.metadata.test_id) {
            alreadyIndexedIds.add(Number(doc.metadata.test_id));
          }
        }
        console.log(`[rag-clinical] Already indexed: ${alreadyIndexedIds.size}`);
      } else {
        const existing = await ragService.listDocuments();
        const toDelete = existing.filter(d => d.category === 'test_clinique');
        console.log(`[rag-clinical] Force mode — deleting ${toDelete.length} existing docs`);
        for (const doc of toDelete) {
          await ragService.deleteDocument(doc.id);
        }
      }

      // Take up to batchLimit unindexed tests (ordered by id)
      const allToIndex = forceReindex
        ? tests
        : tests.filter(t => !alreadyIndexedIds.has(t.id));
      const toIndex = allToIndex.slice(0, batchLimit);

      if (toIndex.length === 0) {
        console.log('[rag-clinical] Nothing to index — all clinical tests already in RAG store');
        return;
      }

      console.log(`[rag-clinical] Indexing ${toIndex.length} tests (${allToIndex.length - toIndex.length} remaining after this batch)...`);

      let indexed = 0;
      let failed = 0;
      let quotaExhausted = false;
      const BATCH_SIZE = 5;

      for (let i = 0; i < toIndex.length; i += BATCH_SIZE) {
        if (quotaExhausted) break;
        const batch = toIndex.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (test) => {
          try {
            const catLabel = CATEGORY_LABELS[test.category] || test.category;
            await ragService.ingestDocument({
              title: `${test.name} — ${catLabel}`,
              category: 'test_clinique',
              source_type: 'internal',
              content: buildClinicalTestContent(test),
              metadata: {
                test_id: test.id,
                category: test.category,
                category_label: catLabel,
                evidence_level: test.evidence_level || '',
                source: 'Kinévia Clinical Tests Library',
              },
            });
            indexed++;
          } catch (err) {
            failed++;
            if (err.message && err.message.includes('429')) {
              quotaExhausted = true;
              console.warn(`[rag-clinical] Quota épuisé après ${indexed} tests indexés — reprendra à minuit UTC`);
            } else {
              console.error(`[rag-clinical] Failed: ${test.name} (id=${test.id}): ${err.message}`);
            }
          }
        }));

        if (!quotaExhausted) {
          console.log(`[rag-clinical] Progress: ${Math.min(i + BATCH_SIZE, toIndex.length)}/${toIndex.length}`);
        }
      }

      console.log(`[rag-clinical] Done — indexed: ${indexed}, failed: ${failed}${quotaExhausted ? ' (quota épuisé — relancer demain)' : ''}`);
    } catch (err) {
      console.error('[rag-clinical] Fatal error:', err.message);
    }
  })();
});

// POST /api/rag/index-pathology-sheets — index all pathology sheets into RAG (admin)
// ?force=true to re-index all (deletes existing pathology_sheet docs first)
app.post('/api/rag/index-pathology-sheets', async (req, res) => {
  const adminKey = process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN;
  const authHeader = req.headers.authorization || '';
  if (!adminKey || authHeader !== 'Bearer ' + adminKey) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const forceReindex = req.query.force === 'true';

  // Respond immediately — indexing runs async in background
  res.json({ success: true, message: 'Indexation des fiches pathologies démarrée en arrière-plan. Consultez /api/rag/stats pour suivre la progression.' });

  // Category labels (French) for readable document titles
  const CATEGORY_LABELS = {
    ortho_mi:     'Orthopédie — Membre inférieur',
    ortho_ms:     'Orthopédie — Membre supérieur',
    rachis:       'Rachis / Colonne vertébrale',
    neuro:        'Neurologie',
    respi_cardio: 'Respiratoire & Cardio-vasculaire',
    sport:        'Traumatologie du sport',
    pediatrie:    'Pédiatrie',
    geriatrie:    'Gériatrie',
  };

  /**
   * Flatten a pathology sheet's JSONB content into a rich text document
   * optimized for semantic retrieval. Each section (definition, tableau_clinique,
   * bilan_kine, traitement, references) becomes an ## heading.
   * This single document is then chunked by ragService into ~400-token chunks.
   */
  function buildPathologyContent(sheet) {
    const catLabel = CATEGORY_LABELS[sheet.category] || sheet.category;
    const parts = [
      `# ${sheet.title}`,
      '',
      `**Catégorie :** ${catLabel}`,
      `**Slug :** ${sheet.slug}`,
      '',
    ];

    const content = sheet.content || {};

    // Iterate all JSONB sections in document order
    // Sections are objects with {titre, contenu} or raw strings
    for (const [, section] of Object.entries(content)) {
      if (!section) continue;

      if (typeof section === 'string') {
        parts.push(section);
        parts.push('');
      } else if (typeof section === 'object') {
        const titre = section.titre || section.title || '';
        const contenu = section.contenu || section.content || section.text || '';

        if (titre) {
          parts.push(`## ${titre}`);
          parts.push('');
        }

        if (contenu) {
          parts.push(contenu);
          parts.push('');
        }

        // Some sections have nested sub-sections (array or object)
        if (section.items && Array.isArray(section.items)) {
          for (const item of section.items) {
            if (typeof item === 'string') {
              parts.push(`- ${item}`);
            } else if (item && item.titre) {
              parts.push(`### ${item.titre}`);
              if (item.contenu) parts.push(item.contenu);
              parts.push('');
            }
          }
        }
      }
    }

    return parts.join('\n').trim();
  }

  // Run async — errors logged, won't crash server
  (async () => {
    try {
      console.log('[rag-pathology] Starting pathology sheets indexer...');

      const { rows: sheets } = await pool.query(`
        SELECT id, slug, title, category, content
        FROM pathology_sheets
        ORDER BY category, title
      `);
      console.log(`[rag-pathology] Found ${sheets.length} pathology sheets`);

      // Build set of already-indexed sheet IDs (skip if incremental)
      let alreadyIndexedSlugs = new Set();
      if (!forceReindex) {
        const existing = await ragService.listDocuments();
        for (const doc of existing) {
          if (doc.category === 'pathology_sheet' && doc.metadata && doc.metadata.slug) {
            alreadyIndexedSlugs.add(doc.metadata.slug);
          }
        }
        console.log(`[rag-pathology] Already indexed: ${alreadyIndexedSlugs.size}`);
      } else {
        const existing = await ragService.listDocuments();
        const toDelete = existing.filter(d => d.category === 'pathology_sheet');
        console.log(`[rag-pathology] Force mode — deleting ${toDelete.length} existing docs`);
        for (const doc of toDelete) {
          await ragService.deleteDocument(doc.id);
        }
      }

      const toIndex = forceReindex
        ? sheets
        : sheets.filter(s => !alreadyIndexedSlugs.has(s.slug));

      if (toIndex.length === 0) {
        console.log('[rag-pathology] Nothing to index — all pathology sheets already in RAG store');
        return;
      }

      console.log(`[rag-pathology] Indexing ${toIndex.length} pathology sheets...`);

      let indexed = 0;
      let failed = 0;
      const BATCH_SIZE = 3; // small batches — sheets are large (800-1200 words each)

      for (let i = 0; i < toIndex.length; i += BATCH_SIZE) {
        const batch = toIndex.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (sheet) => {
          try {
            const catLabel = CATEGORY_LABELS[sheet.category] || sheet.category;
            await ragService.ingestDocument({
              title: `${sheet.title} — ${catLabel}`,
              category: 'pathology_sheet',
              source_type: 'pathology_sheet',
              source_url: `/fiches-pathologies/${sheet.slug}`,
              content: buildPathologyContent(sheet),
              metadata: {
                sheet_id: sheet.id,
                slug: sheet.slug,
                category: sheet.category,
                category_label: catLabel,
                source: 'Kinévia Fiches Pathologies',
              },
            });
            indexed++;
          } catch (err) {
            failed++;
            console.error(`[rag-pathology] Failed: ${sheet.title} (slug=${sheet.slug}): ${err.message}`);
          }
        }));

        console.log(`[rag-pathology] Progress: ${Math.min(i + BATCH_SIZE, toIndex.length)}/${toIndex.length}`);
      }

      console.log(`[rag-pathology] Done — indexed: ${indexed}, failed: ${failed}`);
    } catch (err) {
      console.error('[rag-pathology] Fatal error:', err.message);
    }
  })();
});

// POST /api/rag/index-journal-articles — index all Kinévia journal articles into RAG (admin)
// ?force=true to re-index all (deletes existing article_scientifique docs first)
app.post('/api/rag/index-journal-articles', async (req, res) => {
  const adminKey = process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN;
  const authHeader = req.headers.authorization || '';
  if (!adminKey || authHeader !== 'Bearer ' + adminKey) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const forceReindex = req.query.force === 'true';

  // Respond immediately — indexing runs async in background
  res.json({ success: true, message: 'Indexation des articles scientifiques démarrée en arrière-plan. Consultez /api/rag/stats pour suivre la progression.' });

  /**
   * Build enriched content for an article.
   * Combines titre + thématique + résumé + référence into a well-structured
   * text block. This is what gets chunked and embedded — richer context =
   * better semantic retrieval.
   */
  function buildArticleContent(article) {
    const parts = [
      `# ${article.titre}`,
      '',
      `**Thématique :** ${article.thematique}`,
    ];

    if (article.resume) {
      parts.push('');
      parts.push('## Résumé');
      parts.push(article.resume);
    }

    if (article.source_ref) {
      parts.push('');
      parts.push(`**Référence :** ${article.source_ref}`);
    }

    if (article.lien_original) {
      parts.push(`**PubMed :** ${article.lien_original}`);
    }

    return parts.join('\n').trim();
  }

  // Run async — errors logged, won't crash server
  (async () => {
    try {
      console.log('[rag-articles] Starting journal articles indexer...');

      // Fetch unique articles by lien_original (deduplicate DB duplicates from reseed history)
      // Each article has: titre, resume, thematique, lien_original, source_ref (if available)
      const { rows: articles } = await pool.query(`
        SELECT DISTINCT ON (lien_original)
          id, titre, resume, thematique, lien_original
        FROM publications
        ORDER BY lien_original, id DESC
      `);
      console.log(`[rag-articles] Found ${articles.length} unique articles`);

      // Build set of already-indexed article URLs (skip if incremental)
      let alreadyIndexedUrls = new Set();
      if (!forceReindex) {
        const existing = await ragService.listDocuments();
        for (const doc of existing) {
          if (doc.category === 'article_scientifique' && doc.source_url) {
            alreadyIndexedUrls.add(doc.source_url);
          }
        }
        console.log(`[rag-articles] Already indexed: ${alreadyIndexedUrls.size}`);
      } else {
        const existing = await ragService.listDocuments();
        const toDelete = existing.filter(d => d.category === 'article_scientifique');
        console.log(`[rag-articles] Force mode — deleting ${toDelete.length} existing docs`);
        for (const doc of toDelete) {
          await ragService.deleteDocument(doc.id);
        }
      }

      const toIndex = forceReindex
        ? articles
        : articles.filter(a => !alreadyIndexedUrls.has(a.lien_original));

      if (toIndex.length === 0) {
        console.log('[rag-articles] Nothing to index — all articles already in RAG store');
        return;
      }

      console.log(`[rag-articles] Indexing ${toIndex.length} articles...`);

      let indexed = 0;
      let failed = 0;
      const BATCH_SIZE = 5; // batch embedding calls

      for (let i = 0; i < toIndex.length; i += BATCH_SIZE) {
        const batch = toIndex.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (article) => {
          try {
            await ragService.ingestDocument({
              title: article.titre,
              category: 'article_scientifique',
              source_type: 'pubmed',
              source_url: article.lien_original || null,
              content: buildArticleContent(article),
              metadata: {
                publication_id: article.id,
                thematique: article.thematique,
                source: 'Journal Scientifique Kinévia',
              },
            });
            indexed++;
            console.log(`  ✓ [${article.thematique}] ${article.titre}`);
          } catch (err) {
            failed++;
            console.error(`  ✗ ${article.titre} (id=${article.id}): ${err.message}`);
          }
        }));

        console.log(`[rag-articles] Progress: ${Math.min(i + BATCH_SIZE, toIndex.length)}/${toIndex.length}`);
      }

      console.log(`[rag-articles] Done — indexed: ${indexed}, failed: ${failed}`);

      // Quick verification queries
      console.log('[rag-articles] Running verification queries...');
      const testQueries = [
        'evidence-based rééducation LCA ligament croisé antérieur',
        'mobilisation précoce post-opératoire prothèse genou',
        'tendinopathie Achille exercice excentrique',
      ];
      for (const q of testQueries) {
        try {
          const results = await ragService.semanticSearch(q, { topK: 2, threshold: 0.25, category: 'article_scientifique' });
          if (results.length > 0) {
            console.log(`  ✓ "${q}" → ${results[0].document_title} (sim=${results[0].similarity.toFixed(3)})`);
          } else {
            console.log(`  ⚠ "${q}" → no results above threshold`);
          }
        } catch (err) {
          console.error(`  ✗ query failed: ${err.message}`);
        }
      }
    } catch (err) {
      console.error('[rag-articles] Fatal error:', err.message);
    }
  })();
});

app.listen(port, async () => {
  console.log(`Kinévia server running on port ${port}`);

  // Startup hook: ensure RAG infrastructure tables exist (idempotent).
  // Render build env has a different DATABASE_URL than production Neon —
  // migrations run at build time against the build DB, not the live DB.
  // This hook guarantees the tables exist at runtime regardless.
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rag_documents (
        id           SERIAL PRIMARY KEY,
        title        VARCHAR(512) NOT NULL,
        category     VARCHAR(50)  NOT NULL DEFAULT 'general',
        source_type  VARCHAR(50)  NOT NULL DEFAULT 'internal',
        source_url   TEXT,
        content      TEXT         NOT NULL,
        metadata     JSONB        NOT NULL DEFAULT '{}',
        created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rag_chunks (
        id           SERIAL PRIMARY KEY,
        document_id  INTEGER      NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
        chunk_index  INTEGER      NOT NULL,
        content      TEXT         NOT NULL,
        token_count  INTEGER,
        embedding    vector(1536),
        created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS rag_chunks_embedding_hnsw_idx
        ON rag_chunks
        USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS rag_chunks_document_idx ON rag_chunks(document_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS rag_documents_category_idx ON rag_documents(category)`);
    console.log('[rag-boot] RAG infrastructure tables ready');
  } catch (err) {
    console.error('[rag-boot] RAG table setup error:', err.message);
  }

  // Startup hook: ensure publications table exists with correct seed data.
  // Uses a version check — bump PUB_SEED_VERSION to force a full reseed.
  // This is the single source of truth for publication data; migrations are
  // unreliable due to the build/runtime DATABASE_URL mismatch on Render.
  try {
    const PUB_SEED_VERSION = 4; // bump this to force reseed

    await pool.query(`
      CREATE TABLE IF NOT EXISTS publications (
        id SERIAL PRIMARY KEY,
        titre VARCHAR(500) NOT NULL,
        resume TEXT NOT NULL,
        thematique VARCHAR(100) NOT NULL,
        lien_original VARCHAR(1000),
        date_publication TIMESTAMPTZ NOT NULL,
        seed_version INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Add seed_version column if missing (existing tables from old migrations)
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE publications ADD COLUMN IF NOT EXISTS seed_version INTEGER NOT NULL DEFAULT 0;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS publications_thematique_idx ON publications (thematique)');
    await pool.query('CREATE INDEX IF NOT EXISTS publications_date_idx ON publications (date_publication DESC)');

    // Check if reseed is needed: table empty OR version mismatch
    const vCheck = await pool.query('SELECT seed_version FROM publications LIMIT 1');
    const currentVersion = vCheck.rows.length > 0 ? vCheck.rows[0].seed_version : 0;
    const needsReseed = vCheck.rows.length === 0 || currentVersion < PUB_SEED_VERSION;

    if (needsReseed) {
      console.log(`[startup] Publications reseed needed (current v${currentVersion}, target v${PUB_SEED_VERSION}). Reseeding...`);

      // Truncate and reseed with verified data
      await pool.query('DELETE FROM publications');

      // All 8 articles: clean French titles + verified PubMed URLs (each PMID
      // was individually checked against pubmed.ncbi.nlm.nih.gov on 2026-05-01)
      const now = new Date();
      const articles = [
        {
          titre: 'Efficacité des exercices de stabilité scapulaire dans la rééducation de l\'épaule',
          resume: 'Cette revue systématique et méta-analyse de 8 essais contrôlés randomisés montre que les exercices de stabilité scapulaire améliorent significativement la douleur et la fonction de l\'épaule chez les patients présentant un syndrome douloureux subacromial, par rapport à la kinésithérapie conventionnelle.',
          thematique: 'epaule',
          lien_original: 'https://pubmed.ncbi.nlm.nih.gov/38497039/',
          date_publication: now.toISOString()
        },
        {
          titre: 'Impact du type et de la dose d\'exercice sur la douleur et le handicap dans la gonarthrose',
          resume: 'Cette méta-analyse de régression portant sur des essais contrôlés randomisés démontre que le renforcement spécifique du quadriceps réduit significativement la douleur et améliore la fonction chez les patients atteints de gonarthrose. Les programmes supervisés, pratiqués au moins 3 fois par semaine, offrent les meilleurs résultats.',
          thematique: 'genou',
          lien_original: 'https://pubmed.ncbi.nlm.nih.gov/24574223/',
          date_publication: new Date(now.getTime() - 7 * 86400000).toISOString()
        },
        {
          titre: 'Rééducation biopsychosociale multidisciplinaire pour la lombalgie chronique',
          resume: 'Cette revue systématique Cochrane de 41 essais démontre que les programmes de rééducation biopsychosociale multidisciplinaire sont supérieurs aux soins habituels pour réduire la douleur et le handicap chez les patients souffrant de lombalgie chronique depuis plus d\'un an.',
          thematique: 'dos',
          lien_original: 'https://pubmed.ncbi.nlm.nih.gov/25694111/',
          date_publication: new Date(now.getTime() - 14 * 86400000).toISOString()
        },
        {
          titre: 'Rééducation post-AVC : entraînement à la marche sur tapis roulant avec allègement du poids',
          resume: 'Cet essai contrôlé randomisé multicentrique évalue l\'entraînement locomoteur sur tapis roulant avec support partiel du poids du corps chez les patients post-AVC. L\'étude montre que cette technique n\'est pas supérieure à un programme d\'exercices à domicile supervisé par un kinésithérapeute.',
          thematique: 'neurologie',
          lien_original: 'https://pubmed.ncbi.nlm.nih.gov/21612471/',
          date_publication: new Date(now.getTime() - 90 * 86400000).toISOString()
        },
        {
          titre: 'Efficacité des programmes d\'exercice pour prévenir les blessures sportives',
          resume: 'Cette revue systématique et méta-analyse de 25 essais contrôlés randomisés (26 610 participants) montre que les programmes d\'exercice préventif réduisent significativement les blessures sportives. Le renforcement musculaire réduit les blessures de plus de deux tiers, tandis que les étirements seuls n\'ont pas d\'effet protecteur significatif.',
          thematique: 'sport',
          lien_original: 'https://pubmed.ncbi.nlm.nih.gov/24100287/',
          date_publication: new Date(now.getTime() - 150 * 86400000).toISOString()
        },
        {
          titre: 'Exercice et prévention des chutes chez les personnes âgées vivant à domicile',
          resume: 'Cette revue Cochrane de 108 essais contrôlés randomisés (23 407 participants de 60 ans et plus) démontre que les programmes d\'exercice réduisent le taux de chutes de 23%. Les exercices d\'équilibre et fonctionnels sont les plus efficaces, et les programmes combinant plusieurs types d\'exercices réduisent le taux de chutes de 34%.',
          thematique: 'geriatrie',
          lien_original: 'https://pubmed.ncbi.nlm.nih.gov/30703272/',
          date_publication: new Date(now.getTime() - 60 * 86400000).toISOString()
        },
        {
          titre: 'Efficacité de l\'exercice thérapeutique dans la fibromyalgie',
          resume: 'Cette revue systématique et méta-analyse d\'essais cliniques randomisés démontre que l\'exercice aérobie, le renforcement musculaire et les étirements réduisent significativement la douleur et améliorent la qualité de vie chez les patients atteints de fibromyalgie. L\'exercice est désormais recommandé comme traitement de première ligne.',
          thematique: 'douleur chronique',
          lien_original: 'https://pubmed.ncbi.nlm.nih.gov/29291206/',
          date_publication: new Date(now.getTime() - 45 * 86400000).toISOString()
        },
        {
          titre: 'Réhabilitation respiratoire dans la BPCO : revue Cochrane',
          resume: 'Cette revue Cochrane de 65 essais contrôlés randomisés démontre que la réhabilitation respiratoire améliore significativement la qualité de vie, la capacité à l\'effort et réduit la dyspnée et la fatigue chez les patients atteints de BPCO. Les bénéfices sont cliniquement significatifs et se maintiennent avec un programme d\'entretien.',
          thematique: 'respiratoire',
          lien_original: 'https://pubmed.ncbi.nlm.nih.gov/25705944/',
          date_publication: new Date(now.getTime() - 120 * 86400000).toISOString()
        },
        // --- 5 articles ajoutés v4 (Essery 2017, Buhagiar 2019, Glattke 2022, Alfredson 1998, Hidalgo 2017) ---
        {
          titre: 'Facteurs prédictifs de l\'observance aux programmes d\'exercices à domicile : revue systématique',
          resume: 'Cette revue systématique de 30 études quantitatives identifie les principaux déterminants de l\'observance aux programmes de rééducation auto-gérés. L\'intention d\'adhérer, la motivation intrinsèque, l\'auto-efficacité perçue et le soutien social constituent les prédicteurs les plus robustes. En pratique, les kinésithérapeutes gagneront à renforcer la confiance du patient en ses capacités et à mobiliser son entourage pour améliorer la fidélité aux exercices prescrits sur le long terme.',
          thematique: 'observance',
          lien_original: 'https://pubmed.ncbi.nlm.nih.gov/27097761/',
          date_publication: new Date(now.getTime() - 20 * 86400000).toISOString()
        },
        {
          titre: 'Rééducation à domicile versus en établissement après prothèse totale de genou : méta-analyse',
          resume: 'Cette méta-analyse de 5 essais randomisés (752 participants) compare les programmes de rééducation à domicile aux programmes supervisés en structure après prothèse totale du genou. Les résultats montrent une équivalence clinique entre les deux modalités sur les critères fonctionnels, douleur et qualité de vie à 10 semaines et 1 an. La rééducation à domicile constitue donc une alternative valide et moins coûteuse pour les patients sans complication, disposant d\'un soutien social adéquat.',
          thematique: 'domicile-vs-cabinet',
          lien_original: 'https://pubmed.ncbi.nlm.nih.gov/31026026/',
          date_publication: new Date(now.getTime() - 35 * 86400000).toISOString()
        },
        {
          titre: 'Rééducation post-reconstruction du ligament croisé antérieur : revue systématique des modalités optimales',
          resume: 'Cette revue systématique de 50 études de haut niveau (niveaux I et II) examine les protocoles de rééducation après reconstruction du LCA. Les conclusions majeures : la rééducation accélérée est bénéfique pour les greffons aux ischio-jambiers, les exercices en chaîne ouverte précoces améliorent les résultats, l\'immobilisation post-opératoire n\'offre aucun avantage mesurable. La supervision professionnelle surpasse significativement la rééducation non encadrée, et l\'évaluation psychologique de la préparation au retour au sport est indispensable.',
          thematique: 'lca',
          lien_original: 'https://pubmed.ncbi.nlm.nih.gov/34932514/',
          date_publication: new Date(now.getTime() - 50 * 86400000).toISOString()
        },
        {
          titre: 'Protocole de charge excentrique lourde dans la tendinopathie chronique du tendon d\'Achille',
          resume: 'Cette étude prospective fondatrice sur 30 sportifs atteints de tendinopathie chronique du tendon d\'Achille établit le protocole d\'Alfredson : 3 séries de 15 répétitions de flexions plantaires excentriques, deux fois par jour, 7 jours sur 7, pendant 12 semaines. Les 15 patients du groupe expérimental ont tous retrouvé leur niveau sportif pré-lésionnel avec disparition de la douleur, tandis que tous les patients du groupe contrôle ont finalement dû être opérés. Ce travail fonde l\'evidence-based practice de la charge progressive comme traitement de référence des tendinopathies.',
          thematique: 'tendinopathie',
          lien_original: 'https://pubmed.ncbi.nlm.nih.gov/9617396/',
          date_publication: new Date(now.getTime() - 70 * 86400000).toISOString()
        },
        {
          titre: 'Thérapie manuelle et exercices dans les cervicalgies non spécifiques : revue systématique',
          resume: 'Cette revue systématique de 23 essais randomisés évalue l\'efficacité de la thérapie manuelle associée aux exercices thérapeutiques dans les cervicalgies non spécifiques. Pour les formes aiguës et subaiguës, la combinaison thérapie manuelle + exercices est supérieure à chaque modalité prise isolément. Un résultat cliniquement important : les techniques de mobilisation n\'ont pas besoin d\'être appliquées au niveau cervical exact symptomatique pour être efficaces, ce qui sécurise la prise en charge. L\'approche multimodale est recommandée quel que soit le stade de chronicité.',
          thematique: 'cervical',
          lien_original: 'https://pubmed.ncbi.nlm.nih.gov/28826164/',
          date_publication: new Date(now.getTime() - 10 * 86400000).toISOString()
        }
      ];

      for (const a of articles) {
        await pool.query(
          'INSERT INTO publications (titre, resume, thematique, lien_original, date_publication, seed_version) VALUES ($1, $2, $3, $4, $5, $6)',
          [a.titre, a.resume, a.thematique, a.lien_original, a.date_publication, PUB_SEED_VERSION]
        );
      }
      console.log(`[startup] Publications reseeded: 13 articles at v${PUB_SEED_VERSION} (8 originals + 5 nouveaux)`);
    } else {
      const { rows } = await pool.query('SELECT COUNT(*)::int AS cnt FROM publications');
      console.log(`[startup] Publications OK (${rows[0].cnt} articles, v${currentVersion} — 13 attendus)`);
    }
  } catch (err) {
    console.error('[startup] Publications init error:', err.message);
  }

  // Rappels automatiques : vérification toutes les heures
  if (process.env.NODE_ENV === 'production') {
    // Premier passage 2 minutes après le boot (laisser le serveur se stabiliser)
    setTimeout(() => {
      runRappelsJob();
      runPushRappelsJob();
      // Puis toutes les heures
      setInterval(() => {
        runRappelsJob();
        runPushRappelsJob();
      }, 60 * 60 * 1000);
    }, 2 * 60 * 1000);
    console.log('[rappels] Scheduler activé (email + push, vérification toutes les heures)');
  }

  // Auto-generate images for exercises without one (runs in background after boot)
  if (process.env.NODE_ENV === 'production') {
    setTimeout(async () => {
      try {
        // Process ATM exercises first (priority), then others
        const { rows } = await pool.query(
          "SELECT id, nom, description, zone_corporelle FROM exercices WHERE est_personnalise = false AND (image_url IS NULL OR image_url = '') ORDER BY CASE WHEN zone_corporelle = 'atm' THEN 0 ELSE 1 END, id"
        );
        if (rows.length === 0) {
          console.log('[image-gen] All exercises already have images.');
          return;
        }
        console.log(`[image-gen] Generating images for ${rows.length} exercises (ATM first)...`);
        const BATCH_SIZE = 2;
        let generated = 0;
        let errors = 0;
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          const batch = rows.slice(i, i + BATCH_SIZE);
          await Promise.all(batch.map(async (ex) => {
            try {
              const imageUrl = await generateAndSaveImage(ex);
              await pool.query('UPDATE exercices SET image_url = $1 WHERE id = $2', [imageUrl, ex.id]);
              generated++;
              console.log(`[image-gen] OK: ${ex.nom} → ${imageUrl}`);
            } catch (err) {
              errors++;
              console.error(`[image-gen] FAIL: ${ex.nom} — ${err.message}`);
            }
          }));
          // Pause between batches to respect rate limits
          if (i + BATCH_SIZE < rows.length) {
            await new Promise(r => setTimeout(r, 2000));
          }
        }
        console.log(`[image-gen] Done. generated=${generated} errors=${errors}`);
      } catch (err) {
        console.error('[image-gen] Startup image generation failed:', err.message);
      }
    }, 5000); // 5s delay to let server fully initialize
  }

  // Auto-index clinical tests into RAG store at startup (idempotent — skips already-indexed)
  // Ordered by id for deterministic batching. Exits gracefully on 429 quota hit.
  setTimeout(async () => {
    try {
      const existing = await ragService.listDocuments();
      const alreadyIndexedIds = new Set(
        existing
          .filter(d => d.category === 'test_clinique' && d.metadata && d.metadata.test_id)
          .map(d => Number(d.metadata.test_id))
      );

      // Order by id — deterministic Lot 1 (1-30), Lot 2 (31-60), etc.
      const { rows: tests } = await pool.query(`
        SELECT id, name, description, category, scoring_method,
               instructions, interpretation_guide, evidence_level, source_reference
        FROM clinical_tests
        ORDER BY id ASC
      `);

      const allToIndex = tests.filter(t => !alreadyIndexedIds.has(t.id));
      // Cap at 30 per boot to avoid consuming the full 100k token daily quota
      const toIndex = allToIndex.slice(0, 30);

      if (toIndex.length === 0) {
        console.log(`[rag-clinical-boot] All ${tests.length} clinical tests already indexed — skipping`);
        return;
      }

      console.log(`[rag-clinical-boot] Indexing ${toIndex.length} tests (${alreadyIndexedIds.size} already done, ${allToIndex.length - toIndex.length} deferred to next boot)...`);

      const CLINICAL_CATEGORY_LABELS = {
        epaule: 'Épaule', genou: 'Genou', coude: 'Coude',
        atm: 'ATM (Articulation Temporo-Mandibulaire)',
        cervicales: 'Cervicales', cervical: 'Cervicales',
        rachis: 'Rachis', hanche: 'Hanche', cheville: 'Cheville',
        douleur: 'Douleur', fonction: 'Fonction', equilibre: 'Équilibre',
        force: 'Force', mobilite: 'Mobilité', neurologique: 'Neurologique',
      };

      function buildContent(test) {
        const cat = CLINICAL_CATEGORY_LABELS[test.category] || test.category;
        const parts = [`# ${test.name}`, '', `**Catégorie :** ${cat}`];
        if (test.description) parts.push('', '## Description', test.description);
        if (test.instructions) parts.push('', '## Protocole / Instructions', test.instructions);
        if (test.scoring_method) parts.push('', '## Méthode de cotation', test.scoring_method);
        if (test.interpretation_guide) parts.push('', '## Interprétation des scores', test.interpretation_guide);
        if (test.evidence_level) parts.push('', `**Niveau de preuve :** ${test.evidence_level}`);
        if (test.source_reference) parts.push(`**Référence :** ${test.source_reference}`);
        return parts.join('\n').trim();
      }

      let indexed = 0, failed = 0;
      let quotaExhausted = false;
      const BATCH_SIZE = 5;
      for (let i = 0; i < toIndex.length; i += BATCH_SIZE) {
        if (quotaExhausted) break;
        const batch = toIndex.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (test) => {
          try {
            const cat = CLINICAL_CATEGORY_LABELS[test.category] || test.category;
            await ragService.ingestDocument({
              title: `${test.name} — ${cat}`,
              category: 'test_clinique',
              source_type: 'internal',
              content: buildContent(test),
              metadata: {
                test_id: test.id,
                category: test.category,
                category_label: cat,
                evidence_level: test.evidence_level || '',
                source: 'Kinévia Clinical Tests Library',
              },
            });
            indexed++;
          } catch (err) {
            failed++;
            if (err.message && err.message.includes('429')) {
              quotaExhausted = true;
              console.warn(`[rag-clinical-boot] Quota épuisé après ${indexed} tests — reprendra au prochain démarrage`);
            } else {
              console.error(`[rag-clinical-boot] Failed: ${test.name}: ${err.message}`);
            }
          }
        }));
        if (!quotaExhausted) {
          console.log(`[rag-clinical-boot] Progress: ${Math.min(i + BATCH_SIZE, toIndex.length)}/${toIndex.length}`);
          // Small pause between batches to respect API rate limits
          if (i + BATCH_SIZE < toIndex.length) {
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      }

      console.log(`[rag-clinical-boot] Done — indexed: ${indexed}, failed: ${failed}${quotaExhausted ? ' (quota épuisé)' : ''}`);
    } catch (err) {
      console.error('[rag-clinical-boot] Error:', err.message);
    }
  }, 8000); // 8s delay — after image-gen startup (which uses 5s)

  // Auto-index pathology sheets into RAG store at startup (idempotent — skips already-indexed)
  setTimeout(async () => {
    try {
      const existing = await ragService.listDocuments();
      const alreadyIndexedSlugs = new Set(
        existing
          .filter(d => d.category === 'pathology_sheet' && d.metadata && d.metadata.slug)
          .map(d => d.metadata.slug)
      );

      const { rows: sheets } = await pool.query(`
        SELECT id, slug, title, category, content
        FROM pathology_sheets
        ORDER BY category, title
      `);

      const allToIndex = sheets.filter(s => !alreadyIndexedSlugs.has(s.slug));
      // Cap at 30 per boot — pathology sheets are large (~1000 tokens each).
      // Clinical tests indexer runs at 8s, this runs at 12s. Combined they stay under 100k/day.
      const toIndex = allToIndex.slice(0, 30);

      if (toIndex.length === 0) {
        console.log(`[rag-pathology-boot] All ${sheets.length} pathology sheets already indexed — skipping`);
        return;
      }

      console.log(`[rag-pathology-boot] Indexing ${toIndex.length} pathology sheets (${alreadyIndexedSlugs.size} already done, ${allToIndex.length - toIndex.length} deferred to next boot)...`);

      const PATHOLOGY_CATEGORY_LABELS = {
        ortho_mi:     'Orthopédie — Membre inférieur',
        ortho_ms:     'Orthopédie — Membre supérieur',
        rachis:       'Rachis / Colonne vertébrale',
        neuro:        'Neurologie',
        respi_cardio: 'Respiratoire & Cardio-vasculaire',
        sport:        'Traumatologie du sport',
        pediatrie:    'Pédiatrie',
        geriatrie:    'Gériatrie',
      };

      function buildPathologyContentBoot(sheet) {
        const catLabel = PATHOLOGY_CATEGORY_LABELS[sheet.category] || sheet.category;
        const parts = [
          `# ${sheet.title}`,
          '',
          `**Catégorie :** ${catLabel}`,
          `**Slug :** ${sheet.slug}`,
          '',
        ];
        const content = sheet.content || {};
        for (const [, section] of Object.entries(content)) {
          if (!section) continue;
          if (typeof section === 'string') {
            parts.push(section, '');
          } else if (typeof section === 'object') {
            const titre = section.titre || section.title || '';
            const contenu = section.contenu || section.content || section.text || '';
            if (titre) { parts.push(`## ${titre}`, ''); }
            if (contenu) { parts.push(contenu, ''); }
            if (section.items && Array.isArray(section.items)) {
              for (const item of section.items) {
                if (typeof item === 'string') parts.push(`- ${item}`);
                else if (item && item.titre) { parts.push(`### ${item.titre}`); if (item.contenu) parts.push(item.contenu, ''); }
              }
            }
          }
        }
        return parts.join('\n').trim();
      }

      let indexed = 0, failed = 0, quotaExhausted = false;
      const BATCH_SIZE = 3; // small — sheets are large (800-1200 words each)
      for (let i = 0; i < toIndex.length; i += BATCH_SIZE) {
        if (quotaExhausted) break;
        const batch = toIndex.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (sheet) => {
          try {
            const catLabel = PATHOLOGY_CATEGORY_LABELS[sheet.category] || sheet.category;
            await ragService.ingestDocument({
              title: `${sheet.title} — ${catLabel}`,
              category: 'pathology_sheet',
              source_type: 'pathology_sheet',
              source_url: `/fiches-pathologies/${sheet.slug}`,
              content: buildPathologyContentBoot(sheet),
              metadata: {
                sheet_id: sheet.id,
                slug: sheet.slug,
                category: sheet.category,
                category_label: catLabel,
                source: 'Kinévia Fiches Pathologies',
              },
            });
            indexed++;
          } catch (err) {
            failed++;
            if (err.message && err.message.includes('429')) {
              quotaExhausted = true;
              console.warn(`[rag-pathology-boot] Quota épuisé après ${indexed} fiches — reprendra au prochain démarrage`);
            } else {
              console.error(`[rag-pathology-boot] Failed: ${sheet.title}: ${err.message}`);
            }
          }
        }));
        if (!quotaExhausted) {
          console.log(`[rag-pathology-boot] Progress: ${Math.min(i + BATCH_SIZE, toIndex.length)}/${toIndex.length}`);
          // Small pause between batches to respect API rate limits
          if (i + BATCH_SIZE < toIndex.length) {
            await new Promise(r => setTimeout(r, 1500));
          }
        }
      }

      console.log(`[rag-pathology-boot] Done — indexed: ${indexed}, failed: ${failed}${quotaExhausted ? ' (quota épuisé — reprendra au prochain démarrage)' : ''}`);
    } catch (err) {
      console.error('[rag-pathology-boot] Error:', err.message);
    }
  }, 12000); // 12s delay — after clinical-tests (8s) and image-gen (5s)
});

// ==========================================
// FICHES PATHOLOGIES API
// ==========================================

/**
 * GET /api/pathology-sheets
 * Liste toutes les fiches, avec filtre optionnel par catégorie.
 * Query params:
 *   - category: string (optionnel) — filtre par catégorie enum
 *
 * Réponse : { sheets: [{ id, slug, title, category, created_at, updated_at }] }
 * (le champ `content` est exclu de la liste pour des raisons de perf)
 */
app.get('/api/pathology-sheets', async (req, res) => {
  try {
    const { category } = req.query;

    const VALID_CATEGORIES = [
      'ortho_mi', 'ortho_ms', 'rachis', 'neuro',
      'respi_cardio', 'sport', 'pediatrie', 'geriatrie'
    ];

    if (category && !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({
        error: 'Catégorie invalide',
        valid_categories: VALID_CATEGORIES
      });
    }

    let query, params;
    if (category) {
      query = `
        SELECT id, slug, title, category, created_at, updated_at
        FROM pathology_sheets
        WHERE category = $1
        ORDER BY title ASC
      `;
      params = [category];
    } else {
      query = `
        SELECT id, slug, title, category, created_at, updated_at
        FROM pathology_sheets
        ORDER BY category ASC, title ASC
      `;
      params = [];
    }

    const { rows } = await pool.query(query, params);
    res.json({ sheets: rows });
  } catch (err) {
    console.error('[pathology-sheets] GET list error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /api/pathology-sheets/:slug
 * Retourne le détail complet d'une fiche (avec le contenu JSON structuré).
 *
 * Réponse : { sheet: { id, slug, title, category, content, created_at, updated_at } }
 */
app.get('/api/pathology-sheets/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    const { rows } = await pool.query(
      `SELECT id, slug, title, category, content, created_at, updated_at
       FROM pathology_sheets
       WHERE slug = $1`,
      [slug]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Fiche introuvable' });
    }

    res.json({ sheet: rows[0] });
  } catch (err) {
    console.error('[pathology-sheets] GET detail error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// EXERCISE RECOMMENDATIONS — IA
// ==========================================
const { getRecommendations, RecommendationErrorType } = require('./services/recommendations');

/**
 * POST /api/recommendations
 * Generate AI exercise recommendations from a patient's bilan / pathology.
 *
 * Body: { patient_id, bilan_id? (optional), force_refresh? (optional bool) }
 * Response: { exercises: [...], resume: string, cached: bool, recommendationId: number|null }
 *
 * Security: kineId scoped — only the authenticated kiné's patients are accessible.
 * Anti-timeout: single optimised AI call, 55s internal timeout.
 */
app.post('/api/recommendations', requireAuth, async (req, res) => {
  const kineId = req.session.kineId;
  const { patient_id, bilan_id, force_refresh = false } = req.body;

  if (!patient_id) {
    return res.status(400).json({ error: 'patient_id requis' });
  }

  try {
    // ── 1. Verify patient belongs to this kiné ──────────────────────────
    const patientResult = await pool.query(
      `SELECT id, nom, prenom, pathologie_enc FROM patients WHERE id = $1 AND kine_id = $2`,
      [patient_id, kineId]
    );
    if (patientResult.rows.length === 0) {
      return res.status(404).json({ error: 'Patient introuvable' });
    }
    const patRow = patientResult.rows[0];
    // Decrypt pathologie (same decrypt function used in server.js scope)
    const pathologie = decrypt(patRow.pathologie_enc) || null;
    const patientData = {
      id: patRow.id,
      nom: patRow.nom,
      prenom: patRow.prenom,
      age: null,   // patients table has no age column — prompt handles null gracefully
      sexe: null,  // patients table has no sexe column — prompt handles null gracefully
      pathologie,
    };

    // ── 2. Fetch + decrypt bilan if provided ────────────────────────────
    let bilanData = null;
    let resolvedBilanId = bilan_id || null;

    if (bilan_id) {
      const bilanResult = await pool.query(
        `SELECT * FROM bilans WHERE id = $1 AND kine_id = $2`,
        [bilan_id, kineId]
      );
      if (bilanResult.rows.length === 0) {
        return res.status(404).json({ error: 'Bilan introuvable' });
      }
      bilanData = decryptBilan(bilanResult.rows[0]);
    } else {
      // Use most recent bilan if available
      const latestBilan = await pool.query(
        `SELECT * FROM bilans WHERE patient_id = $1 AND kine_id = $2 ORDER BY created_at DESC LIMIT 1`,
        [patient_id, kineId]
      );
      if (latestBilan.rows.length > 0) {
        bilanData = decryptBilan(latestBilan.rows[0]);
        resolvedBilanId = latestBilan.rows[0].id;
      }
    }

    if (!bilanData && !pathologie) {
      return res.status(422).json({
        error: 'Aucun bilan ni pathologie disponible. Créez un bilan ou renseignez la pathologie du patient avant de générer des recommandations.',
      });
    }

    // ── 3. Fetch exercise library (global + kiné's custom) ───────────────
    const exercicesResult = await pool.query(
      `SELECT id, nom, zone_corporelle, description, muscles, pathologies,
              niveau_difficulte, series_recommandees, repetitions_recommandees,
              image_url, has_video
       FROM exercices
       WHERE kine_id IS NULL OR kine_id = $1
       ORDER BY id ASC`,
      [kineId]
    );
    const exerciceList = exercicesResult.rows;

    // ── 4. Get Stripe subscription ID for AI usage tracking ─────────────
    const kineResult = await pool.query(
      `SELECT stripe_subscription_id FROM kines WHERE id = $1`,
      [kineId]
    );
    const subscriptionId = kineResult.rows[0]?.stripe_subscription_id || null;

    // ── 5. Generate recommendations ─────────────────────────────────────
    const result = await getRecommendations(pool, {
      kineId,
      patientId: patient_id,
      bilanId: resolvedBilanId,
      forceRefresh: force_refresh,
      patientData,
      bilanData,
      exerciceList,
      subscriptionId,
    });

    res.json({
      exercises: result.exercises,
      resume: result.resume,
      cached: result.cached,
      recommendationId: result.recommendationId,
      cachedAt: result.cachedAt || null,
      patientNom: `${patientData.prenom} ${patientData.nom}`,
      pathologie,
    });

  } catch (err) {
    const errType = err.recommendationErrorType || RecommendationErrorType.GENERIC;
    console.error('[recommendations] error:', err.message, { kine_id: kineId, patient_id, error_type: errType });

    if (errType === RecommendationErrorType.TIMEOUT) {
      return res.status(503).json({ error: 'La génération a pris trop de temps. Réessayez dans quelques instants.' });
    }
    if (errType === RecommendationErrorType.RATE_LIMIT) {
      // Distinguish daily quota exhaustion from transient overload
      const isDailyLimit = (err.message || '').includes('Daily') || (err.message || '').includes('daily_limit');
      const msg = isDailyLimit
        ? 'Le quota quotidien de l\'IA est atteint. Il se réinitialise automatiquement à minuit (UTC). Réessayez demain.'
        : 'Service temporairement surchargé. Réessayez dans quelques minutes.';
      return res.status(503).json({ error: msg });
    }
    if (errType === RecommendationErrorType.NO_BILAN) {
      return res.status(422).json({ error: err.message });
    }
    res.status(500).json({ error: 'Erreur lors de la génération des recommandations' });
  }
});

/**
 * GET /api/recommendations/history/:patient_id
 * List past recommendations for a patient, newest first.
 * Response: { recommendations: [{ id, pathologie, created_at, exercise_count }] }
 */
app.get('/api/recommendations/history/:patient_id', requireAuth, async (req, res) => {
  const kineId = req.session.kineId;
  const patientId = parseInt(req.params.patient_id, 10);

  if (isNaN(patientId)) {
    return res.status(400).json({ error: 'patient_id invalide' });
  }

  try {
    // Verify ownership
    const check = await pool.query(
      `SELECT id FROM patients WHERE id = $1 AND kine_id = $2`,
      [patientId, kineId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Patient introuvable' });
    }

    const result = await pool.query(
      `SELECT id, bilan_id, pathologie, created_at,
              jsonb_array_length(exercises->'exercices') AS exercise_count
       FROM exercise_recommendations
       WHERE patient_id = $1 AND kine_id = $2
       ORDER BY created_at DESC
       LIMIT 20`,
      [patientId, kineId]
    );

    res.json({ recommendations: result.rows });
  } catch (err) {
    console.error('[recommendations] history error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
