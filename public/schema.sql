-- ============================================================
-- Kinévia PostgreSQL Schema
-- Generated: 2026-05-18
-- Source: Clever Cloud production DB (post-migration: Neon → Scalingo)
-- ============================================================

-- ── ENUMS ─────────────────────────────────────────────────────
CREATE TYPE clinical_test_category AS ENUM ('douleur', 'fonction', 'equilibre', 'respiratoire', 'force', 'mobilite', 'neurologique', 'psychologique', 'cervical', 'rachis', 'hanche', 'cheville', 'epaule', 'genou', 'coude', 'atm');
CREATE TYPE clinical_test_response_type AS ENUM ('scale', 'boolean', 'numeric', 'text');

-- ── SEQUENCES ─────────────────────────────────────────────────
CREATE SEQUENCE _migrations_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE beta_signups_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE bilans_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE clinical_test_items_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE clinical_tests_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE conversations_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE cookie_consents_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE email_verification_tokens_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE exercices_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE exercise_videos_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE health_access_logs_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807;
CREATE SEQUENCE kine_notification_prefs_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE kine_subscription_events_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807;
CREATE SEQUENCE kines_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE magic_link_tokens_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE messages_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE password_reset_tokens_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE patient_email_prefs_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE patient_health_consents_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE patient_notification_prefs_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE patient_push_subscriptions_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE patients_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE programme_exercices_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE programme_rappels_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE programmes_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE protocols_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE publications_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE push_subscriptions_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE rappel_logs_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807;
CREATE SEQUENCE seance_exercices_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE seances_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE users_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE video_feedback_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;
CREATE SEQUENCE zones_corporelles_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647;

-- ── TABLE: _migrations ──────────────────────────────────────────
CREATE TABLE _migrations (
  id INTEGER NOT NULL DEFAULT nextval('_migrations_id_seq'::regclass),
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);
ALTER TABLE _migrations ADD CONSTRAINT _migrations_name_key UNIQUE (name);

-- ── TABLE: beta_signups ──────────────────────────────────────────
CREATE TABLE beta_signups (
  id INTEGER NOT NULL DEFAULT nextval('beta_signups_id_seq'::regclass),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  patients_per_week INTEGER,
  signed_up_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (id)
);
ALTER TABLE beta_signups ADD CONSTRAINT beta_signups_email_key UNIQUE (email);

-- ── TABLE: bilans ──────────────────────────────────────────
CREATE TABLE bilans (
  id INTEGER NOT NULL DEFAULT nextval('bilans_id_seq'::regclass),
  kine_id INTEGER NOT NULL,
  patient_id INTEGER NOT NULL,
  douleur_initiale INTEGER,
  mobilite_initiale VARCHAR(255),
  objectifs TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  type VARCHAR(50) DEFAULT 'initial'::character varying,
  date_bilan DATE DEFAULT CURRENT_DATE,
  observations TEXT,
  mesures TEXT,
  douleur_initiale_enc TEXT,
  mobilite_initiale_enc TEXT,
  objectifs_enc TEXT,
  notes_enc TEXT,
  observations_enc TEXT,
  mesures_enc TEXT,
  donnees_cliniques_enc TEXT,
  functional_scale INTEGER,
  functional_details_enc TEXT,
  observations_praticien_enc TEXT,
  conclusion_bilan_enc TEXT,
  synthese_redigee_enc TEXT,
  PRIMARY KEY (id)
);
ALTER TABLE bilans ADD CONSTRAINT bilans_functional_scale_check CHECK (((functional_scale >= 0) AND (functional_scale <= 10)));
ALTER TABLE bilans ADD CONSTRAINT bilans_kine_id_fkey FOREIGN KEY (kine_id) REFERENCES kines(id) ON DELETE CASCADE;
ALTER TABLE bilans ADD CONSTRAINT bilans_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE;
CREATE INDEX bilans_kine_id_idx ON bilans USING btree (kine_id);
CREATE INDEX bilans_patient_id_idx ON bilans USING btree (patient_id);

