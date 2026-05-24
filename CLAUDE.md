# Kinévia — CLAUDE.md

## What this app does
Kinévia is a SaaS platform for French physiotherapists (kinésithérapeutes). It lets them manage patients, create rehabilitation programmes, track exercises, and access evidence-based clinical resources (pathology sheets, protocols, clinical tests).

## Stack
Node.js + Express · PostgreSQL (Clever Cloud — NOT Neon; MCP query_db hits Neon but production uses Clever Cloud via DATABASE_URL) · Vanilla JS SPA (public/app.html) · Tailwind CDN · Render deployment

## Directory map
- `server.js` — Legacy monolith entry (7600+ lines). Routes, auth, all business logic. Do not add to.
- `public/` — Static frontend. `app.html` is the full SPA (9100+ lines). Patient-facing: `patient.html`.
- `services/` — Legacy service files. Do not add to.
- `migrations/` — node-pg-migrate JS migrations. All DDL goes here.
- `routes/` — New Express Router modules (admin-export.js, admin-image-gen.js, admin-analytics.js, admin-schema-export.js, objectif-ia.js, well-known.js). Mounted via app.use in server.js.
- `db/` — Query modules. `admin-analytics.js`: filtered analytics queries (excludes demo/beta accounts). `admin-export.js`: DB export queries for admin endpoint.
- `scripts/` — One-off utility scripts (seeding, imports).
- `.claude/skills/` — Polsia agent skill files.

## Database (35 tables)
- `kines` — Physiotherapist accounts and subscription data.
- `patients` — Patient records linked to kines. Encrypted columns via *_enc suffix (AES-256-GCM HDS).
- `programmes` — Rehabilitation programmes with exercises.
- `programme_exercices` — Many-to-many: exercises in programmes.
- `exercices` — Exercise library (custom + seeded). image_url, video_url from R2.
- `seances` — Individual session records. Encrypted columns via *_enc suffix.
- `bilans` — Patient clinical assessments. Encrypted columns via *_enc suffix.
- `clinical_tests` / `clinical_test_items` — Evidence-based clinical tests by body region.
- `protocols` — Rehabilitation protocols (52 EBP entries).
- `conversations` — AI chat conversations (used by `/api/chat-ai`).
- `messages` — Patient-kine secure messaging.
- `exercice_videos` — Video URLs per exercise (R2-backed).
- `video_feedback` — Patient video feedback on exercises.
- `programme_rappels` — Programme-level reminder configurations.
- `rappel_logs` — Reminder dispatch audit log.
- `push_subscriptions` / `patient_push_subscriptions` / `kine_notification_prefs` / `patient_notification_prefs` — Push + notification prefs.
- `email_verification_tokens` / `magic_link_tokens` / `password_reset_tokens` — Auth tokens.
- `cookie_consents` / `patient_health_consents` / `patient_email_prefs` — RGPD/GDPR compliance.
- `kine_subscription_events` — Stripe subscription event log.
- `health_access_logs` — Patient health data access audit.
- `publications` — Educational blog articles (13 articles).
- `beta_signups` — Pre-launch beta signups.
- `users` / `session` — PostgreSQL session store (M061).
- `zones_corporelles` — Body zone taxonomy for exercises.
- `_migrations` — node-pg-migrate run record.

## External integrations
- Anthropic Claude — AI chat assistant (`/api/chat-ai`).
- Polsia OpenAI proxy — RAG embeddings, exercise descriptions.
- Polsia R2 — Exercise video/image storage.
- Stripe — Subscriptions via Polsia payment proxy.
- Postmark — Transactional emails.

## Recent changes
- 2026-05-22: RGPD fix — removed kine_id from /connexion?email_error=lien_expire redirect URL (server.js line ~864). Internal DB ID was leaking into URL/logs/Referrer headers. Frontend never used it. All auth forms already POST-only via fetch.
- 2026-05-18: schema.sql static file — Complete DB schema (35 tables, 2 enums, 34 sequences, 37 FKs, 2 check constraints, 55 indexes). Extracted from Neon via polsia_infra query_db. Committed to repo root. For Scalingo migration.
- 2026-05-18: Schema SQL export endpoint — GET /api/admin/schema-export (routes/admin-schema-export.js). Reconstruit le schéma complet via information_schema (tables, colonnes, contraintes, index, séquences, enums). Retourne text/plain SQL avec Content-Disposition: attachment; filename=schema.sql. Auth via SCHEMA_EXPORT_KEY query param (no session required). Endpoint temporaire pour migration Neon→Scalingo.
- 2026-05-18: Export DB admin endpoint — GET /api/admin/export-db (routes/admin-export.js, db/admin-export.js). Streaming JSON export of all 35 tables with schema metadata. Auth: requireAdmin session + ADMIN_EXPORT_TOKEN env var fallback. BigInt-safe serialization. Encrypted columns exported as-is. Temporary endpoint for Render→Scalingo migration; remove post-migration.
- 2026-05-17: Chiffrement AES-256-GCM HDS — services/crypto.js (utilitaire encrypt/decrypt/decryptInt/isEncrypted réutilisable). Migration 102 backfille les données patients/séances/bilans existantes vers colonnes *_enc. Script scripts/backfill-encrypt.js pour exécution manuelle. ENCRYPTION_KEY déjà en prod. TLS 1.2+ assuré par Render (app↔client) + SSL Clever Cloud (app↔DB).
- 2026-05-17: Reset analytics — Jour 1 phase commerciale. COMMERCIAL_LAUNCH_DATE='2026-05-17' ajouté dans db/admin-analytics.js. Toutes les requêtes (page_views, signups, stats) sont désormais filtrées à partir de cette date. Les comptes démo (@demo.kinevia.pro) et beta (lifetime_free) restent exclus en plus du filtre date.
- 2026-05-17: TWA Google Play Store — manifest.json mis à jour (start_url, scope, id, theme_color, shortcuts). Route `/.well-known/assetlinks.json` ajoutée via routes/well-known.js (montée avant express.static qui ignore les dotfiles). assetlinks.json placeholder dans public/.well-known/ — SHA-256 à remplacer après génération keystore PWABuilder. Guide complet dans docs/google-play-twa.md.
- 2026-05-17: Protocoles Cervicaux (5 nouveaux) — Migration 101 insère 5 protocoles cervicaux EBP : Névralgie cervico-brachiale, Whiplash/WAD, Cervicarthrose dégénérative, Torticolis aigu, Myélopathie cervicarthrosique. Protocols table passe à 52 entrées.
