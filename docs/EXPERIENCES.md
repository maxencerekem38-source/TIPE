# Expériences : résultats et analyse

Toutes les mesures ci-dessous sont reproductibles : `npm run experiments -- --seeds 16 --minutes 10`, `npm run scenarios -- --seeds 16`, `npm run calibrate`, `npm run optimize -- --generations 12 --population 16 --matches 4 --minutes 3`, `npm run bench` (commit `bb124d9`, 24 septembre 2026, machine 4 cœurs). Les rapports bruts générés par les scripts sont copiés dans `docs/resultats/` (tableaux complets : intervalles de confiance de Student et bootstrap, tests de Wilcoxon, delta de Cliff, correction de Holm).

Conventions : un match simulé dure 10 minutes ; les différences sont **appariées par graine** (même graine ⇒ mêmes attributs de joueurs et même bruit d'exécution) et jouées dans les deux orientations (32 matchs par comparaison). L'indicateur principal est ΔxG (différence de buts espérés), les buts étant rares (≈ 2 par équipe et par 10 min) ; la menace créée, la réussite des passes, les pertes et le regret complètent l'analyse.

## 1. Ce que mesure chaque expérience

| Expérience | Question | Méthode |
|---|---|---|
| Baselines (§2) | Que vaut chaque composant de l'algorithme ? | L'algorithme complet contre sept politiques dégradées, à moteur identique |
| Tournoi tactique (§3) | Les tactiques changent-elles réellement les décisions ? | 7 profils en tournoi (672 matchs), Elo, indicateurs structurels |
| Ablations (§4) | Sensibilité aux paramètres du modèle | Variante contre défaut, graines appariées |
| Scénarios (§5) | L'algorithme choisit-il l'action « de manuel » ? | 26 situations × 16 graines, accord top-1 et regret |
| Calibration (§6) | Les probabilités prédites sont-elles justes ? | Auto-jeu, score de Brier, diagramme de fiabilité |
| Apprentissage (§7) | Peut-on améliorer les poids automatiquement ? | Méthode d'entropie croisée sur 19 paramètres |
| Latence (§8) | Le budget temps réel est-il tenu ? | p50/p95/p99 par cycle de décision |

## 2. Algorithme complet contre les baselines

| Comparaison (complet − baseline) | ΔxG | IC 95 % bootstrap | p (Wilcoxon) | δ de Cliff | Victoires (xG) |
|---|---:|---:|---:|---:|---:|
| B0 aléatoire | +9,59 | [8,78 ; 10,43] | < 0,001 | 1,00 | 100 % |
| B1′ glouton « sécurité » (passe la plus sûre) | +7,31 | [6,33 ; 8,32] | < 0,001 | 1,00 | 100 % |
| B6 défense « homme le plus proche » (sans hongrois) | +0,68 | [0,13 ; 1,30] | 0,058 | 0,55 | 69 % |
| B4 sans terme de risque | +0,29 | [−0,60 ; 1,16] | 0,53 | 0,19 | 63 % |
| B7 sans modulation tactique | +0,19 | [−0,50 ; 0,89] | 0,86 | 0,07 | 44 % |
| B2 sans anticipation (γ = 0) | −0,11 | [−1,26 ; 1,07] | 0,94 | 0,02 | 56 % |
| B1 glouton « progression » (action la plus verticale) | −3,10 | [−4,02 ; −2,19] | < 0,001 | −0,99 | 6 % |

Lecture.

- **La fonction d'évaluation est indispensable** : contre l'aléatoire (153 buts à 2 sur 32 matchs) et contre le glouton « sécurité » (134 à 0, possession 81 % mais jamais de tir), l'écart est total. Le glouton « sécurité » illustre l'unité commune en buts espérés : conserver le ballon sans progresser ne vaut rien.
- **L'affectation hongroise améliore la défense** : +0,68 xG et +1,44 but par match (p = 0,03 sur les buts, δ = 0,63) contre l'affectation gloutonne, à attaque identique. C'est l'effet du composant défensif le plus net.
- **L'anticipation à deux coups et le terme de risque ne se voient pas sur le résultat des matchs** (différences dans l'intervalle de bruit). Leur effet se mesure ailleurs : le regret par décision est nul pour l'algorithme complet par construction, et le banc de scénarios (§5) montre que la profondeur 2 change le classement des actions dans les situations de combinaison ; sur un match, ces gains sont dilués par la physique (réception, duels) et par la défense.
- **Le glouton « progression » bat l'algorithme complet** (−3,1 xG, 95 buts à 44). C'est le résultat le plus instructif : la politique qui joue systématiquement l'action la plus verticale parmi celles de probabilité ≥ 0,3 crée plus d'occasions, au prix d'une réussite des passes plus faible (−4,9 points) et d'une menace créée par action plus basse. Deux causes se combinent : (i) les poids par défaut (`wProgress` = 0,15, `lambdaRisk` = 1) sont trop prudents pour ce simulateur, ce que l'apprentissage confirme (§7 : le CEM multiplie `wProgress` par 2,6) ; (ii) la défense simulée est vulnérable au jeu direct (entrées de surface peu contestées, §15.5 de la conception), ce qui rend la verticalité artificiellement rentable. Le tournoi (§3) montre le même phénomène : les profils directs dominent.