-- ── TABLE: clinical_test_items ──────────────────────────────────────────
CREATE TABLE clinical_test_items (
  id INTEGER NOT NULL DEFAULT nextval('clinical_test_items_id_seq'::regclass),
  clinical_test_id INTEGER NOT NULL,
  item_number INTEGER NOT NULL,
  question_text TEXT NOT NULL,
  response_type clinical_test_response_type NOT NULL,
  scale_min INTEGER,
  scale_max INTEGER,
  scale_labels JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (id)
);
ALTER TABLE clinical_test_items ADD CONSTRAINT clinical_test_items_clinical_test_id_fkey FOREIGN KEY (clinical_test_id) REFERENCES clinical_tests(id) ON DELETE CASCADE;
CREATE INDEX clinical_test_items_test_id_idx ON clinical_test_items USING btree (clinical_test_id);

-- ── TABLE: clinical_tests ──────────────────────────────────────────
CREATE TABLE clinical_tests (
  id INTEGER NOT NULL DEFAULT nextval('clinical_tests_id_seq'::regclass),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  category clinical_test_category NOT NULL,
  scoring_method TEXT,
  instructions TEXT,
  interpretation_guide TEXT,
  evidence_level VARCHAR(10),
  source_reference TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (id)
);

-- ── TABLE: conversations ──────────────────────────────────────────
CREATE TABLE conversations (
  id INTEGER NOT NULL DEFAULT nextval('conversations_id_seq'::regclass),
  kine_id INTEGER NOT NULL,
  patient_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived BOOLEAN NOT NULL DEFAULT false,
  archived_at TIMESTAMPTZ,
  PRIMARY KEY (id)
);
ALTER TABLE conversations ADD CONSTRAINT conversations_kine_id_fkey FOREIGN KEY (kine_id) REFERENCES kines(id) ON DELETE CASCADE;
ALTER TABLE conversations ADD CONSTRAINT conversations_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE;
ALTER TABLE conversations ADD CONSTRAINT conversations_kine_patient_unique UNIQUE (kine_id, patient_id);
CREATE INDEX conversations_kine_active_idx ON conversations USING btree (kine_id, archived) WHERE (archived = false);
CREATE INDEX conversations_kine_id_idx ON conversations USING btree (kine_id);
CREATE INDEX conversations_patient_id_idx ON conversations USING btree (patient_id);

-- ── TABLE: cookie_consents ──────────────────────────────────────────
CREATE TABLE cookie_consents (
  id INTEGER NOT NULL DEFAULT nextval('cookie_consents_id_seq'::regclass),
  visitor_id VARCHAR(64),
  kine_id INTEGER,
  functional_cookies BOOLEAN NOT NULL DEFAULT true,
  analytics_cookies BOOLEAN NOT NULL DEFAULT false,
  consented_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip_hash VARCHAR(64),
  user_agent TEXT,
  PRIMARY KEY (id)
);
ALTER TABLE cookie_consents ADD CONSTRAINT cookie_consents_kine_id_fkey FOREIGN KEY (kine_id) REFERENCES kines(id) ON DELETE SET NULL;
ALTER TABLE cookie_consents ADD CONSTRAINT cookie_consents_visitor_id_key UNIQUE (visitor_id);
CREATE INDEX idx_cookie_consents_visitor ON cookie_consents USING btree (visitor_id);

-- ── TABLE: email_verification_tokens ──────────────────────────────────────────
CREATE TABLE email_verification_tokens (
  id INTEGER NOT NULL DEFAULT nextval('email_verification_tokens_id_seq'::regclass),
  kine_id INTEGER NOT NULL,
  token VARCHAR(128) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (id)
);
ALTER TABLE email_verification_tokens ADD CONSTRAINT email_verification_tokens_kine_id_fkey FOREIGN KEY (kine_id) REFERENCES kines(id) ON DELETE CASCADE;
ALTER TABLE email_verification_tokens ADD CONSTRAINT email_verification_tokens_token_key UNIQUE (token);
CREATE INDEX evt_kine_id_idx ON email_verification_tokens USING btree (kine_id);
CREATE INDEX evt_token_idx ON email_verification_tokens USING btree (token);

