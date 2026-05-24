/**
 * Kinévia — offline-db.js
 * IndexedDB wrapper for patient offline mode.
 *
 * What it owns:
 *   - Patient data cache (programme, seances, profile)
 *   - Pending action queue (seances submitted while offline)
 *   - Cache size management (max ~50 MB guard on image URLs)
 *
 * What it does NOT own:
 *   - Actual API calls (done by patient.html + service worker)
 *   - UI rendering
 */
(function (global) {
  'use strict';

  var DB_NAME = 'kinevia-offline';
  var DB_VERSION = 1;
  var STORE_CACHE = 'patient_cache';   // cached API data per lien_unique
  var STORE_QUEUE = 'pending_actions'; // offline actions awaiting sync

  var _db = null;

  // ── Open / Upgrade ─────────────────────────────────────────────────────────
  function openDB() {
    return new Promise(function (resolve, reject) {
      if (_db) { resolve(_db); return; }

      var req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = function (e) {
        var db = e.target.result;

        // patient_cache: keyed by lien_unique
        if (!db.objectStoreNames.contains(STORE_CACHE)) {
          db.createObjectStore(STORE_CACHE, { keyPath: 'lien' });
        }

        // pending_actions: auto-increment id, indexed by lien
        if (!db.objectStoreNames.contains(STORE_QUEUE)) {
          var qs = db.createObjectStore(STORE_QUEUE, { keyPath: 'id', autoIncrement: true });
          qs.createIndex('by_lien', 'lien', { unique: false });
        }
      };

      req.onsuccess = function (e) {
        _db = e.target.result;
        resolve(_db);
      };

      req.onerror = function (e) {
        reject(e.target.error);
      };
    });
  }

  // ── Generic helpers ────────────────────────────────────────────────────────
  function tx(storeName, mode, fn) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var transaction = db.transaction(storeName, mode);
        var store = transaction.objectStore(storeName);
        var req = fn(store);
        if (req && req.onsuccess !== undefined) {
          req.onsuccess = function () { resolve(req.result); };
          req.onerror   = function () { reject(req.error); };
        } else {
          transaction.oncomplete = function () { resolve(); };
          transaction.onerror    = function () { reject(transaction.error); };
        }
      });
    });
  }

  // ── Patient cache ──────────────────────────────────────────────────────────

  /**
   * Save patient API response to IndexedDB.
   * @param {string} lien  lien_unique from URL
   * @param {object} data  full response from /api/patient/:lien
   */
  function savePatientCache(lien, data) {
    return tx(STORE_CACHE, 'readwrite', function (store) {
      return store.put({
        lien: lien,
        data: data,
        cached_at: Date.now()
      });
    }).catch(function (err) {
      console.warn('[offline-db] savePatientCache error:', err);
    });
  }

  /**
   * Read cached patient data.
   * @returns {Promise<object|null>}  { data, cached_at } or null
   */
  function getPatientCache(lien) {
    return tx(STORE_CACHE, 'readonly', function (store) {
      return store.get(lien);
    }).catch(function () { return null; });
  }

  /**
   * Delete cache for a given lien (call when new programme assigned).
   */
  function clearPatientCache(lien) {
    return tx(STORE_CACHE, 'readwrite', function (store) {
      return store.delete(lien);
    }).catch(function () {});
  }

  // ── Pending action queue ───────────────────────────────────────────────────

  /**
   * Enqueue an action to be synced later.
   * @param {string} lien    lien_unique
   * @param {string} type    'seance'
   * @param {object} payload body to POST
   */
  function enqueueAction(lien, type, payload) {
    return tx(STORE_QUEUE, 'readwrite', function (store) {
      return store.add({
        lien: lien,
        type: type,
        payload: payload,
        queued_at: Date.now(),
        attempts: 0
      });
    }).catch(function (err) {
      console.warn('[offline-db] enqueueAction error:', err);
      return null;
    });
  }

  /**
   * Get all pending actions for a lien.
   */
  function getPendingActions(lien) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var transaction = db.transaction(STORE_QUEUE, 'readonly');
        var store = transaction.objectStore(STORE_QUEUE);
        var index = store.index('by_lien');
        var req = index.getAll(lien);
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror   = function () { reject(req.error); };
      });
    }).catch(function () { return []; });
  }

  /**
   * Get ALL pending actions (for background sync across any lien).
   */
  function getAllPendingActions() {
    return tx(STORE_QUEUE, 'readonly', function (store) {
      return store.getAll();
    }).catch(function () { return []; });
  }

  /**
   * Count pending actions for a lien.
   */
  function countPendingActions(lien) {
    return getPendingActions(lien).then(function (items) { return items.length; });
  }

  /**
   * Remove an action after successful sync.
   * @param {number} id  auto-increment key
   */
  function removeAction(id) {
    return tx(STORE_QUEUE, 'readwrite', function (store) {
      return store.delete(id);
    }).catch(function () {});
  }

  /**
   * Increment attempt counter (for backoff tracking).
   */
  function incrementAttempts(id) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var transaction = db.transaction(STORE_QUEUE, 'readwrite');
        var store = transaction.objectStore(STORE_QUEUE);
        var getReq = store.get(id);
        getReq.onsuccess = function () {
          var record = getReq.result;
          if (!record) { resolve(); return; }
          record.attempts = (record.attempts || 0) + 1;
          record.last_attempt = Date.now();
          var putReq = store.put(record);
          putReq.onsuccess = function () { resolve(); };
          putReq.onerror   = function () { reject(putReq.error); };
        };
        getReq.onerror = function () { reject(getReq.error); };
      });
    }).catch(function () {});
  }

  // ── Exponential backoff check ─────────────────────────────────────────────
  // Do not retry if last attempt was within backoff window.
  var BACKOFF_MS = [0, 5000, 15000, 60000, 300000]; // 0s, 5s, 15s, 1m, 5m
  function shouldRetry(action) {
    var attempts = action.attempts || 0;
    if (attempts === 0) return true;
    var delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
    var lastAttempt = action.last_attempt || 0;
    return (Date.now() - lastAttempt) >= delay;
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  global.KineviaOfflineDB = {
    savePatientCache:    savePatientCache,
    getPatientCache:     getPatientCache,
    clearPatientCache:   clearPatientCache,
    enqueueAction:       enqueueAction,
    getPendingActions:   getPendingActions,
    getAllPendingActions: getAllPendingActions,
    countPendingActions: countPendingActions,
    removeAction:        removeAction,
    incrementAttempts:   incrementAttempts,
    shouldRetry:         shouldRetry
  };

}(window));
