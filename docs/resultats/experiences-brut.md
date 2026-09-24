# Expériences

Généré le 24/09/2026 08:37:30 (git bb124d9) — 16 graines appariées × 10 min par match. Différences appariées par graine, IC 95 % de Student et bootstrap (2 000 rééchantillonnages), test de Wilcoxon signé, δ de Cliff ; correction de Holm pour les familles de comparaisons.

## 1. Algorithme complet contre les baselines

| Comparaison | ΔxG | IC 95 % (bootstrap) | p (Wilcoxon) | p (Holm) | δ Cliff | Δ menace | Δ regret | Victoires xG |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| complet vs B0 aléatoire | +9,587 | [8,775 ; 10,431] | < 0,001 *** | < 0,001 | 1,00 | +7,229 | -0,0004 | 100 % |
| complet vs B1 glouton (progression) | -3,097 | [-4,016 ; -2,186] | < 0,001 *** | < 0,001 | -0,99 | +0,498 | -0,0011 | 6 % |
| complet vs B1′ glouton (sécurité) | +7,313 | [6,334 ; 8,324] | < 0,001 *** | < 0,001 | 1,00 | +3,366 | -0,0042 | 100 % |
| complet vs B2 sans anticipation | -0,107 | [-1,262 ; 1,068] | 0,940 | 1,000 | 0,02 | -0,305 | +0,0000 | 56 % |
| complet vs B4 sans terme de risque | +0,289 | [-0,601 ; 1,159] | 0,528 | 1,000 | 0,19 | +0,394 | 0,0000 | 63 % |
| complet vs B7 sans modulation tactique | +0,188 | [-0,503 ; 0,889] | 0,860 | 1,000 | 0,07 | +0,049 | +0,0000 | 44 % |
| complet vs B6 défense « homme le plus proche » | +0,677 | [0,129 ; 1,295] | 0,058 | 0,231 | 0,55 | +0,568 | +0,0000 | 69 % |

### complet vs B0 aléatoire

16 graines appariées × 2 orientations = 32 matchs ; buts cumulés complet (B3) 153 – 2 B0 aléatoire. Différences = complet (B3) − B0 aléatoire.

| Indicateur | Δ moyen | IC 95 % (Student) | IC 95 % (bootstrap) | p (Wilcoxon) | δ de Cliff | Victoires |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| ΔxG | +9,587 | [8,629 ; 10,544] | [8,775 ; 10,431] | < 0,001 *** | 1,00 (grand) | 100 % |
| Δ buts | +9,44 | [8,10 ; 10,77] | [8,31 ; 10,75] | < 0,001 *** | 1,00 (grand) | 100 % |
| Δ menace créée | +7,229 | [6,786 ; 7,672] | [6,828 ; 7,618] | < 0,001 *** | 1,00 (grand) | 100 % |
| Δ possession (part) | -0,058 | [-0,085 ; -0,031] | [-0,082 ; -0,032] | < 0,001 *** | -0,89 (grand) | 13 % |
| Δ pertes / 10 min | -12,688 | [-14,104 ; -11,271] | [-13,906 ; -11,313] | < 0,001 *** | -1,00 (grand) | 0 % |
| Δ réussite des passes | +0,130 | [0,104 ; 0,157] | [0,108 ; 0,155] | < 0,001 *** | 0,99 (grand) | 100 % |
| Δ regret / décision | 0,000 | [0,000 ; 0,000] | [0,000 ; 0,000] | < 0,001 *** | -1,00 (grand) | 0 % |

### complet vs B1 glouton (progression)

16 graines appariées × 2 orientations = 32 matchs ; buts cumulés complet (B3) 44 – 95 B1 glouton (progression). Différences = complet (B3) − B1 glouton (progression).