-- ── TABLE: exercices ──────────────────────────────────────────
CREATE TABLE exercices (
  id INTEGER NOT NULL DEFAULT nextval('exercices_id_seq'::regclass),
  nom VARCHAR(255) NOT NULL,
  zone_corporelle VARCHAR(50) NOT NULL,
  description TEXT,
  image_url TEXT,
  video_url TEXT,
  est_personnalise BOOLEAN DEFAULT false,
  kine_id INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  series_recommandees INTEGER DEFAULT 3,
  repetitions_recommandees VARCHAR(50) DEFAULT '10'::character varying,
  muscles TEXT DEFAULT ''::text,
  pathologies TEXT DEFAULT ''::text,
  niveau_difficulte VARCHAR(20) DEFAULT 'moyen'::character varying,
  has_video BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (id)
);
ALTER TABLE exercices ADD CONSTRAINT exercices_kine_id_fkey FOREIGN KEY (kine_id) REFERENCES kines(id) ON DELETE SET NULL;
CREATE INDEX exercices_kine_id_idx ON exercices USING btree (kine_id);
CREATE INDEX exercices_zone_idx ON exercices USING btree (zone_corporelle);
CREATE INDEX idx_exercices_has_video ON exercices USING btree (has_video) WHERE (has_video = true);

-- ── TABLE: exercise_videos ──────────────────────────────────────────
CREATE TABLE exercise_videos (
  id INTEGER NOT NULL DEFAULT nextval('exercise_videos_id_seq'::regclass),
  exercise_id INTEGER NOT NULL,
  video_url TEXT NOT NULL,
  thumbnail_url TEXT,
  duration_seconds INTEGER,
  file_size BIGINT,
  original_filename VARCHAR(255),
  mime_type VARCHAR(50) NOT NULL DEFAULT 'video/mp4'::character varying,
  upload_status VARCHAR(20) NOT NULL DEFAULT 'ready'::character varying,
  uploaded_by INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source VARCHAR(100),
  source_url TEXT,
  PRIMARY KEY (id)
);
ALTER TABLE exercise_videos ADD CONSTRAINT exercise_videos_exercise_id_fkey FOREIGN KEY (exercise_id) REFERENCES exercices(id) ON DELETE CASCADE;
ALTER TABLE exercise_videos ADD CONSTRAINT exercise_videos_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES kines(id) ON DELETE SET NULL;
CREATE INDEX idx_exercise_videos_exercise_id ON exercise_videos USING btree (exercise_id);

-- ── TABLE: health_access_logs ──────────────────────────────────────────
CREATE TABLE health_access_logs (
  id BIGINT NOT NULL DEFAULT nextval('health_access_logs_id_seq'::regclass),
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kine_id INTEGER,
  resource_type VARCHAR(50) NOT NULL,
  resource_id INTEGER NOT NULL,
  patient_id INTEGER,
  action VARCHAR(20) NOT NULL,
  endpoint VARCHAR(255),
  ip_address VARCHAR(45),
  PRIMARY KEY (id)
);
ALTER TABLE health_access_logs ADD CONSTRAINT health_access_logs_kine_id_fkey FOREIGN KEY (kine_id) REFERENCES kines(id) ON DELETE SET NULL;
ALTER TABLE health_access_logs ADD CONSTRAINT health_access_logs_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE SET NULL;
CREATE INDEX hal_accessed_at_idx ON health_access_logs USING btree (accessed_at DESC);
CREATE INDEX hal_kine_id_idx ON health_access_logs USING btree (kine_id);
CREATE INDEX hal_patient_id_idx ON health_access_logs USING btree (patient_id);
CREATE INDEX hal_resource_idx ON health_access_logs USING btree (resource_type, resource_id);

