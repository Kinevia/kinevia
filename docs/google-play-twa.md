# Kinévia — Publication Google Play Store via TWA

## Ce qui est déjà fait (côté serveur)

- ✅ `manifest.json` mis à jour : `start_url`, `scope`, `id`, `theme_color`, `screenshots`, `shortcuts`
- ✅ `/.well-known/assetlinks.json` servi à `https://kinevia.pro/.well-known/assetlinks.json`
- ✅ Route Express dédiée avec headers `no-cache` corrects
- ✅ Icônes 512×512 et maskable déjà présentes (`/icons/icon-512.png`, `/icons/icon-512-maskable.png`)

## Ce qui reste à faire (manuel — 3 étapes)

### Étape 1 — Générer le package AAB avec PWABuilder

1. Aller sur **https://www.pwabuilder.com**
2. Entrer l'URL : `https://kinevia.pro`
3. Cliquer sur **Package for stores** → **Android**
4. Paramètres à utiliser :
   - **Package ID** : `pro.kinevia.app`
   - **App name** : `Kinévia`
   - **Version code** : `1`
   - **Version name** : `1.0.0`
   - **Signing** : choisir **"Generate a new keystore"** (garder le fichier `.keystore` en lieu sûr !)
5. Télécharger le ZIP contenant :
   - `app-release.aab` (le bundle à uploader)
   - `signing.keystore` + `signing-key-info.txt` → **NE PAS PERDRE**
   - `assetlinks.json` (avec la vraie empreinte SHA-256)

### Étape 2 — Mettre à jour l'assetlinks.json avec la vraie empreinte

Après la génération PWABuilder, ouvrir `signing-key-info.txt`.
Copier la valeur `SHA-256 Certificate Fingerprint` (format : `AA:BB:CC:...`).

Éditer le fichier `public/.well-known/assetlinks.json` :
```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "pro.kinevia.app",
      "sha256_cert_fingerprints": [
        "COLLER_ICI_LA_VALEUR_SHA256_SANS_ESPACES"
      ]
    }
  }
]
```

Supprimer les `:` de séparation — la valeur doit être : `AABBCC...` (64 caractères hex, sans séparateurs).

**Puis redéployer** pour que la nouvelle valeur soit live sur `https://kinevia.pro/.well-known/assetlinks.json`.

Vérifier : `curl https://kinevia.pro/.well-known/assetlinks.json` doit retourner le JSON avec la bonne empreinte.

### Étape 3 — Uploader sur Google Play Console

1. Aller sur **https://play.google.com/console**
2. Créer une nouvelle application :
   - Nom : `Kinévia`
   - Langue par défaut : `Français (France)`
   - Application ou jeu : `Application`
   - Gratuit ou payant : `Gratuit`
3. **Fiche Play Store** → remplir :
   - **Description courte** (80 chars max) :
     ```
     Logiciel pour kiné — patients, programmes et ressources cliniques.
     ```
   - **Description longue** :
     ```
     Kinévia simplifie la rééducation pour les kinésithérapeutes.

     • Gérez vos patients et leurs dossiers en un clic
     • Créez des programmes d'exercices personnalisés avec vidéos
     • Accédez à 74 fiches pathologiques EBP (ortho, rachis, neuro, sport…)
     • Suivez les bilans, séances et alertes de suivi
     • Assistant IA clinique intégré
     • Interface optimisée mobile, fonctionne hors connexion

     Essai gratuit 14 jours — sans carte bancaire.
     Abonnement 19,99€/mois.
     ```
   - **Catégorie** : `Médecine`
   - **Site web** : `https://kinevia.pro`
   - **Email support** : `contact@kinevia.pro`
4. **Ressources graphiques** à fournir :
   - **Icône** (512×512 PNG) : utiliser `/public/icons/icon-512.png` du repo
   - **Bannière de fonctionnalité** (1024×500 PNG) : créer depuis l'OG image `/public/og-image.png` (redimensionner + ajouter le tagline)
   - **Captures d'écran téléphone** (min. 2, 16:9 ou 9:16) : faire des screenshots de l'app sur Chrome mobile (F12 → device toolbar → iPhone 12 Pro)
5. **Production** → **Versions** → **Créer une version** → uploader `app-release.aab`
6. **Avant la mise en production** : Google vérifiera `assetlinks.json` automatiquement

## Vérification rapide avant soumission

```bash
# Tester que l'endpoint est live et retourne le bon JSON
curl -s https://kinevia.pro/.well-known/assetlinks.json | python3 -m json.tool

# Vérifier le manifest
curl -s https://kinevia.pro/manifest.json | python3 -m json.tool
```

Outil Google de validation des liens d'assets :
https://developers.google.com/digital-asset-links/tools/generator

## Conservation du keystore

Le fichier `.keystore` est **irremplaçable**. Si perdu, impossible de publier des mises à jour.
Stocker dans : Google Drive (chiffré) + coffre-fort de mots de passe.

## Package name final

`pro.kinevia.app` — une fois publié, ce package name est permanent et ne peut pas changer.