| Indicateur | Δ moyen | IC 95 % (Student) | IC 95 % (bootstrap) | p (Wilcoxon) | δ de Cliff | Victoires |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| ΔxG | -3,097 | [-4,121 ; -2,074] | [-4,016 ; -2,186] | < 0,001 *** | -0,99 (grand) | 6 % |
| Δ buts | -3,19 | [-4,50 ; -1,88] | [-4,38 ; -2,06] | < 0,001 *** | -0,95 (grand) | 6 % |
| Δ menace créée | +0,498 | [0,137 ; 0,860] | [0,151 ; 0,804] | 0,013 * | 0,69 (grand) | 88 % |
| Δ possession (part) | -0,008 | [-0,035 ; 0,018] | [-0,032 ; 0,015] | 0,562 | -0,18 (faible) | 44 % |
| Δ pertes / 10 min | -0,375 | [-1,773 ; 1,023] | [-1,657 ; 0,844] | 0,532 | -0,07 (négligeable) | 44 % |
| Δ réussite des passes | +0,049 | [0,025 ; 0,073] | [0,026 ; 0,069] | 0,002 ** | 0,71 (grand) | 88 % |
| Δ regret / décision | -0,001 | [-0,001 ; -0,001] | [-0,001 ; -0,001] | < 0,001 *** | -1,00 (grand) | 0 % |

### complet vs B1′ glouton (sécurité)

16 graines appariées × 2 orientations = 32 matchs ; buts cumulés complet (B3) 134 – 0 B1′ glouton (sécurité). Différences = complet (B3) − B1′ glouton (sécurité).

| Indicateur | Δ moyen | IC 95 % (Student) | IC 95 % (bootstrap) | p (Wilcoxon) | δ de Cliff | Victoires |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| ΔxG | +7,313 | [6,195 ; 8,431] | [6,334 ; 8,324] | < 0,001 *** | 1,00 (grand) | 100 % |
| Δ buts | +8,38 | [6,67 ; 10,08] | [6,88 ; 9,94] | < 0,001 *** | 1,00 (grand) | 100 % |
| Δ menace créée | +3,366 | [2,826 ; 3,905] | [2,899 ; 3,883] | < 0,001 *** | 1,00 (grand) | 100 % |
| Δ possession (part) | -0,627 | [-0,661 ; -0,593] | [-0,658 ; -0,597] | < 0,001 *** | -1,00 (grand) | 0 % |
| Δ pertes / 10 min | -6,000 | [-7,276 ; -4,724] | [-7,125 ; -4,813] | < 0,001 *** | -0,78 (grand) | 0 % |
| Δ réussite des passes | -0,249 | [-0,285 ; -0,214] | [-0,280 ; -0,216] | < 0,001 *** | -1,00 (grand) | 0 % |
| Δ regret / décision | -0,004 | [-0,005 ; -0,004] | [-0,005 ; -0,004] | < 0,001 *** | -1,00 (grand) | 0 % |

### complet vs B2 sans anticipation

16 graines appariées × 2 orientations = 32 matchs ; buts cumulés complet (B3) 42 – 50 B2 sans anticipation. Différences = complet (B3) − B2 sans anticipation.

| Indicateur | Δ moyen | IC 95 % (Student) | IC 95 % (bootstrap) | p (Wilcoxon) | δ de Cliff | Victoires |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| ΔxG | -0,107 | [-1,438 ; 1,223] | [-1,262 ; 1,068] | 0,940 | 0,02 (négligeable) | 56 % |
| Δ buts | -0,50 | [-1,97 ; 0,97] | [-1,88 ; 0,81] | 0,521 | -0,21 (faible) | 31 % |
| Δ menace créée | -0,305 | [-1,065 ; 0,454] | [-0,966 ; 0,348] | 0,528 | -0,20 (faible) | 44 % |
| Δ possession (part) | +0,011 | [-0,006 ; 0,028] | [-0,005 ; 0,025] | 0,159 | 0,41 (moyen) | 69 % |
| Δ pertes / 10 min | -0,125 | [-2,244 ; 1,994] | [-2,156 ; 1,719] | 0,906 | 0,02 (négligeable) | 44 % |
| Δ réussite des passes | +0,008 | [-0,019 ; 0,036] | [-0,017 ; 0,033] | 0,274 | 0,12 (négligeable) | 69 % |
| Δ regret / décision | +0,000 | [0,000 ; 0,000] | [0,000 ; 0,000] | 0,252 | 0,28 (faible) | 69 % |

