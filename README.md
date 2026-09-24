# Décision tactique — simulation football (TIPE MPI)

Système complet de **prise de décision tactique** appliqué au football : à partir d'une situation de jeu (22 joueurs + ballon), l'algorithme calcule pour chaque joueur la meilleure action (passer, dribbler, tirer, conserver, se déplacer, faire un appel, presser, marquer, couvrir, se replier…), anime une simulation 11 contre 11 en temps réel et **explique visuellement** chaque décision : candidats, scores, probabilités, contributions nommées.

Le projet sert de démonstrateur principal d'un TIPE de MPI : il réunit des **modèles mathématiques** (contrôle du terrain, menace espérée, pression, interception, probabilités logistiques de réussite), un **algorithme de décision** (espérance de valeur avec risque, anticipation à deux coups avec réponse adverse, affectation optimale par l'algorithme hongrois, hystérésis, réponse quantale), une **couche tactique** (formations et profils exprimés comme vecteurs de paramètres) et un **banc d'expériences** (scénarios, baselines, tournoi tactique, ablations, optimisation par méthode d'entropie croisée, calibration, statistiques).

## Installation et lancement

Prérequis : Node.js ≥ 20 (testé avec Node 22).

```bash
npm install          # installe les dépendances (Vite, TypeScript, Vitest, tsx)
npm run dev          # lance l'interface : http://localhost:5173
```

Autres commandes :

```bash
npm run build        # version statique dans dist/ (servable sans serveur Node)
npm test             # suite de tests (vitest)
npm run typecheck    # vérification TypeScript
npm run sim -- --minutes 5 --seed 3 --tacticA 4-3-3:possession --tacticB 4-4-2:counter
                     # match headless avec tableau de statistiques, latence et événements
npm run scenarios -- --seeds 8            # bibliothèque de scénarios : accord expert, regret, KPI
npm run experiments -- --quick            # baselines, tournoi tactique, ablations → results/EXPERIENCES.md
npm run optimize -- --generations 10      # optimisation des poids (CEM) → results/learning/
npm run bench                             # latence de décision (p50/p95/p99) et facteur temps réel
npm run calibrate                         # calibration des modèles probabilistes (Brier, fiabilité par distance, réajustement de Platt)
npm run screenshot                        # captures d'écran de l'interface (Playwright)
```

Toutes les expériences sont **déterministes à graine fixée** : même graine ⇒ même match.

## Interface

