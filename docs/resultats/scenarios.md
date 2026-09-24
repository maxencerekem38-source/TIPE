# Banc de scénarios

Généré le 24/09/2026 08:37:06 (git e9629ef). Chaque scénario est joué 6 s sur 16 graines ; on juge la première décision du porteur (accord top-1 avec l’ensemble acceptable), son regret (meilleur score − score choisi) et le KPI du scénario.

## Politique « full »

Politique **full** : 416 exécutions, accord top-1 = **70,2 %**, regret moyen = 0,0001 ; KPI moyens : xG 0,101, menace 0,017, possession conservée 79 %.

| Scénario | Catégorie | Actions acceptables | Acceptable | Regret | KPI | Actions les plus fréquentes |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| Contre-attaque 3 contre 2 | Transitions | passe → 8, passe → 10, passe en profondeur (avant), dribble (avant) | 100 % | 0,0005 | xg = 0,045 | passe → 8 (9), passe → 10 (7) |
| Construction sous pressing haut | Construction et relance | passe → 1, passe → 0, dégagement | 0 % | 0,0000 | possession = 0,813 | passe → 9 (16) |
| Surnombre sur l’aile † | Jeu sur les ailes | passe → 8, passe → 1, passe en profondeur (avant) | 100 % | 0,0003 | threat = 0,032 | passe → 8 (9), passe → 1 (5) |
| Bloc bas contre possession | Conservation et progression | passe, dribble, conservation | 100 % | 0,0000 | threat = -0,008 | dribble (4 m) (16) |
| Un contre un face au gardien | Finition | tir, dribble (avant) | 100 % | 0,0000 | xg = 0,257 | dribble (4 m) (16) |
| Piège du hors-jeu † | Percussion et profondeur | passe → 8, passe → 10, passe → 5, passe → 6, dribble, conservation | 100 % | 0,0004 | possession = 0,750 | dribble (4 m) (14), conservation (1) |
| Déclencheur de pressing | Pressing et contre-pressing | passe → 11, passe → 12, dégagement | 0 % | 0,0000 | possession = 1,000 | profondeur → 20 (16) |
| Renversement de jeu | Jeu sur les ailes | passe → 8, passe → 1, passe en profondeur → 8 | 0 % | 0,0000 | threat = 0,015 | passe → 10 (16) |
| Impasse sans solution de passe † | Conservation et progression | dribble, conservation, dégagement | 69 % | 0,0002 | possession = 0,563 | dribble (4 m) (11), profondeur → 9 (5) |
| Tir ou remise en retrait | Finition | passe → 9, tir | 100 % | 0,0000 | xg = 0,175 | passe → 9 (16) |
| Relance du gardien | Construction et relance | passe → 1, passe → 4, passe → 2, passe → 3, dégagement | 100 % | 0,0000 | possession = 0,625 | passe → 3 (10), passe → 2 (6) |
| Passe en profondeur contre une ligne haute † | Percussion et profondeur | passe en profondeur, passe → 9 | 100 % | 0,0000 | xg = 0,000 | passe → 9 (16) |
| Surface encombrée (situation de corner) | Finition | passe, conservation | 100 % | 0,0000 | xg = 0,025 | conservation (16) |
| Contre-pressing après une perte | Pressing et contre-pressing | passe → 20, passe en profondeur → 20, passe → 21, dégagement | 100 % | 0,0000 | possession = 0,938 | passe → 20 (16) |
| Dédoublement côté droit (2 contre 1) † | Jeu sur les ailes | passe → 4, passe en profondeur → 4, dribble | 100 % | 0,0000 | threat = 0,044 | passe → 4 (16) |
| Deux contre un à l’entrée de la surface | Finition | passe → 8, passe en profondeur → 8, dribble (avant) | 100 % | 0,0000 | xg = 0,127 | profondeur → 8 (16) |
| Dribble face à un défenseur isolé | Percussion et profondeur | dribble (avant) | 6 % | 0,0001 | threat = 0,000 | conservation (15), dribble (4 m) (1) |
| Passe en retrait sous pression † | Construction et relance | passe → 3, passe → 0, dégagement | 0 % | 0,0006 | possession = 1,000 | passe → 10 (9), profondeur → 10 (7) |
| Renversement long depuis la défense | Jeu sur les ailes | passe → 10, passe → 4, passe en profondeur → 10 | 50 % | 0,0005 | threat = 0,012 | passe → 4 (8), profondeur → 9 (7) |
| Attaquant entre les lignes | Percussion et profondeur | passe → 9, passe en profondeur | 100 % | 0,0000 | threat = 0,017 | passe → 9 (16) |
| Transition défensive 5 contre 3 † | Transitions | passe (avant), passe en profondeur, dribble, conservation | 100 % | 0,0000 | threat = 0,006 | dribble (4 m) (12), passe → 20 (4) |
| Centre ou conservation | Jeu sur les ailes | passe → 6, passe → 5 | 0 % | 0,0000 | possession = 0,813 | dribble (4 m) (16) |
| Frappe lointaine ou passe | Finition | passe → 8, passe en profondeur → 8, dribble (avant) | 0 % | 0,0000 | xg = 0,179 | passe → 9 (16) |
| Gardien sous pression : dégagement † | Construction et relance | dégagement, passe → 1, passe → 4, passe → 3 | 100 % | 0,0000 | possession = 0,625 | passe → 3 (16) |
| Débordement et centre | Jeu sur les ailes | passe → 9, passe → 10, passe → 1, dribble | 100 % | 0,0000 | xg = 0,000 | passe → 1 (16) |
| Progression au milieu | Conservation et progression | passe → 7, dribble (avant) | 100 % | 0,0000 | threat = 0,032 | passe → 7 (16) |

† scénario réservé (jamais utilisé pour l’optimisation).