### complet vs B4 sans terme de risque

16 graines appariées × 2 orientations = 32 matchs ; buts cumulés complet (B3) 51 – 43 B4 sans terme de risque. Différences = complet (B3) − B4 sans terme de risque.

| Indicateur | Δ moyen | IC 95 % (Student) | IC 95 % (bootstrap) | p (Wilcoxon) | δ de Cliff | Victoires |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| ΔxG | +0,289 | [-0,727 ; 1,305] | [-0,601 ; 1,159] | 0,528 | 0,19 (faible) | 63 % |
| Δ buts | +0,50 | [-0,68 ; 1,68] | [-0,50 ; 1,56] | 0,426 | 0,21 (faible) | 44 % |
| Δ menace créée | +0,394 | [-0,221 ; 1,008] | [-0,173 ; 0,921] | 0,105 | 0,48 (grand) | 69 % |
| Δ possession (part) | +0,011 | [-0,008 ; 0,031] | [-0,007 ; 0,028] | 0,193 | 0,38 (moyen) | 69 % |
| Δ pertes / 10 min | -0,625 | [-2,431 ; 1,181] | [-2,188 ; 1,031] | 0,445 | -0,18 (faible) | 38 % |
| Δ réussite des passes | +0,007 | [-0,012 ; 0,027] | [-0,010 ; 0,024] | 0,433 | 0,18 (faible) | 56 % |
| Δ regret / décision | 0,000 | [0,000 ; 0,000] | [0,000 ; 0,000] | 0,009 ** | -0,66 (grand) | 13 % |

### complet vs B7 sans modulation tactique

16 graines appariées × 2 orientations = 32 matchs ; buts cumulés complet (B3) 43 – 44 B7 sans modulation tactique. Différences = complet (B3) − B7 sans modulation tactique.

| Indicateur | Δ moyen | IC 95 % (Student) | IC 95 % (bootstrap) | p (Wilcoxon) | δ de Cliff | Victoires |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| ΔxG | +0,188 | [-0,615 ; 0,991] | [-0,503 ; 0,889] | 0,860 | 0,07 (négligeable) | 44 % |
| Δ buts | -0,06 | [-0,98 ; 0,86] | [-0,88 ; 0,69] | 0,770 | -0,05 (négligeable) | 50 % |
| Δ menace créée | +0,049 | [-0,528 ; 0,626] | [-0,450 ; 0,580] | 0,980 | 0,02 (négligeable) | 50 % |
| Δ possession (part) | -0,017 | [-0,061 ; 0,027] | [-0,063 ; 0,016] | 0,900 | -0,05 (négligeable) | 50 % |
| Δ pertes / 10 min | -0,875 | [-2,044 ; 0,294] | [-1,906 ; 0,188] | 0,156 | -0,14 (négligeable) | 31 % |
| Δ réussite des passes | +0,004 | [-0,016 ; 0,024] | [-0,012 ; 0,022] | 1,000 | 0,08 (négligeable) | 56 % |
| Δ regret / décision | +0,000 | [0,000 ; 0,000] | [0,000 ; 0,000] | 0,782 | 0,06 (négligeable) | 50 % |

### complet vs B6 défense « homme le plus proche »

16 graines appariées × 2 orientations = 32 matchs ; buts cumulés complet (B3) 54 – 31 B6 défense « homme le plus proche ». Différences = complet (B3) − B6 défense « homme le plus proche ».