## 3. Tournoi tactique (7 profils × 16 graines, 672 matchs)

| Profil | Elo (buts) | Elo (xG) | xG pour / contre | Possession | Réussite passes | Ligne défensive (m) | Long. passe (m) | Appels / match |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 3-4-3 jeu en largeur | 1584 | 1557 | 1,62 / 1,25 | 52 % | 70 % | −21,1 | 19,0 | 60 |
| 4-4-2 contre-attaque | 1551 | 1563 | 1,62 / 1,39 | 45 % | 61 % | −24,9 | 17,5 | 88 |
| 3-5-2 jeu direct | 1533 | 1551 | 2,15 / 1,49 | 46 % | 63 % | −24,3 | 17,9 | 100 |
| 4-4-2 bloc bas | 1527 | 1534 | 1,01 / 1,06 | 48 % | 63 % | −26,3 | 16,4 | 72 |
| 4-3-3 équilibré | 1472 | 1465 | 1,31 / 1,21 | 52 % | 71 % | −19,9 | 18,1 | 42 |
| 4-2-3-1 pressing haut | 1469 | 1485 | 1,31 / 1,85 | 52 % | 69 % | −20,7 | 16,8 | 55 |
| 4-3-3 possession | 1364 | 1346 | 0,88 / 1,66 | 56 % | 74 % | −19,3 | 16,4 | 25 |

Lecture.

- **Les tactiques changent les décisions, pas seulement la position de départ.** Les indicateurs structurels séparent nettement les profils : ligne défensive de −19 m (possession) à −26 m (bloc bas), appels en profondeur de 25 (possession) à 100 (jeu direct), réussite des passes de 61 % (contre-attaque) à 74 % (possession), possession de 45 % à 56 %. Ce sont les mêmes fonctions d'évaluation partout : seuls les vecteurs de paramètres diffèrent.
- **Hiérarchie** : le jeu en largeur, la contre-attaque et le jeu direct dominent ; la possession est dernière (Elo 1364, 158 buts marqués contre 340 encaissés). Les différences significatives après correction de Holm sont toutes contre le profil possession (largeur +1,19 xG, p < 0,001 ; direct +1,33, p = 0,001 ; bloc bas +0,57, p = 0,008 ; équilibré +0,74, p = 0,002) et pressing haut contre largeur (−0,81, p = 0,013). Comme en §2, le simulateur récompense la verticalité : la possession garde le ballon (56 %) et réussit ses passes (74 %) mais crée peu (0,88 xG par match).
- **Exploitabilité** (ΔxG contre le pire adversaire) : le jeu direct est le moins exploitable (−0,09), la possession la plus exploitable (−1,33 contre le jeu direct). Un tournoi n'a pas d'équilibre pur : la matrice ΔxG (rapport brut) montre que la largeur bat le direct de justesse (+0,09) alors que le direct bat le contre (+0,59) qui bat la largeur (+0,38) — un cycle pierre-feuille-ciseaux tactique.

## 4. Ablations de paramètres (variante − défaut)

| Ablation | ΔxG | IC 95 % | p | Interprétation |
|---|---:|---:|---:|---|
| τ_r = 0,5 s (temps de réaction du modèle) | +0,93 | [0,22 ; 1,67] | 0,025 | Un modèle de mouvement plus lent juge les passes plus sûres ⇒ jeu plus vertical ⇒ plus d'occasions |
| sans hystérésis | +0,76 | [0,06 ; 1,45] | 0,074 | La stabilité des intentions coûte un peu d'efficacité : compromis lisibilité / performance |
| K = 8 (largeur de la recherche) | +0,53 | [0,08 ; 0,99] | 0,068 | Développer plus de candidats aide légèrement, à +25 % de latence |
| β = 0,3 (contrôle ≈ Voronoï) | +0,48 | [−0,23 ; 1,16] | 0,27 | Non significatif |
| τ_r = 0,2 s | −0,56 | [−1,06 ; −0,06] | 0,074 | Symétrique du premier cas |
| β = 3 | −0,49 | [−1,30 ; 0,35] | 0,19 | Un contrôle trop « mou » dégrade |
| η = 0,2 / η = 0,6 | −0,42 / +0,02 | — | 0,43 / 0,82 | L'efficacité d'interception calibrée (0,35) est dans le plateau |
| λ_risk = 0 | −0,29 | [−1,16 ; 0,60] | 0,53 | Non significatif sur 16 graines |
| K = 3 | −0,35 | [−0,95 ; 0,26] | 0,32 | Non significatif |
| γ = 0 | +0,11 | [−1,07 ; 1,26] | 0,94 | Non significatif |

