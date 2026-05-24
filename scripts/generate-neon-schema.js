/**
 * Generate schema.sql from Neon DB using polsia_infra MCP.
 * This script queries the schema via MCP (bypassing network restrictions).
 * Usage: node scripts/generate-neon-schema.js
 *
 * The MCP query_db tool connects to Neon directly without DNS issues.
 */

const fs = require('fs');
const path = require('path');

// Tables to process (all 35)
const TABLES = [
  '_migrations', 'beta_signups', 'bilans', 'clinical_test_items', 'clinical_tests',
  'conversations', 'cookie_consents', 'email_verification_tokens', 'exercise_videos',
  'exercices', 'health_access_logs', 'kine_notification_prefs', 'kine_subscription_events',
  'kines', 'magic_link_tokens', 'messages', 'password_reset_tokens', 'patient_email_prefs',
  'patient_health_consents', 'patient_notification_prefs', 'patient_push_subscriptions',
  'patients', 'programme_exercices', 'programme_rappels', 'programmes', 'protocols',
  'publications', 'push_subscriptions', 'rappel_logs', 'seance_exercices', 'seances',
  'session', 'users', 'video_feedback', 'zones_corporelles'
];

// We'll accumulate all queries and then run them via MCP
// For now, let this script just define the format function
// Actual execution will be done by calling the MCP tools directly

function formatType(dataType, charMaxLen, numPrec, numScale) {
  const dt = dataType.toUpperCase();
  switch (dt) {
    case 'CHARACTER VARYING':
      return charMaxLen ? `VARCHAR(${charMaxLen})` : 'VARCHAR';
    case 'CHARACTER':
      return charMaxLen ? `CHAR(${charMaxLen})` : 'CHAR';
    case 'NUMERIC':
      return numPrec ? `NUMERIC(${numPrec},${numScale || 0})` : 'NUMERIC';
    case 'USER-DEFINED':
      return dt; // enums will be created separately
    default:
      return dt;
  }
}

module.exports = { TABLES, formatType };