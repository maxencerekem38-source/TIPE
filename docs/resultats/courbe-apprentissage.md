## Courbe d’apprentissage (CEM)

Optimiseur cem, 12 générations × 16 candidats (4 élites), 4 matchs de 3 min par évaluation (graines communes par génération), git bb124d9, graine 2024, durée 50 min 37 s.

| Génération | Fitness moyenne | IC 95 % | Meilleure fitness | σ moyen | Évaluations | Durée |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | -2,7038 | [-3,8125 ; -1,5950] | 0,2434 | 0,552 | 16 | 262,0 s |
| 2 | -1,0733 | [-1,7797 ; -0,3669] | 0,5160 | 0,373 | 32 | 248,3 s |
| 3 | -0,4352 | [-0,8347 ; -0,0357] | 0,5967 | 0,299 | 48 | 255,7 s |
| 4 | -0,3221 | [-0,7397 ; 0,0955] | 0,6183 | 0,295 | 64 | 259,6 s |
| 5 | -0,6410 | [-1,2112 ; -0,0707] | 0,3892 | 0,302 | 80 | 255,7 s |
| 6 | -0,3770 | [-0,8344 ; 0,0803] | 0,5893 | 0,279 | 96 | 243,9 s |
| 7 | -0,3452 | [-0,7689 ; 0,0785] | 0,8301 | 0,316 | 112 | 259,3 s |
| 8 | -0,5362 | [-1,0496 ; -0,0229] | 0,6991 | 0,287 | 128 | 259,8 s |
| 9 | -0,1560 | [-0,4970 ; 0,1849] | 0,7195 | 0,225 | 144 | 266,3 s |
| 10 | -0,9027 | [-1,3995 ; -0,4060] | 0,1293 | 0,182 | 160 | 232,4 s |
| 11 | -0,3339 | [-0,7185 ; 0,0506] | 0,4807 | 0,111 | 176 | 254,1 s |
| 12 | -0,1663 | [-0,7362 ; 0,4035] | 1,1752 | 0,128 | 192 | 240,0 s |

### Paramètres

| Paramètre | Défaut | Optimisé | Rapport |
| :--- | ---: | ---: | ---: |
| decision.wProgress | 0,1500 | 0,3868 | 2,58 |
| decision.wSupport | 0,0200 | 0,0064 | 0,32 |
| decision.wLineBreaks | 0,0200 | 0,0272 | 1,36 |
| decision.wTime | 0,0050 | 0,0004 | 0,07 |
| decision.lambdaRisk | 1,0000 | 1,3344 | 1,33 |
| decision.gamma | 0,5000 | 0,4837 | 0,97 |
| decision.hysteresis | 0,0020 | 0,0000 | 0,00 |
| offBall.wReceivable | 1,0000 | 0,8900 | 0,89 |
| offBall.wSpace | 0,3000 | 0,2698 | 0,90 |
| offBall.wTeamExposure | 0,3000 | 10,9319 | 36,44 |
| offBall.wSlot | 0,2000 | 0,2352 | 1,18 |
| offBall.wSeparation | 0,4000 | 0,1639 | 0,41 |
| offBall.wRun | 0,4000 | 0,3637 | 0,91 |
| defence.muPriority | 6,0000 | 19,2108 | 3,20 |
| defence.nuShape | 8,0000 | 8,4189 | 1,05 |
| defence.xiHysteresis | 0,4000 | 0,3503 | 0,88 |
| models.interceptEfficiency | 0,3500 | 0,5314 | 1,52 |
| models.arrivalSigma | 0,4000 | 0,5405 | 1,35 |
| models.controlBeta | 1,0000 | 1,3896 | 1,39 |