Seule τ_r = 0,5 s est significative au seuil 5 % (sans correction). Les ablations confirment que le système est **robuste** aux paramètres du modèle spatial (β, η) et que les leviers qui comptent sont ceux qui règlent la prudence (temps de réaction, hystérésis, largeur de recherche).

## 5. Bibliothèque de scénarios (26 situations × 16 graines)

- **Accord top-1 : 70,2 %** (la première décision du porteur appartient à l'ensemble des actions acceptables) ; sur les 8 scénarios **réservés** (jamais utilisés pour régler les paramètres) : **83,6 %**. Regret moyen 0,0001 but.
- 17 scénarios à 100 % (contre 3 contre 2, surnombre sur l'aile, bloc bas, 1 contre 1 gardien, piège du hors-jeu, tir ou remise, relance du gardien, profondeur contre ligne haute, surface encombrée, contre-pressing, dédoublement, 2 contre 1, attaquant entre les lignes, transition 5 contre 3, gardien sous pression, débordement, progression au milieu).
- Échecs instructifs : *construction sous pressing haut* et *passe en retrait sous pression* (0 %) — l'algorithme préfère une passe vers l'avant (P ≈ 0,3–0,5) à la passe de sécurité vers le gardien, cohérent avec la prudence insuffisante notée en §2 ; *renversement de jeu* (0 %) — un changement d'aile de 40 m reste jugé trop risqué par le modèle d'interception (§6) ; *dribble face à un défenseur isolé* (6 %) — la conservation l'emporte sur le dribble de 4 m depuis l'ajout de la marge sur les lignes franchies.

## 6. Calibration des probabilités (auto-jeu, 6 matchs de 5 min, 578 passes)

| Classe de P prédite | n | P moyenne prédite | fréquence observée |
|---|---:|---:|---:|
| [0,3 ; 0,4) | 38 | 0,36 | 0,58 |
| [0,4 ; 0,5) | 70 | 0,45 | 0,73 |
| [0,5 ; 0,6) | 105 | 0,56 | 0,71 |
| [0,6 ; 0,7) | 147 | 0,65 | 0,67 |
| [0,7 ; 0,8) | 102 | 0,75 | 0,77 |
| [0,8 ; 0,9) | 81 | 0,84 | 0,83 |

- Score de Brier 0,209 (référence : 0,214 pour la prédiction constante au taux de réussite 68,9 %), ECE 0,085. Le modèle est **bien calibré au-dessus de 0,6** et **pessimiste entre 0,3 et 0,6** : les passes jugées incertaines réussissent plus souvent que prévu, surtout les longues (20–30 m : prédit 0,53, observé 0,77). C'est la trace de la formule d'interception « une chance par défenseur » (§4.6 de la conception), calibrée pour ne pas surestimer les passes courtes : le réajustement des coefficients de distance (§11.6) ramène le Brier à 0,193 mais rend la possession trop aventureuse ; nous avons retenu un demi-pas (voir §15.2 de la conception). Un recalibrage de Platt a posteriori donne ECE 0,039.
- La grille (η, σ_T) est plate autour de l'optimum (Brier 0,204–0,212 pour η ∈ [0,3 ; 0,5], σ_T ∈ [0,3 ; 0,5]) : les valeurs retenues (η = 0,35, σ_T = 0,4 s) sont dans le plateau, ce que confirment les ablations (§4).
- Tirs : 36 tirs seulement, xG moyen prédit 0,17 pour 16,7 % de buts observés — effectif insuffisant pour un diagramme de fiabilité ; le score de Brier (0,036) est bon.

## 7. Apprentissage : optimisation des poids par entropie croisée

12 générations × 16 candidats (4 élites), 4 matchs de 3 min par évaluation à graines communes, adversaires gelés (défauts + 3 dernières élites), fitness F = E[ΔxG] + 0,3·E[Δmenace] − 0,2·E[danger des pertes] avec garde-fous contre les politiques dégénérées.

| Génération | 1 | 3 | 6 | 9 | 12 |
|---|---:|---:|---:|---:|---:|
| Fitness moyenne de la population | −2,70 | −0,44 | −0,38 | −0,16 | −0,17 |
| Meilleure fitness | 0,24 | 0,60 | 0,59 | 0,72 | 1,18 |
| σ moyen | 0,55 | 0,30 | 0,28 | 0,23 | 0,13 |

- La population converge (σ ÷ 4, fitness moyenne de −2,7 à ≈ −0,2, meilleure de 0,24 à 1,18) en 50 minutes de calcul ; les intervalles de confiance restent larges (4 matchs de 3 min par candidat), ce qui est la limite connue de l'auto-jeu bruité.
- Poids appris les plus déplacés : `decision.wProgress` 0,15 → 0,39 (× 2,6), `decision.wTime` 0,005 → 0,0004, `decision.hysteresis` → 0, `models.interceptEfficiency` 0,35 → 0,53, `defence.muPriority` 6 → 19, `offBall.wTeamExposure` 0,3 → 10,9. L'apprentissage retrouve **indépendamment** la conclusion des baselines : ce simulateur récompense un jeu plus direct et moins hésitant. Les valeurs par défaut n'ont pas été remplacées (le vecteur appris est dans `docs/resultats/params-optimises.json`) : elles ont été réglées pour un comportement lisible en démonstration (stabilité des intentions, réussite des passes ≈ 70 %), que les poids appris sacrifient.

## 8. Latence

| Mesure | moyenne | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| Cycle de décision en match (22 joueurs, champs inclus) | 2,50 ms | 1,42 | 5,48 | 8,13 |
| Cycle sur 100 états générés aléatoirement (plus denses) | 5,74 ms | 5,32 | 8,53 | 9,78 |

Budget : période de décision 0,2 s ; objectif p95 < 9 ms tenu dans les deux cas. Un match de 10 minutes se simule en ≈ 8 s (facteur temps réel × 70) ; l'interface tourne à 60 images/s avec 0,3–1 ms de décision par image.

## 9. Réalisme du jeu simulé (6 matchs de 10 min, trois paires de tactiques)

| Indicateur (par équipe et 10 min) | mesuré | repère |
|---|---:|---|
| Passes (réussite) | 75–100 (≈ 70 %) | 35–70 (70–88 %) |
| Passes en profondeur (part) | 15–17 % possession, 40–50 % contre | ≤ 30 % |
| Dribbles (prises à défaut) | ≈ 15 | 3–12 |
| Tirs / buts | ≈ 6 / ≈ 2 | 1–4 / 0,2–1 |
| Interceptions / pertes | ≈ 27 / ≈ 34 | 2–10 / 8–22 |
| Possession (tactiques symétriques) | 47–53 % | 40–60 % |
| Changements d'intention du porteur | 0,4–0,6 /s | < 0,5 /s |
| Changements de cible sans ballon | 0,2–0,45 /(joueur·s) | < 0,5 |
| Étendue du bloc défensif (x) | 35–44 m | 20–45 m |
| Fenêtres sans passe ni tir > 8 s | 0 | rare |

Les écarts restants (tirs, buts, interceptions) ont une cause commune identifiée et documentée (§15.5 de la conception) : le moteur perd ≈ 17 % des passes sans menace de ligne parce que le receveur ne recueille pas le ballon, et la défense de surface laisse des entrées non contestées. Ce sont des chantiers de la couche physique et du placement défensif, pas de l'algorithme de décision.

## 10. Conclusions

1. L'évaluation en buts espérés avec décomposition additive est à la fois **efficace** (écrase les politiques sans évaluation) et **explicable** (chaque décision se lit comme une somme de contributions).
2. L'**affectation optimale** (hongrois) est le composant défensif au gain le plus net ; l'anticipation à deux coups et le terme de risque n'ont pas d'effet mesurable sur le résultat d'un match à 16 graines, mais changent les décisions locales (scénarios).
3. Les **tactiques sont des vecteurs de paramètres** dont l'effet est mesurable sur la structure de jeu et le résultat ; le tournoi révèle un cycle non transitif.
4. Les probabilités sont **calibrées** au-dessus de 0,6 et pessimistes en dessous ; la calibration contre le simulateur (§11.6) est un outil de diagnostic honnête et reproductible.
5. L'**apprentissage** converge et retrouve la conclusion des baselines (jeu plus direct), ce qui valide la cohérence du protocole ; il révèle aussi le compromis démonstration lisible / performance brute.
6. Le simulateur a des **limites connues** (réception, défense de surface) qui expliquent les cibles de réalisme manquées et constituent les perspectives naturelles du projet.
