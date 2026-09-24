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

Ouvrir `docs/EXPERIENCES.md` (analyse) et `docs/resultats/` (rapports bruts générés par `npm run experiments`, `scenarios`, `calibrate`, `optimize`, `bench`) :

- **Baselines** (16 graines appariées × 2 orientations) : complet contre aléatoire +9,6 xG (100 % de victoires), contre glouton « sécurité » +7,3 xG, contre défense sans hongrois +0,7 xG (+1,4 but, p = 0,03) ; anticipation et terme de risque non mesurables sur un match ; le glouton « progression » bat le complet (−3,1 xG) — à expliquer : poids par défaut prudents, défense simulée vulnérable au jeu direct, et l'apprentissage le confirme.
- **Tournoi tactique** : 7 styles, 672 matchs, Elo ; le jeu en largeur, la contre-attaque et le jeu direct dominent, la possession est dernière ; cycle non transitif (largeur > direct > contre > largeur) ; indicateurs structurels (ligne défensive −19 à −26 m, appels 25 à 100, réussite des passes 61 à 74 %) qui prouvent que la tactique change les décisions.
- **Ablations** : seul le temps de réaction du modèle est significatif ; robustesse à β et η.
- **Scénarios** : accord expert 70 % (84 % sur les scénarios réservés), regret moyen 0,0001.
- **Calibration** : Brier 0,209, bien calibré au-dessus de 0,6, pessimiste en dessous (diagramme de fiabilité).
- **Apprentissage** : CEM 12 générations, fitness moyenne −2,7 → −0,2, poids appris plus directs (`wProgress` × 2,6) — cohérent avec les baselines.
- **Latence** : 2,5 ms par cycle en match (p95 5,5 ms), 5,7 ms sur des états générés denses (p95 8,5 ms).

## 7. Limites et perspectives (30 s)

- Physique 2D simplifiée (pas de fautes, pas de fatigue, ballons aériens réduits aux lobs) ; menace analytique plutôt qu'estimée sur données réelles ; réponse adverse réduite à un petit ensemble.
- Perspectives : apprentissage par renforcement des poids en ligne, estimation de `xT` sur données de tracking, profondeur 3 avec élagage.

## Questions probables du jury

- *Pourquoi des logistiques ?* Sorties bornées dans [0,1], additivité des contributions dans le logit, calibrables par régression.
- *Pourquoi l'algorithme hongrois ?* Le marquage est un problème d'affectation ; l'optimum global évite les doubles marquages (ablation « affectation gloutonne »).
- *Pourquoi une profondeur 2 seulement ?* Budget temps réel (< 5 ms par cycle pour 22 joueurs, mesuré par `npm run bench`) ; la profondeur 3 sert d'oracle hors ligne.
- *Le système est-il déterministe ?* Oui à graine fixée (générateur Mulberry32 injecté) — reproductibilité des expériences.