- **Terrain** : joueurs (A en bleu, attaque vers la droite ; B en rouge), ballon, trajectoires, cible de déplacement de chaque joueur avec son intention (soutien, appel, largeur, pressing, marquage, couverture, repli…).
- **Calques** (touches 1 à 9) : contrôle du terrain, zones dangereuses (menace), pression, espaces disponibles, lignes de passe colorées par score avec probabilité de réussite, trajectoires, déplacements, affectations défensives, étiquettes.
- **Panneau Décision** : pour le porteur (ou le joueur sélectionné d'un clic) — action optimale, cible, score, probabilité, raison ; classement de tous les candidats ; décomposition additive du score (menace, contrôle, progression, soutien, lignes franchies, risque, possession abandonnée, durée, hystérésis, anticipation, réponse adverse, modulation tactique) ; formule `Score = P·V⁺ − (1−P)·V⁻ − C` avec les valeurs ; menaces d'interception ; meilleure réponse défensive (hold / press / cover / drop) et, en cas de dilemme, la matrice du jeu 2×2 avec la stratégie mixte. Pour un joueur sans ballon : intention (soutien, appel, largeur, créer / exploiter un espace, structure, pressing, marquage, couverture, repli…) et décomposition de l'utilité des positions candidates.
- **Tactiques** : formation (4-3-3, 4-4-2, 3-5-2, 4-2-3-1, 3-4-3) et style (équilibré, possession, contre-attaque, pressing haut, bloc bas, jeu en largeur, jeu direct) par équipe, plus les curseurs des 18 paramètres tactiques ; l'effet est immédiat sur les décisions.
- **Paramètres** : poids de la fonction d'évaluation et paramètres des modèles, modifiables en direct.
- **Statistiques** : buts, tirs, xG, passes, dribbles, tacles, interceptions, pertes, possession, menace créée, latence des décisions, regret.
- **Scénarios** : 26 situations prédéfinies (contre 3 contre 2, construction sous pressing, bloc bas, 1 contre 1 gardien, piège du hors-jeu, renversement, impasse…).
- **Mode présentation** (`P`) : masque l'aide, agrandit le terrain — prévu pour la projection.
- Raccourcis : `Espace` lecture/pause, `N` pas à pas, `R` réinitialiser, `1`–`9` calques, `+`/`−` vitesse (×0,25 à ×8), `P` présentation, clic sur un joueur pour voir sa décision (porteur ou non).

## Organisation du code

```
src/core         fondations : types partagés, paramètres par défaut, géométrie, grille, RNG, hongrois, statistiques
src/models       modèles : temps d'arrivée, contrôle du terrain, menace, pression, interception, probabilités, structure
src/engine       moteur : création de match, cinématique, ballon, actions, règles, boucle de simulation
src/decision     algorithme : porteur (candidats, évaluation, anticipation), sans ballon, défense, gardien, coordonnateur, baselines
src/tactics      formations et profils tactiques → vecteur de paramètres
src/experiments  banc d'expériences : scénarios, métriques, tournoi, ablations, CEM, calibration
src/ui           interface Canvas 2D (rendu, calques, panneaux)
scripts          lignes de commande (sim, scenarios, experiments, optimize, bench, calibrate, screenshot)
tests            tests unitaires et d'intégration (vitest)
docs             CONCEPTION.md (spécification scientifique + écarts d'implémentation §15), EXPERIENCES.md (résultats), GUIDE_PRESENTATION.md
```

## Principe de l'algorithme (résumé)

1. **Champs spatiaux** (une fois par cycle de 0,2 s) : temps d'arrivée de chaque joueur en chaque point (accélération bornée, temps de réaction), contrôle du terrain par softmin des temps d'arrivée, menace analytique `xT(q)` (angle et distance au but), pression directionnelle.
2. **Porteur** : ≤ 50 candidats (passes vers chaque coéquipier à plusieurs vitesses d'arrivée, passes appuyées et lobées pour les longues distances, passes en profondeur, 16 dribbles, tir, conservation, dégagement). Pour chaque candidat : probabilité de réussite `P` (modèle logistique + interception à une chance par défenseur, calibrée contre les issues du moteur), valeur en cas de succès `V⁺` (menace × contrôle, progression, soutien, lignes franchies), coût en cas d'échec `V⁻` (menace adverse au point de perte + possession abandonnée), coût `C` (temps, hors-jeu). Les 5 meilleurs sont développés à profondeur 2 : pour chaque réponse défensive de l'ensemble {tenir, presser, couvrir, reculer} on recalcule la menace du point d'arrivée et la meilleure suite du receveur, et on retient le minimum (minimax). Quand deux actions de types différents sont à égalité, un jeu 2×2 à somme nulle est résolu (point-selle ou stratégie mixte de Nash) et l'action est tirée au sort selon l'équilibre. Sélection avec hystérésis déterministe et réponse quantale (température réglable). Le score est une somme de contributions nommées : l'explication est la décomposition exacte, pas un texte reconstruit.
3. **Sans ballon** : chaque attaquant maximise une utilité sur 29 positions candidates (valeur recevable, gain d'espace, exposition adverse, rappel au poste, séparation, hors-jeu, appels).
4. **Défense** : tâches (presser, contenir, marquer, couvrir, intercepter, se replier) affectées aux 10 joueurs de champ par l'algorithme hongrois sur une matrice de coûts en secondes, avec déclencheurs de pressing tactiques et hystérésis.
5. **Tactiques** : formation + style ⇒ vecteur de 18 paramètres qui module poids, seuils et lignes ; les tactiques changent réellement les décisions (mesuré dans le tournoi).
6. **Expériences** : baselines (aléatoire, glouton, sans anticipation, sans risque, sans tactique, affectation gloutonne), tournoi 7 styles, ablations, CEM, calibration ; intervalles de confiance bootstrap, Wilcoxon, delta de Cliff, Elo.

La spécification complète (notations, formules, paramètres, justifications, références) est dans `docs/CONCEPTION.md`.