| Indicateur | Δ moyen | IC 95 % (Student) | IC 95 % (bootstrap) | p (Wilcoxon) | δ de Cliff | Victoires |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| ΔxG | +0,677 | [0,013 ; 1,340] | [0,129 ; 1,295] | 0,058 | 0,55 (grand) | 69 % |
| Δ buts | +1,44 | [0,21 ; 2,67] | [0,38 ; 2,56] | 0,032 * | 0,63 (grand) | 69 % |
| Δ menace créée | +0,568 | [0,052 ; 1,084] | [0,110 ; 1,025] | 0,034 * | 0,60 (grand) | 81 % |
| Δ possession (part) | -0,004 | [-0,025 ; 0,016] | [-0,022 ; 0,014] | 0,782 | -0,09 (négligeable) | 44 % |
| Δ pertes / 10 min | -0,656 | [-2,024 ; 0,712] | [-1,969 ; 0,531] | 0,419 | -0,03 (négligeable) | 38 % |
| Δ réussite des passes | -0,001 | [-0,016 ; 0,014] | [-0,014 ; 0,014] | 0,860 | -0,05 (négligeable) | 50 % |
| Δ regret / décision | +0,000 | [0,000 ; 0,000] | [0,000 ; 0,000] | 0,597 | 0,13 (négligeable) | 56 % |

## 2. Tournoi tactique

7 profils, 16 graines, matchs de 10 min, 672 matchs joués.

#### Classement

| Profil | Elo (buts) | Elo (xG) | Points | xG pour | xG contre | Buts | Exploitabilité (ΔxG vs pire adversaire) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 3-4-3:wide | 1584 | 1557 | 310 | 1,62 | 1,25 | 330–258 | -0,38 (4-4-2:counter) |
| 4-4-2:counter | 1551 | 1563 | 305 | 1,62 | 1,39 | 340–289 | -0,59 (3-5-2:direct) |
| 3-5-2:direct | 1533 | 1551 | 357 | 2,15 | 1,49 | 447–304 | -0,09 (3-4-3:wide) |
| 4-4-2:low_block | 1527 | 1534 | 252 | 1,01 | 1,06 | 201–218 | -0,37 (3-4-3:wide) |
| 4-3-3:balanced | 1472 | 1465 | 277 | 1,31 | 1,21 | 267–251 | -0,69 (3-5-2:direct) |
| 4-2-3-1:high_press | 1469 | 1485 | 224 | 1,31 | 1,85 | 262–345 | -1,12 (3-5-2:direct) |
| 4-3-3:possession | 1364 | 1346 | 142 | 0,88 | 1,66 | 158–340 | -1,33 (3-5-2:direct) |

#### Matrice ΔxG (ligne contre colonne)

|  | 4-3-3:balanced | 4-3-3:possession | 4-4-2:counter | 4-2-3-1:high_press | 4-4-2:low_block | 3-4-3:wide | 3-5-2:direct |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 4-3-3:balanced | — | +0,74 | -0,02 | +0,52 | +0,21 | -0,11 | -0,69 |
| 4-3-3:possession | -0,74 | — | -0,84 | +0,04 | -0,57 | -1,19 | -1,33 |
| 4-4-2:counter | +0,02 | +0,84 | — | +0,37 | +0,34 | +0,38 | -0,59 |
| 4-2-3-1:high_press | -0,52 | -0,04 | -0,37 | — | -0,40 | -0,81 | -1,12 |
| 4-4-2:low_block | -0,21 | +0,57 | -0,34 | +0,40 | — | -0,37 | -0,33 |
| 3-4-3:wide | +0,11 | +1,19 | -0,38 | +0,81 | +0,37 | — | +0,09 |
| 3-5-2:direct | +0,69 | +1,33 | +0,59 | +1,12 | +0,33 | -0,09 | — |

#### Indicateurs structurels par profil (moyenne ± demi-largeur de l’IC 95 %)