-- ── TABLE: kine_notification_prefs ──────────────────────────────────────────
CREATE TABLE kine_notification_prefs (
  id INTEGER NOT NULL DEFAULT nextval('kine_notification_prefs_id_seq'::regclass),
  kine_id INTEGER NOT NULL,
  alertes_feedback_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
ALTER TABLE kine_notification_prefs ADD CONSTRAINT kine_notification_prefs_kine_id_fkey FOREIGN KEY (kine_id) REFERENCES kines(id) ON DELETE CASCADE;
ALTER TABLE kine_notification_prefs ADD CONSTRAINT kine_notification_prefs_kine_id_key UNIQUE (kine_id);

-- ── TABLE: kine_subscription_events ──────────────────────────────────────────
CREATE TABLE kine_subscription_events (
  id BIGINT NOT NULL DEFAULT nextval('kine_subscription_events_id_seq'::regclass),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kine_id INTEGER,
  event_type VARCHAR(100) NOT NULL,
  stripe_event_id VARCHAR(255),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (id)
);
ALTER TABLE kine_subscription_events ADD CONSTRAINT kine_subscription_events_kine_id_fkey FOREIGN KEY (kine_id) REFERENCES kines(id) ON DELETE SET NULL;
CREATE INDEX kine_sub_events_kine_id_idx ON kine_subscription_events USING btree (kine_id, occurred_at DESC);
CREATE UNIQUE INDEX kine_sub_events_stripe_event_id_idx ON kine_subscription_events USING btree (stripe_event_id) WHERE (stripe_event_id IS NOT NULL);

-- ── TABLE: kines ──────────────────────────────────────────
CREATE TABLE kines (
  id INTEGER NOT NULL DEFAULT nextval('kines_id_seq'::regclass),
  nom VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  mot_de_passe_hash VARCHAR(255) NOT NULL,
  cabinet VARCHAR(255),
  telephone VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT now(),
  prenom VARCHAR(255),
  is_admin BOOLEAN NOT NULL DEFAULT false,
  subscription_status_test VARCHAR(50) NOT NULL DEFAULT 'trialing'::character varying,
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  subscription_status VARCHAR(50) NOT NULL DEFAULT 'trialing'::character varying,
  trial_ends_at TIMESTAMPTZ,
  subscription_ends_at TIMESTAMPTZ,
  subscription_updated_at TIMESTAMPTZ,
  email_verified_at TIMESTAMPTZ,
  lifetime_free BOOLEAN NOT NULL DEFAULT false,
  rpps VARCHAR(11),
  adresse TEXT,
  has_seen_onboarding BOOLEAN NOT NULL DEFAULT false,
  onboarding_step VARCHAR(50),
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX kines_email_unique_idx ON kines USING btree (lower((email)::text));
CREATE INDEX kines_stripe_customer_id_idx ON kines USING btree (stripe_customer_id) WHERE (stripe_customer_id IS NOT NULL);
CREATE INDEX kines_stripe_subscription_id_idx ON kines USING btree (stripe_subscription_id) WHERE (stripe_subscription_id IS NOT NULL);

-- ── TABLE: magic_link_tokens ──────────────────────────────────────────
CREATE TABLE magic_link_tokens (
  id INTEGER NOT NULL DEFAULT nextval('magic_link_tokens_id_seq'::regclass),
  kine_id INTEGER NOT NULL,
  token VARCHAR(128) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (id)
);
ALTER TABLE magic_link_tokens ADD CONSTRAINT magic_link_tokens_kine_id_fkey FOREIGN KEY (kine_id) REFERENCES kines(id) ON DELETE CASCADE;
ALTER TABLE magic_link_tokens ADD CONSTRAINT magic_link_tokens_token_key UNIQUE (token);
CREATE INDEX magic_link_tokens_kine_id_idx ON magic_link_tokens USING btree (kine_id);
CREATE INDEX magic_link_tokens_token_idx ON magic_link_tokens USING btree (token);

-- ── TABLE: messages ──────────────────────────────────────────
CREATE TABLE messages (
  id INTEGER NOT NULL DEFAULT nextval('messages_id_seq'::regclass),
  conversation_id INTEGER NOT NULL,
  sender_type VARCHAR(10) NOT NULL,
  sender_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (id)
);
ALTER TABLE messages ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE messages ADD CONSTRAINT messages_sender_type_check CHECK (((sender_type)::text = ANY ((ARRAY['kine'::character varying, 'patient'::character varying])::text[])));
CREATE INDEX messages_conversation_id_created_at_idx ON messages USING btree (conversation_id, created_at);
CREATE INDEX messages_deleted_at_idx ON messages USING btree (deleted_at) WHERE (deleted_at IS NULL);

-- ── TABLE: password_reset_tokens ──────────────────────────────────────────
CREATE TABLE password_reset_tokens (
  id INTEGER NOT NULL DEFAULT nextval('password_reset_tokens_id_seq'::regclass),
  kine_id INTEGER NOT NULL,
  token VARCHAR(128) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (id)
);
ALTER TABLE password_reset_tokens ADD CONSTRAINT password_reset_tokens_kine_id_fkey FOREIGN KEY (kine_id) REFERENCES kines(id) ON DELETE CASCADE;
ALTER TABLE password_reset_tokens ADD CONSTRAINT password_reset_tokens_token_key UNIQUE (token);
CREATE INDEX prt_kine_id_idx ON password_reset_tokens USING btree (kine_id);
CREATE INDEX prt_token_idx ON password_reset_tokens USING btree (token);

-- ── TABLE: patient_email_prefs ──────────────────────────────────────────
CREATE TABLE patient_email_prefs (
  id INTEGER NOT NULL DEFAULT nextval('patient_email_prefs_id_seq'::regclass),
  patient_id INTEGER NOT NULL,
  prefs_token VARCHAR(128) NOT NULL,
  rappels_actifs BOOLEAN DEFAULT true,
  delai_jours_patient INTEGER,
  mis_a_jour_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (id)
);
ALTER TABLE patient_email_prefs ADD CONSTRAINT patient_email_prefs_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE;
ALTER TABLE patient_email_prefs ADD CONSTRAINT patient_email_prefs_patient_id_key UNIQUE (patient_id);
ALTER TABLE patient_email_prefs ADD CONSTRAINT patient_email_prefs_prefs_token_key UNIQUE (prefs_token);
CREATE INDEX pep_patient_id_idx ON patient_email_prefs USING btree (patient_id);
CREATE INDEX pep_token_idx ON patient_email_prefs USING btree (prefs_token);

-- ── TABLE: patient_health_consents ──────────────────────────────────────────
CREATE TABLE patient_health_consents (
  id INTEGER NOT NULL DEFAULT nextval('patient_health_consents_id_seq'::regclass),
  patient_lien VARCHAR(64) NOT NULL,
  consented BOOLEAN NOT NULL DEFAULT false,
  consented_at TIMESTAMP,
  withdrawn_at TIMESTAMP,
  ip_hash VARCHAR(64),
  user_agent TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);
ALTER TABLE patient_health_consents ADD CONSTRAINT patient_health_consents_patient_lien_key UNIQUE (patient_lien);
CREATE INDEX idx_patient_health_consents_lien ON patient_health_consents USING btree (patient_lien);

-- ── TABLE: patient_notification_prefs ──────────────────────────────────────────
CREATE TABLE patient_notification_prefs (
  id INTEGER NOT NULL DEFAULT nextval('patient_notification_prefs_id_seq'::regclass),
  patient_id INTEGER NOT NULL,
  push_rappels_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
ALTER TABLE patient_notification_prefs ADD CONSTRAINT patient_notification_prefs_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE;
ALTER TABLE patient_notification_prefs ADD CONSTRAINT patient_notification_prefs_patient_id_key UNIQUE (patient_id);

-- ── TABLE: patient_push_subscriptions ──────────────────────────────────────────
CREATE TABLE patient_push_subscriptions (
  id INTEGER NOT NULL DEFAULT nextval('patient_push_subscriptions_id_seq'::regclass),
  patient_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
ALTER TABLE patient_push_subscriptions ADD CONSTRAINT patient_push_subscriptions_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE;
ALTER TABLE patient_push_subscriptions ADD CONSTRAINT patient_push_subscriptions_patient_id_endpoint_key UNIQUE (patient_id, endpoint);
CREATE INDEX patient_push_subs_patient_id_active_idx ON patient_push_subscriptions USING btree (patient_id, active);

-- ── TABLE: patients ──────────────────────────────────────────
CREATE TABLE patients (
  id INTEGER NOT NULL DEFAULT nextval('patients_id_seq'::regclass),
  kine_id INTEGER NOT NULL,
  nom VARCHAR(255) NOT NULL,
  prenom VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  telephone VARCHAR(50),
  pathologie TEXT,
  notes TEXT,
  lien_unique VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  pathologie_enc TEXT,
  notes_enc TEXT,
  PRIMARY KEY (id)
);
ALTER TABLE patients ADD CONSTRAINT patients_kine_id_fkey FOREIGN KEY (kine_id) REFERENCES kines(id) ON DELETE CASCADE;
CREATE INDEX patients_kine_id_idx ON patients USING btree (kine_id);
CREATE UNIQUE INDEX patients_lien_unique_idx ON patients USING btree (lien_unique);

-- ── TABLE: programme_exercices ──────────────────────────────────────────
CREATE TABLE programme_exercices (
  id INTEGER NOT NULL DEFAULT nextval('programme_exercices_id_seq'::regclass),
  programme_id INTEGER NOT NULL,
  exercice_id INTEGER NOT NULL,
  series INTEGER DEFAULT 3,
  repetitions VARCHAR(50) DEFAULT 10,
  duree_secondes INTEGER,
  instructions TEXT,
  ordre INTEGER DEFAULT 0,
  PRIMARY KEY (id)
);
ALTER TABLE programme_exercices ADD CONSTRAINT programme_exercices_exercice_id_fkey FOREIGN KEY (exercice_id) REFERENCES exercices(id) ON DELETE CASCADE;
ALTER TABLE programme_exercices ADD CONSTRAINT programme_exercices_programme_id_fkey FOREIGN KEY (programme_id) REFERENCES programmes(id) ON DELETE CASCADE;
CREATE INDEX pe_programme_id_idx ON programme_exercices USING btree (programme_id);

-- ── TABLE: programme_rappels ──────────────────────────────────────────
CREATE TABLE programme_rappels (
  id INTEGER NOT NULL DEFAULT nextval('programme_rappels_id_seq'::regclass),
  programme_id INTEGER NOT NULL,
  kine_id INTEGER NOT NULL,
  patient_id INTEGER NOT NULL,
  rappels_actifs BOOLEAN DEFAULT true,
  delai_jours INTEGER DEFAULT 1,
  email_assignation_envoye BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  push_rappel_heure VARCHAR(5),
  push_rappel_jours TEXT[],
  PRIMARY KEY (id)
);
ALTER TABLE programme_rappels ADD CONSTRAINT programme_rappels_kine_id_fkey FOREIGN KEY (kine_id) REFERENCES kines(id) ON DELETE CASCADE;
ALTER TABLE programme_rappels ADD CONSTRAINT programme_rappels_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE;
ALTER TABLE programme_rappels ADD CONSTRAINT programme_rappels_programme_id_fkey FOREIGN KEY (programme_id) REFERENCES programmes(id) ON DELETE CASCADE;
ALTER TABLE programme_rappels ADD CONSTRAINT programme_rappels_programme_id_key UNIQUE (programme_id);
CREATE INDEX pr_patient_id_idx ON programme_rappels USING btree (patient_id);
CREATE INDEX pr_programme_id_idx ON programme_rappels USING btree (programme_id);

-- ── TABLE: programmes ──────────────────────────────────────────
CREATE TABLE programmes (
  id INTEGER NOT NULL DEFAULT nextval('programmes_id_seq'::regclass),
  kine_id INTEGER NOT NULL,
  patient_id INTEGER NOT NULL,
  titre VARCHAR(255) NOT NULL,
  date_debut DATE,
  date_fin DATE,
  notes TEXT,
  actif BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  frequence_semaine INTEGER DEFAULT 3,
  duree_semaines INTEGER DEFAULT 4,
  PRIMARY KEY (id)
);
ALTER TABLE programmes ADD CONSTRAINT programmes_kine_id_fkey FOREIGN KEY (kine_id) REFERENCES kines(id) ON DELETE CASCADE;
ALTER TABLE programmes ADD CONSTRAINT programmes_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE;
CREATE INDEX programmes_kine_id_idx ON programmes USING btree (kine_id);
CREATE INDEX programmes_patient_id_idx ON programmes USING btree (patient_id);

-- ── TABLE: protocols ──────────────────────────────────────────
CREATE TABLE protocols (
  id INTEGER NOT NULL DEFAULT nextval('protocols_id_seq'::regclass),
  nom VARCHAR(300) NOT NULL,
  zone VARCHAR(100) NOT NULL,
  pathologie VARCHAR(300) NOT NULL,
  description TEXT NOT NULL,
  duree_semaines INTEGER NOT NULL,
  duree_label VARCHAR(100),
  difficulte VARCHAR(50) NOT NULL DEFAULT 'Modéré'::character varying,
  frequence_semaine INTEGER,
  phases JSONB NOT NULL DEFAULT '[]'::jsonb,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  precautions TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE INDEX protocols_difficulte_idx ON protocols USING btree (difficulte);
CREATE INDEX protocols_zone_idx ON protocols USING btree (zone);

-- ── TABLE: publications ──────────────────────────────────────────
CREATE TABLE publications (
  id INTEGER NOT NULL DEFAULT nextval('publications_id_seq'::regclass),
  titre VARCHAR(500) NOT NULL,
  resume TEXT NOT NULL,
  thematique VARCHAR(100) NOT NULL,
  lien_original VARCHAR(1000),
  date_publication TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE INDEX publications_date_idx ON publications USING btree (date_publication DESC);
CREATE INDEX publications_thematique_idx ON publications USING btree (thematique);

-- ── TABLE: push_subscriptions ──────────────────────────────────────────
CREATE TABLE push_subscriptions (
  id INTEGER NOT NULL DEFAULT nextval('push_subscriptions_id_seq'::regclass),
  kine_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_kine_id_fkey FOREIGN KEY (kine_id) REFERENCES kines(id) ON DELETE CASCADE;
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_kine_id_endpoint_key UNIQUE (kine_id, endpoint);
CREATE INDEX push_subscriptions_kine_id_active_idx ON push_subscriptions USING btree (kine_id, active);

-- ── TABLE: rappel_logs ──────────────────────────────────────────
CREATE TABLE rappel_logs (
  id BIGINT NOT NULL DEFAULT nextval('rappel_logs_id_seq'::regclass),
  patient_id INTEGER NOT NULL,
  programme_id INTEGER NOT NULL,
  type_rappel VARCHAR(50) NOT NULL,
  envoye_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (id)
);
ALTER TABLE rappel_logs ADD CONSTRAINT rappel_logs_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE;
ALTER TABLE rappel_logs ADD CONSTRAINT rappel_logs_programme_id_fkey FOREIGN KEY (programme_id) REFERENCES programmes(id) ON DELETE CASCADE;
CREATE INDEX rl_envoye_at_idx ON rappel_logs USING btree (envoye_at);
CREATE INDEX rl_patient_programme_idx ON rappel_logs USING btree (patient_id, programme_id, type_rappel);

-- ── TABLE: seance_exercices ──────────────────────────────────────────
CREATE TABLE seance_exercices (
  id INTEGER NOT NULL DEFAULT nextval('seance_exercices_id_seq'::regclass),
  seance_id INTEGER NOT NULL,
  exercice_id INTEGER NOT NULL,
  complete BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (id)
);
ALTER TABLE seance_exercices ADD CONSTRAINT seance_exercices_exercice_id_fkey FOREIGN KEY (exercice_id) REFERENCES exercices(id) ON DELETE CASCADE;
ALTER TABLE seance_exercices ADD CONSTRAINT seance_exercices_seance_id_fkey FOREIGN KEY (seance_id) REFERENCES seances(id) ON DELETE CASCADE;
CREATE INDEX se_seance_id_idx ON seance_exercices USING btree (seance_id);

-- ── TABLE: seances ──────────────────────────────────────────
CREATE TABLE seances (
  id INTEGER NOT NULL DEFAULT nextval('seances_id_seq'::regclass),
  programme_id INTEGER NOT NULL,
  patient_id INTEGER NOT NULL,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  completee BOOLEAN DEFAULT false,
  douleur_score INTEGER,
  notes_patient TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  difficulte VARCHAR(20),
  douleur_score_enc TEXT,
  notes_patient_enc TEXT,
  difficulte_enc TEXT,
  PRIMARY KEY (id)
);
ALTER TABLE seances ADD CONSTRAINT seances_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE;
ALTER TABLE seances ADD CONSTRAINT seances_programme_id_fkey FOREIGN KEY (programme_id) REFERENCES programmes(id) ON DELETE CASCADE;
CREATE INDEX seances_patient_id_idx ON seances USING btree (patient_id);
CREATE INDEX seances_programme_id_idx ON seances USING btree (programme_id);

-- ── TABLE: session ──────────────────────────────────────────
CREATE TABLE session (
  sid VARCHAR NOT NULL,
  sess JSON NOT NULL,
  expire TIMESTAMP NOT NULL,
  PRIMARY KEY (sid)
);
CREATE INDEX "IDX_session_expire" ON session USING btree (expire);

-- ── TABLE: users ──────────────────────────────────────────
CREATE TABLE users (
  id INTEGER NOT NULL DEFAULT nextval('users_id_seq'::regclass),
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  password_hash VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  stripe_subscription_id VARCHAR(255),
  subscription_status VARCHAR(50),
  subscription_plan VARCHAR(255),
  subscription_expires_at TIMESTAMPTZ,
  subscription_updated_at TIMESTAMPTZ,
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX users_email_unique_idx ON users USING btree (lower((email)::text));
CREATE INDEX users_stripe_subscription_id_idx ON users USING btree (stripe_subscription_id);

-- ── TABLE: video_feedback ──────────────────────────────────────────
CREATE TABLE video_feedback (
  id INTEGER NOT NULL DEFAULT nextval('video_feedback_id_seq'::regclass),
  patient_id INTEGER NOT NULL,
  exercise_id INTEGER NOT NULL,
  programme_id INTEGER,
  helpful BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
ALTER TABLE video_feedback ADD CONSTRAINT video_feedback_exercise_id_fkey FOREIGN KEY (exercise_id) REFERENCES exercices(id) ON DELETE CASCADE;
ALTER TABLE video_feedback ADD CONSTRAINT video_feedback_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE;
ALTER TABLE video_feedback ADD CONSTRAINT video_feedback_programme_id_fkey FOREIGN KEY (programme_id) REFERENCES programmes(id) ON DELETE SET NULL;
ALTER TABLE video_feedback ADD CONSTRAINT video_feedback_patient_id_exercise_id_key UNIQUE (patient_id, exercise_id);
CREATE INDEX idx_video_feedback_exercise ON video_feedback USING btree (exercise_id);
CREATE INDEX idx_video_feedback_patient ON video_feedback USING btree (patient_id);

-- ── TABLE: zones_corporelles ──────────────────────────────────────────
CREATE TABLE zones_corporelles (
  id INTEGER NOT NULL DEFAULT nextval('zones_corporelles_id_seq'::regclass),
  nom VARCHAR(50) NOT NULL,
  label_fr VARCHAR(100) NOT NULL,
  PRIMARY KEY (id)
);
ALTER TABLE zones_corporelles ADD CONSTRAINT zones_corporelles_nom_key UNIQUE (nom);

-- ============================================================
-- END OF SCHEMA
-- ============================================================
