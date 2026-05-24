/**
 * Kinévia — PWA Install Prompt
 * Gère l'invite d'installation pour Android/Chrome (beforeinstallprompt)
 * et iOS/Safari (message explicatif).
 *
 * Ne s'affiche pas si :
 *  - Déjà en mode standalone (app déjà installée)
 *  - L'utilisateur a déjà fermé le bandeau (localStorage)
 *  - Moins de 2 visites (pour ne pas être intrusif)
 *
 * Expose une API globale pour la page Paramètres :
 *  - window.__pwaIsStandalone  : true si l'app tourne déjà en standalone
 *  - window.__pwaIsIOS         : true sur iPhone/iPad/iPod
 *  - window.__pwaIsSafari      : true sur Safari iOS
 *  - window.__pwaInstallPrompt : l'événement beforeinstallprompt (Android/Chrome)
 *  - window.__pwaUpdateSettingsButton : callback déclenché après appinstalled
 *
 * SW update notification :
 *  - Écoute SW_UPDATED postMessage → affiche un toast discret de rechargement
 */
(function () {
  'use strict';

  var DISMISSED_KEY = 'kinevia_pwa_dismissed';
  var INSTALLED_KEY = 'kinevia_pwa_installed';
  var VISIT_COUNT_KEY = 'kinevia_visit_count';
  var MIN_VISITS_BEFORE_PROMPT = 2; // afficher après la 2e visite

  // ── Compteur de visites ──────────────────────────────────────
  var visitCount = parseInt(localStorage.getItem(VISIT_COUNT_KEY) || '0', 10);
  visitCount += 1;
  localStorage.setItem(VISIT_COUNT_KEY, String(visitCount));
  var hasEnoughVisits = visitCount >= MIN_VISITS_BEFORE_PROMPT;

  // ── Détection (toujours calculée, même si le bandeau ne s'affiche pas) ─
  var isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  var isSafari =
    /safari/i.test(navigator.userAgent) && !/chrome|crios|fxios/i.test(navigator.userAgent);

  // ── API globale (utilisée par la page Paramètres) ──────────
  window.__pwaIsStandalone = isStandalone;
  window.__pwaIsIOS = isIOS;
  window.__pwaIsSafari = isSafari;
  window.__pwaInstallPrompt = null;
  window.__pwaUpdateSettingsButton = null; // la page Paramètres peut l'assigner

  // Déjà en standalone → pas de bandeau (mais l'API est quand même exposée)
  if (isStandalone) return;

  // Déjà ignoré ou installé → pas de bandeau
  var bannerSuppressed =
    !!(localStorage.getItem(DISMISSED_KEY) || localStorage.getItem(INSTALLED_KEY));

  var deferredPrompt = null;

  // ── Créer le bandeau ───────────────────────────────────────
  function createBanner(mode) {
    var banner = document.createElement('div');
    banner.id = 'kinevia-pwa-banner';

    var baseStyle = [
      'position:fixed',
      'bottom:0',
      'left:0',
      'right:0',
      'z-index:9999',
      'display:flex',
      'align-items:center',
      'gap:12px',
      'padding:14px 16px',
      'background:#0f172a',
      'color:#f1f5f9',
      'font-family:system-ui,-apple-system,sans-serif',
      'font-size:14px',
      'box-shadow:0 -2px 12px rgba(0,0,0,0.25)',
      'transition:transform .35s cubic-bezier(.4,0,.2,1)',
      'transform:translateY(100%)',
    ].join(';');

    banner.setAttribute('style', baseStyle);
    banner.setAttribute('role', 'banner');
    banner.setAttribute('aria-label', "Invite d'installation Kinévia");

    // Icône
    var icon = document.createElement('img');
    icon.src = '/icons/icon-192.png';
    icon.alt = 'Kinévia';
    icon.style.cssText = 'width:40px;height:40px;border-radius:10px;flex-shrink:0';
    banner.appendChild(icon);

    // Texte
    var textDiv = document.createElement('div');
    textDiv.style.cssText = 'flex:1;min-width:0';

    var title = document.createElement('div');
    title.style.cssText = 'font-weight:600;line-height:1.3;color:#f8fafc';

    var desc = document.createElement('div');
    desc.style.cssText = 'margin-top:2px;font-size:12px;color:#94a3b8;line-height:1.4';

    if (mode === 'ios') {
      title.textContent = 'Installer Kinévia';
      desc.innerHTML =
        "Appuyez sur <span style=\"display:inline-block;padding:1px 5px;border-radius:4px;background:#1e293b;font-size:11px\">⬆ Partager</span> puis <strong>« Ajouter à l'écran d'accueil »</strong>";
    } else {
      title.textContent = 'Installer Kinévia';
      desc.textContent = "Accès rapide depuis votre écran d'accueil, même hors-ligne.";
    }

    textDiv.appendChild(title);
    textDiv.appendChild(desc);
    banner.appendChild(textDiv);

    // Boutons
    var btnGroup = document.createElement('div');
    btnGroup.style.cssText = 'display:flex;gap:8px;flex-shrink:0';

    if (mode === 'android') {
      var installBtn = document.createElement('button');
      installBtn.textContent = 'Installer';
      installBtn.style.cssText = [
        'padding:7px 14px',
        'border-radius:8px',
        'border:none',
        'background:#0ea5e9',
        'color:#fff',
        'font-size:13px',
        'font-weight:600',
        'cursor:pointer',
        'white-space:nowrap',
      ].join(';');
      installBtn.addEventListener('click', function () {
        if (deferredPrompt) {
          deferredPrompt.prompt();
          deferredPrompt.userChoice.then(function (result) {
            if (result.outcome === 'accepted') {
              localStorage.setItem(INSTALLED_KEY, '1');
            } else {
              localStorage.setItem(DISMISSED_KEY, '1');
            }
            hideBanner(banner);
          });
        }
      });
      btnGroup.appendChild(installBtn);
    }

    var closeBtn = document.createElement('button');
    closeBtn.setAttribute('aria-label', 'Fermer');
    closeBtn.innerHTML = '&times;';
    closeBtn.style.cssText = [
      'padding:6px 10px',
      'border-radius:8px',
      'border:1px solid #334155',
      'background:transparent',
      'color:#94a3b8',
      'font-size:18px',
      'line-height:1',
      'cursor:pointer',
    ].join(';');
    closeBtn.addEventListener('click', function () {
      localStorage.setItem(DISMISSED_KEY, '1');
      hideBanner(banner);
    });
    btnGroup.appendChild(closeBtn);

    banner.appendChild(btnGroup);
    return banner;
  }

  function showBanner(banner) {
    document.body.appendChild(banner);
    // Forcer le reflow pour que la transition joue
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        banner.style.transform = 'translateY(0)';
      });
    });
  }

  function hideBanner(banner) {
    banner.style.transform = 'translateY(100%)';
    setTimeout(function () {
      if (banner.parentNode) banner.parentNode.removeChild(banner);
    }, 350);
  }

  // ── Android / Chrome : beforeinstallprompt ─────────────────
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    window.__pwaInstallPrompt = e; // partagé avec les pages Paramètres

    if (!bannerSuppressed && hasEnoughVisits) {
      var banner = createBanner('android');
      // Attendre un peu avant d'afficher (laisser la page charger)
      setTimeout(function () {
        showBanner(banner);
      }, 3000);
    }
  });

  // ── iOS / Safari ───────────────────────────────────────────
  if (isIOS && isSafari && !bannerSuppressed && hasEnoughVisits) {
    window.addEventListener('load', function () {
      setTimeout(function () {
        var banner = createBanner('ios');
        showBanner(banner);
      }, 4000);
    });
  }

  // ── appinstalled : noter l'installation ───────────────────
  window.addEventListener('appinstalled', function () {
    localStorage.setItem(INSTALLED_KEY, '1');
    localStorage.removeItem(DISMISSED_KEY);
    window.__pwaIsStandalone = true;
    var b = document.getElementById('kinevia-pwa-banner');
    if (b) hideBanner(b);
    // Rafraîchir le bouton dans Paramètres s'il est visible
    if (typeof window.__pwaUpdateSettingsButton === 'function') {
      window.__pwaUpdateSettingsButton();
    }
  });

  // ── SW update toast : nouvelle version disponible ─────────
  // Le SW v8 envoie SW_UPDATED lors de son activation
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (event) {
      if (!event.data || event.data.type !== 'SW_UPDATED') return;
      showUpdateToast();
    });
  }

  function showUpdateToast() {
    // Éviter les doublons
    if (document.getElementById('kinevia-update-toast')) return;

    var toast = document.createElement('div');
    toast.id = 'kinevia-update-toast';
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'polite');
    toast.style.cssText = [
      'position:fixed',
      'top:16px',
      'left:50%',
      'transform:translateX(-50%) translateY(-80px)',
      'z-index:10000',
      'display:flex',
      'align-items:center',
      'gap:10px',
      'padding:10px 16px',
      'background:#0f172a',
      'color:#f1f5f9',
      'font-family:system-ui,-apple-system,sans-serif',
      'font-size:13px',
      'border-radius:12px',
      'box-shadow:0 4px 20px rgba(0,0,0,0.35)',
      'transition:transform .4s cubic-bezier(.4,0,.2,1)',
      'white-space:nowrap',
    ].join(';');

    var msg = document.createElement('span');
    msg.textContent = '✨ Nouvelle version disponible';
    toast.appendChild(msg);

    var reloadBtn = document.createElement('button');
    reloadBtn.textContent = 'Actualiser';
    reloadBtn.style.cssText = [
      'padding:4px 10px',
      'border-radius:6px',
      'border:none',
      'background:#0ea5e9',
      'color:#fff',
      'font-size:12px',
      'font-weight:600',
      'cursor:pointer',
    ].join(';');
    reloadBtn.addEventListener('click', function () {
      window.location.reload();
    });
    toast.appendChild(reloadBtn);

    var dismissBtn = document.createElement('button');
    dismissBtn.setAttribute('aria-label', 'Ignorer');
    dismissBtn.innerHTML = '&times;';
    dismissBtn.style.cssText = [
      'padding:4px 8px',
      'border-radius:6px',
      'border:none',
      'background:transparent',
      'color:#94a3b8',
      'font-size:16px',
      'cursor:pointer',
    ].join(';');
    dismissBtn.addEventListener('click', function () {
      hideToast(toast);
    });
    toast.appendChild(dismissBtn);

    document.body.appendChild(toast);

    // Slide in
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        toast.style.transform = 'translateX(-50%) translateY(0)';
      });
    });

    // Auto-dismiss après 10s
    setTimeout(function () {
      hideToast(toast);
    }, 10000);
  }

  function hideToast(toast) {
    toast.style.transform = 'translateX(-50%) translateY(-80px)';
    setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 400);
  }
})();