| Profil | Possession | Réussite passes | PPDA | Pertes / 10 min | Bloc x × y (m) | Ligne défensive (m) | Long. passe (m) | Appels | Chg. intention / s | Chg. cible / j·s |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 4-3-3:balanced | 52 % | 71 % | 2,7 | 33,5 | 47 × 45 | -19,9 ± 0,4 | 18,1 ± 0,2 | 42,3 | 0,50 | 0,379 |
| 4-3-3:possession | 56 % | 74 % | 2,6 | 32,9 | 46 × 45 | -19,3 ± 0,4 | 16,4 ± 0,2 | 24,5 | 0,57 | 0,365 |
| 4-4-2:counter | 45 % | 61 % | 3,0 | 40,8 | 46 × 39 | -24,9 ± 0,3 | 17,5 ± 0,1 | 87,5 | 0,44 | 0,450 |
| 4-2-3-1:high_press | 52 % | 69 % | 2,7 | 37,0 | 48 × 42 | -20,7 ± 0,4 | 16,8 ± 0,2 | 55,0 | 0,49 | 0,419 |
| 4-4-2:low_block | 48 % | 63 % | 2,8 | 42,4 | 44 × 38 | -26,3 ± 0,3 | 16,4 ± 0,1 | 71,5 | 0,49 | 0,443 |
| 3-4-3:wide | 52 % | 70 % | 2,9 | 32,0 | 48 × 54 | -21,1 ± 0,4 | 19,0 ± 0,2 | 59,5 | 0,50 | 0,372 |
| 3-5-2:direct | 46 % | 63 % | 2,9 | 40,5 | 48 × 44 | -24,3 ± 0,3 | 17,9 ± 0,2 | 99,5 | 0,43 | 0,451 |

#### Paires (ΔxG par graine, Wilcoxon, correction de Holm)

| Paire | ΔxG | IC 95 % (bootstrap) | p | p (Holm) | δ Cliff |
| :--- | ---: | ---: | ---: | ---: | ---: |
| 4-3-3:balanced vs 4-3-3:possession | +0,741 | [0,499 ; 1,006] | < 0,001 | 0,002 ** | 0,88 |
| 4-3-3:balanced vs 4-4-2:counter | -0,021 | [-0,534 ; 0,495] | 0,900 | 1,000 | 0,13 |
| 4-3-3:balanced vs 4-2-3-1:high_press | +0,522 | [0,077 ; 0,930] | 0,025 | 0,349 | 0,63 |
| 4-3-3:balanced vs 4-4-2:low_block | +0,205 | [-0,138 ; 0,538] | 0,298 | 1,000 | 0,13 |
| 4-3-3:balanced vs 3-4-3:wide | -0,114 | [-0,415 ; 0,186] | 0,669 | 1,000 | 0,13 |
| 4-3-3:balanced vs 3-5-2:direct | -0,691 | [-1,130 ; -0,197] | 0,025 | 0,349 | -0,63 |
| 4-3-3:possession vs 4-4-2:counter | -0,838 | [-1,291 ; -0,405] | 0,003 | 0,054 | -0,63 |
| 4-3-3:possession vs 4-2-3-1:high_press | +0,041 | [-0,394 ; 0,437] | 0,632 | 1,000 | 0,00 |
| 4-3-3:possession vs 4-4-2:low_block | -0,572 | [-0,815 ; -0,343] | < 0,001 | 0,008 ** | -0,75 |
| 4-3-3:possession vs 3-4-3:wide | -1,192 | [-1,476 ; -0,924] | < 0,001 | < 0,001 *** | -1,00 |
| 4-3-3:possession vs 3-5-2:direct | -1,330 | [-1,751 ; -0,926] | < 0,001 | 0,001 ** | -0,88 |
| 4-4-2:counter vs 4-2-3-1:high_press | +0,366 | [-0,223 ; 0,948] | 0,252 | 1,000 | 0,13 |
| 4-4-2:counter vs 4-4-2:low_block | +0,342 | [0,023 ; 0,690] | 0,144 | 1,000 | 0,38 |
| 4-4-2:counter vs 3-4-3:wide | +0,375 | [-0,019 ; 0,789] | 0,144 | 1,000 | 0,13 |
| 4-4-2:counter vs 3-5-2:direct | -0,586 | [-1,034 ; -0,111] | 0,034 | 0,402 | -0,38 |
| 4-2-3-1:high_press vs 4-4-2:low_block | -0,398 | [-0,866 ; 0,054] | 0,159 | 1,000 | -0,13 |
| 4-2-3-1:high_press vs 3-4-3:wide | -0,812 | [-1,153 ; -0,473] | < 0,001 | 0,013 * | -0,75 |
| 4-2-3-1:high_press vs 3-5-2:direct | -1,119 | [-1,814 ; -0,481] | 0,009 | 0,138 | -0,38 |
| 4-4-2:low_block vs 3-4-3:wide | -0,365 | [-0,713 ; -0,018] | 0,065 | 0,719 | -0,50 |
| 4-4-2:low_block vs 3-5-2:direct | -0,333 | [-0,762 ; 0,066] | 0,105 | 1,000 | -0,13 |
| 3-4-3:wide vs 3-5-2:direct | +0,086 | [-0,400 ; 0,612] | 0,860 | 1,000 | 0,13 |

