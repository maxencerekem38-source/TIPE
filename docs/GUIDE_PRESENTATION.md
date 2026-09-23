# Guide de présentation orale (TIPE)

Ce guide propose un déroulé de démonstration de 8 à 10 minutes avec l'interface, et les points scientifiques à mettre en avant à chaque étape. Lancer `npm run dev` puis ouvrir `http://localhost:5173` (ou servir le dossier `dist/` après `npm run build`). Ouvrir l'interface **avant** l'oral et charger un scénario : l'affichage est immédiat.

## 1. Le problème (30 s)

- 22 joueurs, un ballon, un cycle de décision toutes les 0,2 s : **quelle est la meilleure action de chaque joueur ?**
- Ce que le système doit produire : une action, un score, une probabilité, une **explication vérifiable**.

## 2. Une décision expliquée (2 min) — scénario « Contre-attaque 3 contre 2 »

Onglet **Scénarios** → *Transitions — Contre-attaque 3 contre 2*. Le protagoniste est sélectionné, l'onglet **Décision** affiche :

- `ACTION OPTIMALE`, `CIBLE`, `SCORE`, `PROBABILITÉ`, `RAISON`.
- Le classement de tous les candidats (≈ 35) : passes, passes en profondeur, dribbles, tir, conservation.
- Cliquer sur un candidat : **décomposition additive du score** — chaque ligne est une contribution nommée (menace de la zone d'arrivée, contrôle, progression, soutien, lignes franchies, risque en cas de perte, durée, anticipation, modulation tactique). La somme des contributions est exactement le score : l'explication n'est pas reconstituée a posteriori.
- La formule : `Score = P · V⁺ − (1 − P) · V⁻ − C`, en **buts espérés**. Insister sur l'unité commune qui rend comparables passe, dribble et tir.

Sur le terrain, calque **Lignes de passe** : couleur = score, épaisseur = probabilité, étiquette = probabilité ; les adversaires susceptibles d'intercepter sont entourés. Passer la souris sur un candidat du panneau pour le mettre en évidence.

## 3. Les modèles derrière les nombres (2 min)

Activer successivement les calques (touches 1, 2, 3) :

1. **Contrôle du terrain** : softmin des temps d'arrivée (accélération bornée, temps de réaction). Limite β → 0 = diagramme de Voronoï des temps (testé unitairement).
2. **Zones dangereuses** : menace `xT(q)` = xG géométrique (angle sous lequel on voit les poteaux, distance) + terme de progression ; valeur d'une position ≈ probabilité de marquer à terme.
3. **Pression** : somme de gaussiennes directionnelles (un défenseur côté but et en approche pèse plus).

Puis la **probabilité d'une passe** : `(1 − P_int) · σ(β₀ + β·caractéristiques)` avec `P_int` calculée par échantillonnage de la trajectoire du ballon (12 points, temps de trajet du ballon roulant contre temps d'arrivée des défenseurs). Montrer l'onglet **Paramètres** : tous les coefficients sont réglables en direct.

## 4. Anticipation et théorie des jeux (1 min 30)

- Les 5 meilleurs candidats sont développés à **profondeur 2** : que pourra faire le receveur, si les deux défenseurs les plus proches réagissent (réponse adverse pessimiste, borne physique par le modèle de mouvement) ? La composante « Meilleure suite » et la « réponse adverse » apparaissent dans la décomposition.
- **Hystérésis** : l'intention courante n'est abandonnée que si un challenger la dépasse d'une marge ; évite les oscillations (mesurées : changements d'intention par seconde dans les statistiques).
- **Réponse quantale** : à égalité près, tirage au sort pondéré (température réglable) — un joueur déterministe est prévisible, donc exploitable.

## 5. Sans ballon et défense (1 min 30) — scénario « Déclencheur de pressing »

- Calque **Déplacements** : chaque joueur sans ballon affiche son intention (soutien, appel, largeur, créer / exploiter un espace, structure) issue d'une **utilité** sur 29 positions candidates.
- Calque **Affectations défensives** : les tâches (presser, marquer, couvrir, se replier) sont affectées par l'**algorithme hongrois** sur une matrice de coûts en secondes (temps d'arrivée − priorité + écart à la structure + hystérésis). Cliquer sur un défenseur : ses 3 meilleures tâches et leurs coûts.
- Changer le style de l'équipe qui défend (onglet **Tactiques**) : *pressing haut* → deux presseurs dans le camp adverse ; *bloc bas* → le bloc recule et ne presse plus. Les tactiques sont des **vecteurs de paramètres**, pas des chemins de code.

## 6. Les expériences (2 min)

Ouvrir `docs/EXPERIENCES.md` (généré par `npm run experiments`) :

- **Baselines** : l'algorithme complet contre aléatoire, glouton, sans anticipation, sans risque, sans tactique, affectation gloutonne ; différences appariées par graine, intervalles de confiance bootstrap, test de Wilcoxon, delta de Cliff.
- **Tournoi tactique** : 7 styles, classement Elo, indicateurs structurels (hauteur de ligne, longueur de passe, part de passes en profondeur) qui prouvent que la tactique change les décisions.
- **Ablations** : sensibilité à l'anticipation (γ), au risque (λ), à la température du contrôle (β), à l'efficacité d'interception (η).
- **Apprentissage** : optimisation des poids par méthode d'entropie croisée (`npm run optimize`), courbe d'apprentissage.
- **Calibration** : score de Brier et diagramme de fiabilité des probabilités prédites contre les issues simulées (`npm run calibrate`).
- **Regret et accord expert** sur la bibliothèque de scénarios (`npm run scenarios`).

## 7. Limites et perspectives (30 s)

- Physique 2D simplifiée (pas de fautes, pas de fatigue, ballons aériens réduits aux lobs) ; menace analytique plutôt qu'estimée sur données réelles ; réponse adverse réduite à un petit ensemble.
- Perspectives : apprentissage par renforcement des poids en ligne, estimation de `xT` sur données de tracking, profondeur 3 avec élagage.

## Questions probables du jury

- *Pourquoi des logistiques ?* Sorties bornées dans [0,1], additivité des contributions dans le logit, calibrables par régression.
- *Pourquoi l'algorithme hongrois ?* Le marquage est un problème d'affectation ; l'optimum global évite les doubles marquages (ablation « affectation gloutonne »).
- *Pourquoi une profondeur 2 seulement ?* Budget temps réel (< 5 ms par cycle pour 22 joueurs, mesuré par `npm run bench`) ; la profondeur 3 sert d'oracle hors ligne.
- *Le système est-il déterministe ?* Oui à graine fixée (générateur Mulberry32 injecté) — reproductibilité des expériences.
