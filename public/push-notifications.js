/**
 * Kinévia — Push Notifications Manager
 *
 * Usage:
 *   <script src="/push-notifications.js"></script>
 *
 * This script:
 *   1. Checks if push is supported + service worker is registered
 *   2. Does NOT auto-prompt — exposes window.__pushNotifications for explicit UI
 *   3. Provides subscribe(), unsubscribe(), getStatus() methods
 *
 * Push permission is ONLY requested after an explicit user action (button click).
 */

(function () {
  'use strict';

  // -------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  async function getServiceWorkerRegistration() {
    if (!('serviceWorker' in navigator)) return null;
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      return regs[0] || null;
    } catch (e) {
      return null;
    }
  }

  async function fetchVapidKey() {
    const resp = await fetch('/api/push/vapid-public-key');
    if (!resp.ok) throw new Error('VAPID key unavailable');
    const { publicKey } = await resp.json();
    return publicKey;
  }

  async function saveSubscription(subscription) {
    const sub = subscription.toJSON();
    const resp = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: sub.endpoint,
        keys: sub.keys
      })
    });
    if (!resp.ok) throw new Error('Échec de l\'enregistrement côté serveur');
    return resp.json();
  }

  async function removeSubscription(endpoint) {
    await fetch('/api/push/unsubscribe', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint })
    });
  }

  // -------------------------------------------------------
  // Public API exposed on window.__pushNotifications
  // -------------------------------------------------------

  const pushManager = {

    /**
     * Returns whether push is supported and VAPID is configured.
     */
    isSupported() {
      return (
        'PushManager' in window &&
        'serviceWorker' in navigator &&
        'Notification' in window
      );
    },

    /**
     * Returns current permission state: 'default' | 'granted' | 'denied'
     */
    permissionState() {
      if (!('Notification' in window)) return 'denied';
      return Notification.permission;
    },

    /**
     * Check if this browser has an active push subscription saved in DB.
     * Returns { subscribed: boolean, permission: string }
     */
    async getStatus() {
      if (!this.isSupported()) {
        return { subscribed: false, permission: 'unsupported' };
      }
      const permission = this.permissionState();
      if (permission !== 'granted') {
        return { subscribed: false, permission };
      }
      try {
        const reg = await getServiceWorkerRegistration();
        if (!reg || !reg.pushManager) return { subscribed: false, permission };
        const existing = await reg.pushManager.getSubscription();
        return { subscribed: !!existing, permission };
      } catch (e) {
        return { subscribed: false, permission };
      }
    },

    /**
     * Request push permission and subscribe.
     * Must be called from a user gesture (button click etc.).
     * Returns { success: boolean, error?: string, alreadyGranted?: boolean }
     */
    async subscribe() {
      if (!this.isSupported()) {
        return { success: false, error: 'Notifications non supportées sur ce navigateur' };
      }

      // Request permission (must be from user gesture)
      let permission = Notification.permission;
      if (permission === 'default') {
        permission = await Notification.requestPermission();
      }
      if (permission !== 'granted') {
        return {
          success: false,
          error: permission === 'denied'
            ? 'Permission refusée. Activez les notifications dans les paramètres de votre navigateur.'
            : 'Permission non accordée'
        };
      }

      try {
        const reg = await getServiceWorkerRegistration();
        if (!reg || !reg.pushManager) {
          return { success: false, error: 'Service worker non disponible' };
        }

        const vapidKey = await fetchVapidKey();
        const applicationServerKey = urlBase64ToUint8Array(vapidKey);

        // Check if already subscribed
        let subscription = await reg.pushManager.getSubscription();
        if (!subscription) {
          subscription = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey
          });
        }

        await saveSubscription(subscription);
        return { success: true };
      } catch (err) {
        console.error('[push] subscribe error:', err);
        return { success: false, error: err.message || 'Erreur lors de l\'abonnement' };
      }
    },

    /**
     * Unsubscribe from push notifications.
     */
    async unsubscribe() {
      try {
        const reg = await getServiceWorkerRegistration();
        if (!reg || !reg.pushManager) return { success: true };

        const subscription = await reg.pushManager.getSubscription();
        if (subscription) {
          await removeSubscription(subscription.endpoint);
          await subscription.unsubscribe();
        }
        return { success: true };
      } catch (err) {
        console.error('[push] unsubscribe error:', err);
        return { success: false, error: err.message };
      }
    },

    /**
     * Render a push notification toggle UI into a container element.
     * container: DOM element
     */
    async renderToggle(container) {
      if (!container) return;

      if (!this.isSupported()) {
        container.innerHTML = `
          <p class="text-xs text-slate-400 mt-1">
            Notifications push non supportées sur ce navigateur.
          </p>`;
        return;
      }

      const { subscribed, permission } = await this.getStatus();

      const renderUI = (isSubscribed, perm) => {
        let statusText, buttonLabel, buttonClass, buttonDisabled = false;

        if (perm === 'denied') {
          statusText = '<span class="text-red-500">Bloquées dans le navigateur</span>';
          buttonLabel = 'Débloquer dans les paramètres';
          buttonClass = 'text-slate-500 cursor-not-allowed';
          buttonDisabled = true;
        } else if (isSubscribed) {
          statusText = '<span class="text-emerald-600">✓ Activées</span>';
          buttonLabel = 'Désactiver';
          buttonClass = 'text-red-500 hover:text-red-700';
        } else {
          statusText = '<span class="text-slate-400">Désactivées</span>';
          buttonLabel = 'Activer les notifications';
          buttonClass = 'text-sky-600 hover:text-sky-700 font-medium';
        }

        container.innerHTML = `
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm font-medium text-slate-700">Notifications push</p>
              <p class="text-xs text-slate-400 mt-0.5">${statusText}</p>
            </div>
            <button
              id="push-toggle-btn"
              class="text-sm underline transition-colors ${buttonClass}"
              ${buttonDisabled ? 'disabled' : ''}
            >${buttonLabel}</button>
          </div>
          ${perm === 'denied' ? `<p class="text-xs text-slate-400 mt-1">Allez dans les paramètres de votre navigateur → Notifications → Autoriser pour kinevia.pro</p>` : ''}
        `;

        const btn = container.querySelector('#push-toggle-btn');
        if (btn && !buttonDisabled) {
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = isSubscribed ? 'Désactivation...' : 'Activation...';

            let result;
            if (isSubscribed) {
              result = await window.__pushNotifications.unsubscribe();
            } else {
              result = await window.__pushNotifications.subscribe();
            }

            if (result.success) {
              const newStatus = await window.__pushNotifications.getStatus();
              renderUI(newStatus.subscribed, newStatus.permission);
            } else {
              btn.disabled = false;
              btn.textContent = buttonLabel;
              // Show error briefly
              const errEl = document.createElement('p');
              errEl.className = 'text-xs text-red-500 mt-1';
              errEl.textContent = result.error || 'Une erreur est survenue';
              container.appendChild(errEl);
              setTimeout(() => errEl.remove(), 5000);
            }
          });
        }
      };

      renderUI(subscribed, permission);
    }
  };

  window.__pushNotifications = pushManager;

  // Auto-initialize status on load (no UI, no permission request)
  pushManager.getStatus().then(({ subscribed, permission }) => {
    if (window.__pushDebug) {
      console.log('[push] status on load:', { subscribed, permission });
    }
  }).catch(() => {});

})();