## 3. Ablations de paramètres

Chaque variante joue contre le réglage par défaut (même algorithme), graines appariées, côtés échangés. Δ = variante − défaut.

| Ablation | Isole | ΔxG | IC 95 % (bootstrap) | p (Wilcoxon) | δ Cliff | Δ regret | Δ chg. intention / s |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| γ = 0 (sans anticipation, B2) | l’anticipation à deux coups | +0,107 | [-1,068 ; 1,262] | 0,940 | -0,02 | 0,0000 | -0,030 |
| λ_risk = 0 (B4) | le terme de risque | -0,289 | [-1,159 ; 0,601] | 0,528 | -0,19 | +0,0000 | -0,050 |
| sans hystérésis (B8) | la stabilité des intentions | +0,758 | [0,058 ; 1,453] | 0,074 | 0,53 | +0,0000 | +0,014 |
| K = 3 | la largeur de la recherche | -0,346 | [-0,953 ; 0,256] | 0,323 | -0,30 | +0,0000 | +0,005 |
| K = 8 | la largeur de la recherche | +0,527 | [0,082 ; 0,989] | 0,068 | 0,53 | 0,0000 | -0,007 |
| β = 0,3 (≈ Voronoï, B5) | le contrôle par temps d’arrivée | +0,475 | [-0,234 ; 1,158] | 0,274 | 0,32 | +0,0000 | +0,080 |
| β = 3 | le contrôle par temps d’arrivée | -0,492 | [-1,303 ; 0,350] | 0,193 | -0,38 | 0,0000 | -0,027 |
| η = 0,2 | le modèle d’interception | -0,416 | [-1,323 ; 0,465] | 0,433 | -0,23 | 0,0000 | -0,037 |
| η = 0,6 | le modèle d’interception | +0,023 | [-0,481 ; 0,490] | 0,821 | 0,07 | +0,0000 | -0,003 |
| τ_r = 0,2 s | le temps de réaction | -0,556 | [-1,061 ; -0,058] | 0,074 | -0,52 | +0,0000 | -0,003 |
| τ_r = 0,5 s | le temps de réaction | +0,929 | [0,215 ; 1,665] | 0,025 * | 0,65 | 0,0000 | -0,011 |

## Limites

Les buts sont rares (≈ 2,5 par 10 min simulées) : les conclusions reposent sur ΔxG et la menace créée ; la différence de buts est indicative. Les p-values des familles de comparaisons sont corrigées par Holm.
