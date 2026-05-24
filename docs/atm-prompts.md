# ATM Exercise Image Prompts — v3

Generated: 2026-05-05
Total exercises: 22
Style: Flat 2D medical illustration, pure white background, clinical vector style, French anatomical labels

## Changes from v2

- **Green arrows** = correct movement direction (replaces blue)
- **Red arrows/marks** = incorrect movement or posture to avoid (replaces orange for resistance; orange now reserved for muscle highlights)
- **Consistent style suffix** across all prompts: "no shadows, flat 2D style"
- **Improved muscle highlighting**: soft orange for all highlighted muscles
- **Clearer anatomical specificity**: more precise muscle names and fiber directions
- **Visual hierarchy**: green checkmarks for correct positions, red X for incorrect

## Design Principles

| Element | Colour | Usage |
|---------|--------|-------|
| Correct movement arrows | Green (#22C55E) | Direction of intended exercise movement |
| Incorrect movement / resistance | Red (#EF4444) | Force to resist, posture to avoid, deviated path |
| Muscle highlights | Soft orange (#FB923C) | Targeted muscles, anatomical overlays |
| Labels | Dark grey (#374151) | French anatomical terms |
| Background | Pure white (#FFFFFF) | All images |
| Checkmark | Green | Correct position/posture |
| X mark | Red | Incorrect position/posture |

## Generation Method

Images generated via DALL-E 3 (`1024x1024`, `standard` quality).
Uploaded to Cloudflare R2 via Polsia proxy.
Triggered via: `POST /api/admin/generate-images?zone=atm&force=true`

---

## Prompts by Exercise

### 1. Ouverture mandibulaire contrôlée
**Category:** Mobilisation — Ouverture/Fermeture
**View:** Left-profile lateral
**Prompt:**
```
Flat 2D medical illustration on pure white background. Left-profile lateral view of a seated patient's head and jaw. Mouth open 3-4 cm in controlled vertical opening. Tongue tip visible touching palate behind upper incisors. One index finger placed gently under chin for guidance. Green downward arrow along mandible showing correct jaw-drop trajectory. A thin vertical green dotted line from nose to chin showing midline alignment. Muscles highlighted in soft orange: digastrique, mylohyoïdien. French labels in dark grey: "Langue sur le palais", "Ouverture contrôlée ↓", "Axe médian", "Digastrique". No shadows, flat colours, clean vector style.
```

---

### 2. Ouverture mandibulaire avec résistance
**Category:** Mobilisation — Ouverture/Fermeture
**View:** Three-quarter frontal
**Prompt:**
```
Flat 2D medical illustration on pure white background. Three-quarter frontal view of patient's lower face. Mouth slightly open (2 cm). Thumb placed under chin pointing upward, index finger resting on chin top. Red arrow pointing UP from thumb showing resistance force. Green arrow pointing DOWN showing correct jaw opening direction. The opposing forces clearly visible. Isometric contraction zone highlighted between the two arrows. French labels: "Pouce (résistance ↑)", "Ouverture active ↓", "Contraction isométrique 5s", "Digastrique". Flat colours, clean lines, no shadows.
```

---

### 3. Fermeture mandibulaire résistée
**Category:** Mobilisation — Ouverture/Fermeture
**View:** Frontal
**Prompt:**
```
Flat 2D medical illustration on pure white background. Frontal view of patient's lower face with mouth open 2 cm. Two fingers placed on lower front teeth pressing downward. Red arrow pointing DOWN from fingers showing resistance. Green arrow pointing UP showing correct jaw-closing force. Masséter muscle highlighted in soft orange on both cheeks. Temporal muscle highlighted in soft orange on temple area. French labels: "Doigts (résistance ↓)", "Fermeture active ↑", "Masséter", "Temporal". Clean flat medical style, no shadows.
```

---

### 4. Diduction mandibulaire (latéralité)
**Category:** Mobilisation — Latéralité
**View:** Frontal (3 positions)
**Prompt:**
```
Flat 2D medical illustration on pure white background. Frontal view of patient's lower face. Three sequential positions shown left to right: jaw centered (neutral), jaw shifted right, jaw shifted left. Mouth slightly open 1 cm throughout. Green horizontal arrows showing correct lateral movement in both directions. Vertical green dotted midline for reference alignment. French labels: "Position neutre", "Latéralité droite →", "Latéralité gauche ←", "Ouverture 1-2 cm". Flat colours, clean lines, no shadows.
```

---

### 5. Diduction avec résistance latérale
**Category:** Mobilisation — Latéralité
**View:** Frontal
**Prompt:**
```
Flat 2D medical illustration on pure white background. Frontal view of patient's lower face. Index finger pressing against right side of chin. Green arrow pointing RIGHT showing correct jaw push direction into resistance. Red arrow pointing LEFT showing finger resistance force. Ptérygoïdien latéral highlighted in soft orange on left jaw. French labels: "Doigt (résistance ←)", "Poussée mandibulaire →", "Ptérygoïdien latéral", "Isométrique 5s". Clean flat style, no shadows.
```

---

### 6. Propulsion mandibulaire
**Category:** Mobilisation — Propulsion/Rétropulsion
**View:** Left-profile lateral (overlaid positions)
**Prompt:**
```
Flat 2D medical illustration on pure white background. Left-profile lateral view of patient's head. Two jaw positions overlaid: solid outline = neutral (teeth aligned), dashed outline = protruded (lower incisors forward of upper). Green horizontal arrow pointing FORWARD between positions. Ptérygoïdien latéral muscle highlighted in soft orange near condyle area. French labels: "Position neutre", "Propulsion →", "Incisives inférieures en avant", "Ptérygoïdien latéral". Flat clinical style, no shadows.
```

---

### 7. Rétropulsion mandibulaire douce
**Category:** Mobilisation — Propulsion/Rétropulsion
**View:** Left-profile lateral (overlaid positions)
**Prompt:**
```
Flat 2D medical illustration on pure white background. Left-profile lateral view of patient's head. Two jaw positions overlaid: solid outline = neutral, dashed outline = retracted (chin drawn back). Green arrow pointing BACKWARD showing correct retraction. Temporal posterior fibres and digastrique muscles highlighted in soft orange. French labels: "Position neutre", "Rétropulsion ←", "Temporal (fibres post.)", "Digastrique", "Maintien 3s". Flat clinical style, no shadows.
```

---

### 8. Étirement des masséters (massage transverse)
**Category:** Étirements Masticateurs
**View:** Frontal
**Prompt:**
```
Flat 2D medical illustration on pure white background. Frontal view of patient's face. Both index fingers pressing firmly on cheeks at masséter location (below zygomatic arch, above jaw angle). Masséter muscles outlined in soft orange on both sides with internal fibre direction visible. Green downward arrows on each cheek showing correct massage direction. French labels: "Masséter superficiel", "Masséter profond", "Pression transversale ↓", "30s chaque côté". Flat 2D style, no shadows.
```

---

### 9. Auto-étirement du masséter en ouverture
**Category:** Étirements Masticateurs
**View:** Three-quarter frontal
**Prompt:**
```
Flat 2D medical illustration on pure white background. Three-quarter frontal view of patient's face, mouth fully open. Both thumbs under chin for support. Both index fingers on masséter area (cheeks). Green downward arrow on mandible showing jaw opening. Small green arrows on cheeks showing massage direction downward. Masséters highlighted in soft orange. French labels: "Pouces sous le menton", "Index sur masséters", "Ouverture maximale ↓", "Massage ↓". Flat clinical style, no shadows.
```

---

### 10. Étirement ptérygoïdien latéral (propulsion forcée)
**Category:** Étirements Masticateurs
**View:** Left-profile lateral
**Prompt:**
```
Flat 2D medical illustration on pure white background. Left-profile lateral view of patient's head. Jaw fully protruded forward (maximal propulsion). Fingers on chin pressing forward to amplify stretch. Ptérygoïdien latéral highlighted in soft orange behind condyle near ATM joint. Green arrow pointing forward showing propulsion direction. Small green arrow at chin showing manual pressure direction. French labels: "Ptérygoïdien latéral (étirement)", "Propulsion maximale →", "Pression manuelle →", "Condyle ATM", "20s". Flat 2D style, no shadows.
```

---

### 11. Étirement ptérygoïdien médial (bouche ouverte latéralisée)
**Category:** Étirements Masticateurs
**View:** Frontal
**Prompt:**
```
Flat 2D medical illustration on pure white background. Frontal view of patient's face with mouth half-open. Lower jaw deviated to the RIGHT. Ptérygoïdien médial on LEFT side highlighted in soft orange (stretched muscle, opposite side from deviation). Green arrow showing lateral jaw shift to right. Stretch indicator on left inner jaw angle. French labels: "Bouche mi-ouverte", "Déviation droite →", "Ptérygoïdien médial gauche (étiré)", "20s". Flat clinical style, no shadows.
```

---

### 12. Massage du temporal
**Category:** Étirements Masticateurs — Temporaux
**View:** Frontal
**Prompt:**
```
Flat 2D medical illustration on pure white background. Frontal view of patient's head. Both palms placed on temples above ears. Temporal muscles clearly outlined in soft orange on both sides. Green circular arrows showing clockwise massage motion on each temple. French labels: "Temporal (zone hypertonique)", "Mouvement circulaire", "Région temporale", "Pression ferme 30s". Flat 2D style, no shadows.
```

---

### 13. Étirement du temporal (bouche ouverte)
**Category:** Étirements Masticateurs — Temporaux
**View:** Left-profile lateral
**Prompt:**
```
Flat 2D medical illustration on pure white background. Left-profile lateral view of patient's head. Mouth fully open at maximum amplitude. Fingertips placed on temporal region above ear. Temporal muscle outlined in soft orange showing stretch from maximum jaw opening. Green downward arrow on mandible showing jaw-drop direction. Small stretch indicators on temporal muscle. French labels: "Ouverture maximale ↓", "Temporal (étirement)", "Doigts sur la tempe", "Relâchement progressif 30s". Flat 2D style, no shadows.
```

---

### 14. Position de repos mandibulaire
**Category:** Relaxation & Posture
**View:** Sagittal cross-section
**Prompt:**
```
Flat 2D medical illustration on pure white background. Sagittal cross-section view of patient's lower face at rest. Lips slightly apart (2-3 mm gap shown). Tongue tip touching palate just behind upper incisors (green highlight on tongue position). Teeth NOT touching (visible gap). Small green arrow entering nose showing nasal breathing. Green checkmark near tongue position. French labels: "Lèvres entrouvertes 2-3mm", "Langue sur le palais", "Dents séparées", "Respiration nasale →", "Position de repos". Anatomical cross-section, flat 2D style, no shadows.
```

---

### 15. Correction posturale cervico-mandibulaire
**Category:** Relaxation & Posture
**View:** Lateral (split panel — incorrect vs correct)
**Prompt:**
```
Flat 2D medical illustration on pure white background. Two side-by-side lateral profile panels. LEFT panel: incorrect posture — head forward, chin protruding, cervical lordosis exaggerated. Red X mark. Red outline on forward head position. RIGHT panel: correct posture — chin gently retracted (chin tuck), cervical spine aligned, jaw relaxed in rest position. Green checkmark. Green arrow showing backward chin retraction movement. French labels: "Mauvaise posture", "Bonne posture", "Rétraction cervicale", "Menton rentré", "Mâchoire relâchée", "Colonne cervicale alignée". Split-panel flat illustration, no shadows.
```

---

### 16. Respiration nasale diaphragmatique anti-bruxisme
**Category:** Relaxation & Posture
**View:** Lateral supine + phases
**Prompt:**
```
Flat 2D medical illustration on pure white background. Patient lying supine with one hand on belly. Diaphragm shown as dome shape inside torso highlighted in soft orange. Three numbered phases arranged vertically: Phase 1 "Inspiration 4s" with green upward arrow on belly and green arrow into nose. Phase 2 "Blocage 2s" neutral. Phase 3 "Expiration 6s" with green downward arrow on belly and green arrow out of nose. Small inset box: relaxed jaw with teeth apart and green checkmark. French labels: "Main sur le ventre", "Diaphragme", "Inspiration nasale 4s", "Blocage 2s", "Expiration 6s", "Mâchoire décontractée". Flat 2D style, no shadows.
```

---

### 17. Auto-massage points trigger masséter
**Category:** Auto-massage & Points Trigger
**View:** Frontal (focus right cheek)
**Prompt:**
```
Flat 2D medical illustration on pure white background. Frontal view of patient's face, focus on right cheek. Masséter muscle outlined in soft orange on right side. Three red dots marking trigger points on the masséter at different depths. One thumb pressing firmly on the most tender trigger point. Green concentric circles radiating outward from pressure point showing ischemia-reperfusion effect. French labels: "Points trigger", "Pression soutenue 60-90s", "Ischémie → reperfusion", "Masséter", "Relâchement progressif". Flat clinical style, no shadows.
```

---

### 18. Auto-massage intra-buccal du ptérygoïdien médial
**Category:** Auto-massage & Points Trigger
**View:** Sagittal cross-section
**Prompt:**
```
Flat 2D medical illustration on pure white background. Sagittal cross-section of open mouth showing interior anatomy. Index finger inserted into mouth behind lower molars, pressing inward on medial pterygoid muscle on inner jaw wall. Ptérygoïdien médial clearly highlighted in soft orange in deep jaw area. Small green circular arrows showing massage motion on the muscle. French labels: "Index intra-buccal", "Derrière les molaires inférieures", "Ptérygoïdien médial", "Massage circulaire 30s". Anatomical cross-section, flat 2D style, no shadows.
```

---

### 19. Massage crâne et région temporale (auto-drainage)
**Category:** Auto-massage & Points Trigger
**View:** Top-down (bird's eye)
**Prompt:**
```
Flat 2D medical illustration on pure white background. Top-down superior view of patient's head (bird's eye). Fingertips of both hands positioned on scalp. Green dotted arrow path going from base of skull (nuque) upward through temporal region to temples. Green circular motion icons at three key points: occipital, temporal, frontal. Muscles labelled: "Temporal", "Frontalis", "Sous-occipitaux". French labels: "Départ : nuque", "Remontée vers les tempes ↑", "Zone temporale", "Petits cercles", "2 min". Flat overhead anatomical view, no shadows.
```

---

### 20. Exercice de coordination lingua-palatine
**Category:** Coordination Linguo-Mandibulaire
**View:** Sagittal cross-section
**Prompt:**
```
Flat 2D medical illustration on pure white background. Sagittal cross-section of closed mouth and palate. Tongue shown flat against upper palate in correct high position with green highlight. Green upward suction arrows between tongue and palate showing negative pressure. Green checkmark near tongue. French labels: "Langue à plat sur le palais", "Aspiration (suçon) ↑", "Position haute correcte", "Palais dur", "Dents fermées". Anatomical cross-section, flat 2D style, no shadows.
```

---

### 21. Claquement contrôlé de langue (coordination)
**Category:** Coordination Linguo-Mandibulaire
**View:** Sagittal cross-section (2 panels)
**Prompt:**
```
Flat 2D medical illustration on pure white background. Sagittal cross-section in two sequential panels. LEFT panel: tongue flat on palate, mouth closed, green highlight on tongue position. Label "Phase 1 : Langue sur le palais". RIGHT panel: jaw drops rapidly downward (green arrow down) while tongue stays stuck to palate (green arrow up). Sound wave icon near mouth. Label "Phase 2 : Claquement". French labels: "Langue maintenue ↑", "Mandibule abaissée ↓", "Dissociation linguo-mandibulaire", "Digastrique". Two-panel flat 2D style, no shadows.
```

---

### 22. Exercice de stabilisation mandibulaire (langue haut, yeux ouverts)
**Category:** Coordination Linguo-Mandibulaire
**View:** Frontal with mirror
**Prompt:**
```
Flat 2D medical illustration on pure white background. Frontal view of patient seated facing a mirror. Mirror reflection shows patient's face with vertical green dotted midline. Green vertical arrow showing correct straight jaw-drop trajectory along midline. Red dashed curved arrow showing incorrect deviated path to avoid. Tongue shown in high palatal position with green highlight. French labels: "Miroir", "Trajectoire correcte ↓", "Déviation à éviter", "Langue sur le palais", "Proprioception visuelle". Flat 2D clinical style, no shadows.
```

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| v1 | 2026-05-05 | Initial generic prompts (migration 062) |
| v2 | 2026-05-05 | Refined anatomical prompts with French labels (migration 063) |
| v3 | 2026-05-05 | Green/red arrow system, improved consistency, better muscle specificity |
