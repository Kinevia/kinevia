// Serves /.well-known/ endpoints required for platform integrations.
// Owns: Digital Asset Links (TWA/Android), future ACME challenge responses.
// Does NOT own: any auth, session, or business logic.

const express = require('express');
const path = require('path');
const router = express.Router();

// Digital Asset Links — required for TWA domain ownership verification.
// Google Play Store checks this URL to confirm kinevia.pro owns the Android app.
// SHA-256 fingerprint must match the release keystore used to sign the AAB.
router.get('/assetlinks.json', (req, res) => {
  res.set('Content-Type', 'application/json');
  // No caching — Google re-fetches on every TWA launch to verify ownership.
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'public', '.well-known', 'assetlinks.json'));
});

module.exports = router;
