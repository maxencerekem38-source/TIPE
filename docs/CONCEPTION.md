# Spécification de conception — Moteur de décision et de simulation football (TIPE)

**Statut** : spécification finale (version 1.0), issue de la fusion de la proposition « physique d'abord » (retenue) et des greffes des propositions « recherche / théorie des jeux » et « apprentissage ».
**Public** : ingénieurs implémentant les modules en parallèle ; jury TIPE.
**Contraintes techniques fixées** : TypeScript, Vite, Canvas 2D, vitest, Node 22, moteur *headless* (fonctions pures, aucun accès au DOM), RNG à graine, pas de backend.

Convention de lecture : chaque formule est donnée avec ses paramètres et leurs valeurs par défaut ; ces valeurs sont regroupées dans un objet `Params` unique (§13) pour que l'optimisation hors-ligne (§10) et les ablations (§11) puissent les modifier sans toucher au code.

---

## 1. Problème et hypothèses

**Problème.** À partir d'une situation de jeu quelconque (22 joueurs + ballon), calculer pour chaque joueur la meilleure action, en attaque (porteur et non-porteurs) comme en défense, animer une simulation 11 contre 11 en temps réel où chaque décision provient de l'algorithme, et **expliquer** chaque décision : candidats, scores, probabilités, contributions nommées.

**Hypothèses de modélisation.**

- Terrain : $L = 105$ m × $W = 68$ m. Repère orthonormé centré : $x \in [-52{,}5 ; 52{,}5]$, $y \in [-34 ; 34]$. L'équipe A attaque vers $+x$ (but visé $G_A = (52{,}5 ; 0)$), l'équipe B vers $-x$. Poteaux à $y = \pm 3{,}66$ m ; surface de réparation : $|x| > 36$ m, $|y| < 20{,}16$ m ; surface de but : $|x| > 47$ m, $|y| < 9{,}16$ m.
- **Miroir** : toutes les fonctions de décision sont écrites pour une équipe attaquant vers $+x$. Pour l'équipe B, l'état est transformé par $(x, y) \mapsto (-x, -y)$ (positions et vitesses) avant décision et les cibles sont re-transformées après. Une seule implémentation, testée par symétrie.
- Temps : pas physique fixe $dt = 1/30$ s. Cycle de décision $T_{dec} = 0{,}2$ s (6 ticks) ; les champs spatiaux (§4) sont calculés une fois par cycle et partagés par les 22 décisions. Les joueurs sont décidés en décalé (11 joueurs tous les 0,1 s) pour lisser le coût.
- Jeu 2D : le ballon roule au sol (les ballons aériens sont hors périmètre de la tranche minimale, voir §13.6). Pas de fautes, pas de cartons, pas de fatigue dans la version 1.
- Tout est déterministe à graine fixée : le RNG (`mulberry32`) est injecté, aucune allocation d'objet dans la boucle chaude, `Math.random` interdit dans `src/engine`.
- Le moteur est une fonction pure $(\mathcal S_t, \text{tactiques}, \text{params}, \text{rng}) \mapsto (\mathcal S_{t+dt}, \text{décisions}, \text{explications})$. Le navigateur et le harnais d'expériences Node exécutent exactement le même code.

---

## 2. Notations et variables

| Symbole | Signification | Unité | Défaut |
|---|---|---|---|
| $L, W$ | longueur, largeur du terrain | m | 105, 68 |
| $G$ | centre du but adverse (dans le repère miroir : $(52{,}5;0)$) | m | — |
| $p_i, v_i$ | position, vitesse du joueur $i \in \{1..22\}$ | m, m/s | — |
| $b, v_b$ | position, vitesse du ballon | m, m/s | — |
| $h$ | porteur du ballon (ou $\varnothing$) | — | — |
| $v_{max}$ | vitesse maximale d'un joueur | m/s | 8,0 |
| $a_{max}$ | accélération maximale | m/s² | 5,0 |
| $\tau_r$ | temps de réaction (modèle de décision) | s | 0,3 |
| $v_{drib}$ | vitesse balle au pied | m/s | $0{,}75\, v_{max}$ |
| $\sigma_T$ | incertitude sur les temps d'arrivée | s | 0,4 |
| $\mu_b$ | décélération du ballon (frottement de roulement) | m/s² | 1,5 |
| $s_{arr}$ | vitesse d'arrivée souhaitée d'une passe | m/s | {4, 6, 9, 10} (`decision.passArrivalSpeeds`, §5.1, §15.2) |
| $s_{shot}$ | vitesse d'un tir | m/s | 25 |
| $r_{ctl}$ | rayon de prise de balle | m | 1,0 |
| $r_{tackle}$ | rayon de duel | m | 1,2 |
| $\Delta$ | pas de la grille spatiale $\Gamma$ (53 × 34 = 1802 cellules) | m | 2 |
| $\beta$ | température du softmin de contrôle | s | 1,0 |
| $\kappa, \rho_x, \rho_y$ | paramètres du substitut analytique de $xT$ | —, m, m | 0,22 ; 25 ; 22 |
| $r_p, \alpha_p, \alpha_v$ | rayon, facteur directionnel, facteur de fermeture de la pression | m, —, — | 3,5 ; 0,5 ; 0,5 |
| $M$ | nombre de points d'échantillonnage d'une trajectoire | — | 12 |
| $\eta$ | efficacité de capture par échantillon | — | 0,35 (calibré §11.6) |
| $\lambda_{risk}$ | aversion au risque (tactique) | — | 1,0 |
| $w_{prog}, w_{sup}, w_{lb}$ | poids progression, soutien, lignes franchies | but | 0,15 ; 0,02 ; 0,02 |
| $w_{time}, w_{off}$ | coût temporel, coût risque hors-jeu | but/s, but | 0,005 ; 0,02 |
| $w_{len}, d_{sup}$ | pénalité de longueur de passe (× (1 − directness)), longueur libre = distance de soutien du style | but, m | 0,1 ; 11–18 |
| $xG_{min}, w_{poss}$ | plancher de xG d'un tir candidat (× (1,5 − shotEagerness)), part de la possession Θ(b) perdue par un tir manqué | —, — | 0,04 ; 0,25 |
| $\gamma$ | poids de la suite (profondeur 2) | — | 0,5 |
| $K$ | nombre de candidats développés en profondeur 2 | — | 5 |
| $\mathcal R$ | ensemble de réponses défensives | — | 4 réponses |
| $h$ | hystérésis porteur (30ᵉ percentile des écarts $Q(a_1) - Q(a_2)$ mesurés en match : 0,0018–0,0025) | but | 0,002 |
| $\varepsilon$ | seuil d'égalité | but | 0,005 |
| $\varepsilon_{game}$ | seuil de déclenchement du jeu 2×2 | but | 0,02 |
| $w_1..w_6$ | poids de l'utilité hors-ballon | — | 1 ; 0,3 ; 0,3 ; 0,2 ; 0,4 ; 0,5 |
| $r_{slot}, r_{sep}$ | rayons de rappel au poste, de séparation | m | 12 ; 8 |
| $h_{off}$ | hystérésis hors-ballon | — | 0,15 |
| $\mu_{prio}, \nu_{shape}, \xi$ | poids priorité, forme, hystérésis (coûts défensifs) | s | 6 ; 8 ; 0,4 |
| $\Delta C_{min}$ | amélioration minimale pour réaffecter | s | 0,5 |
| $t^\star$ | horizon de supériorité numérique locale | s | 2,5 |
| $\Lambda$ | compacité cible (étendue en $x$ du bloc) | m | 30 |

Toutes les valeurs (« score », « Q », « EV ») sont exprimées en **buts espérés** ; c'est l'unité commune qui rend comparables passe, dribble, tir et conservation, et qui donne un sens physique à $h$, $\varepsilon$ et $\lambda_{risk}$.

---

## 3. Modèle physique de simulation

### 3.1 Cinématique des joueurs

Chaque joueur reçoit de la couche décision une **intention** : un point cible $q_i$ et une vitesse de consigne $v^{des}_i = v^{cap}_i \cdot \min\!\big(1, \|q_i - p_i\|/d_{slow}\big)\, \widehat{(q_i - p_i)}$ avec $d_{slow} = 2$ m (freinage à l'approche) et $v^{cap}_i = v_{max}$ (ou $v_{drib}$ pour le porteur). Intégration à chaque tick :
$$v_i \leftarrow v_i + \operatorname{clamp}\big(v^{des}_i - v_i,\ a_{max}\, dt\big),\qquad \|v_i\| \le v^{cap}_i,\qquad p_i \leftarrow p_i + v_i\, dt.$$
Le temps de réaction n'est pas simulé explicitement : le cycle de décision de 0,2 s joue ce rôle ; le modèle de décision utilise $\tau_r = 0{,}3$ s pour représenter cette latence plus une marge. Validation : sprint de 40 m départ arrêté $= \tau_r + v_{max}/a_{max} + (40 - v_{max}^2/2a_{max})/v_{max} \approx 0{,}3 + 1{,}6 + 4{,}2 = 6{,}1$ s (footballeur moyen : 5,5–6,2 s).

### 3.2 Ballon

Roulement : $\dot v_b = -\mu_b\, \hat v_b$, arrêt quand $\|v_b\| < 0{,}1$ m/s. Distance parcourue à vitesse initiale $s_0$ : $d(t) = s_0 t - \tfrac12 \mu_b t^2$, arrêt à $t_{stop} = s_0/\mu_b$, portée $s_0^2/2\mu_b$.

**Passe** vers un point à distance $d$ avec vitesse d'arrivée $s_{arr}$ :
$$s_0 = \min\!\Big(s_0^{max},\ \sqrt{2\mu_b d + s_{arr}^2}\Big),\qquad T_b(d) = \frac{s_0 - \sqrt{s_0^2 - 2\mu_b d}}{\mu_b},\qquad s_0^{max} = 25\ \text{m/s}.$$
Exemple : $d = 20$ m, $s_{arr} = 6$ ⇒ $s_0 = 9{,}8$ m/s, $T_b = 2{,}5$ s. Bruit d'exécution tiré au RNG : direction $\mathcal N(0, (3° + 2°\,\Pi(b))^2)$, vitesse $\mathcal N(0, (5\%)^2)$.

**Ballon aérien** (lob, dégagement) : tir balistique à 45°, $v_0 = \min(s_0^{max}, \sqrt{g d})$, vitesse horizontale $h_s = v_0/\sqrt 2$ constante, durée $T = d/h_s$, $v_z = gT/2$, apogée $gT^2/8 = d/4$. Une seule fonction (`lobFlight`, `src/models/motion.ts`) sert au moteur et à la décision, de sorte que les temps balle des interceptions et la durée d'action sont ceux du ballon réellement simulé.

**Tir** : vitesse $s_{shot} = 25$ m/s vers un point de visée $y_{aim} \in \{-2{,}9 ; 0 ; 2{,}9\}$, bruit direction $\mathcal N(0, (4° + 3°\,\Pi(b))^2)$, $T_{flight} = d_G / s_{shot}$ (pas de décélération sur la durée d'un tir).

**Dribble** : le ballon est maintenu à $p_h + 0{,}6\,\hat v_h$ ; **conservation** : ballon maintenu à $p_h + 0{,}5\, \hat u_{dos}$ où $\hat u_{dos}$ est la direction opposée à l'adversaire le plus proche.

### 3.3 Résolution des issues (cohérence décision / physique)

Principe : **la physique tranche, les probabilités ne servent qu'à décider** (et sont ensuite vérifiées par calibration, §11.6). Cela évite les interceptions « fantômes ».

- **Prise de balle** : tout joueur à moins de $r_{ctl}$ du ballon avec $\|v_b - v_i\| < 12$ m/s prend le contrôle ; si plusieurs, le premier arrivé (le tick où la condition est vraie) ; en cas d'égalité au même tick, tirage avec $P = \sigma(1{,}5\,[\text{en mouvement vers le ballon}])$.
- **Interception de passe** : les défenseurs affectés à une tâche `intercept` (§8) courent vers le point de poursuite ; s'ils entrent dans $r_{ctl}$ avant le receveur, ils prennent la balle. Aucun tirage.
- **Duel** (dribble ou conservation) : un défenseur dans $r_{tackle}$ du porteur engage un duel s'il **l'attaque** — vitesse de rapprochement $> 0{,}8$ m/s (le porteur qui fonce sur lui compte aussi : prise à défaut) ou contact continu $> 0{,}8$ s — au plus une fois par $1{,}5$ s pour ce défenseur *et* pour ce porteur, jamais dans les $0{,}4$ s suivant une prise de balle (un défenseur qui contient à distance ne déclenche rien) : $P_{win}^{def} = \mathrm{clip}\big(\sigma(-1{,}1 + 1{,}0\,[\text{défenseur de face}] + 0{,}6\,\Pi_{-}(b) + 1{,}2\,(\text{defending} - \text{dribbling})),\ 0{,}15,\ 0{,}6\big)$, où $\Pi_{-}$ est la pression des *autres* adversaires (le tacleur n'est pas compté deux fois) ; en cas de victoire du défenseur le ballon lui est attribué (p = 0,5) ou devient libre à 1,5 m, sinon le défenseur est « passé » (pénalité de $1$ s d'immobilité) et la prise à défaut est comptée réussie. Paramètres `physics.duel*`, `beatenFreeze`, `tackleKeepProb` (src/core/params.ts).
- **Tir** : le gardien se déplace selon sa politique (§8.6) ; l'issue est tirée avec la probabilité $xG$ (§5.4) au moment de la frappe ; l'animation est rendue cohérente en visant le point de visée le plus éloigné du gardien en cas de but et un point dans son rayon d'action en cas d'arrêt.

### 3.4 Sorties, buts, remises en jeu (règles simplifiées)

| Événement | Condition | Remise en jeu |
|---|---|---|
| But | $|x_b| > 52{,}5$ et $|y_b| < 3{,}66$ | Engagement au centre par l'équipe encaissante, gel $t_{restart} = 2$ s |
| Sortie de but / corner | $|x_b| > 52{,}5$, $|y_b| \ge 3{,}66$ | Dernier toucheur attaquant ⇒ six mètres (GK, ballon en $(\pm 47, \pm 9)$) ; défenseur ⇒ corner (ballon au coin, un attaquant) |
| Touche | $|y_b| > 34$ | Ballon rendu au joueur de champ le plus proche de l'équipe n'ayant pas touché en dernier, au point de sortie (le gardien ne remet jamais une touche ni un corner) |
| Hors-jeu | Au lancement d'une passe, receveur avec $x_r > \max(x_b, x^{(2)}_{def})$ et $x_r > 0$, puis réception | Coup franc indirect : ballon au défenseur le plus proche du point du hors-jeu |

À chaque remise : gel de $t_{restart} = 1$ s (2 s pour un but), adversaires repoussés à $\ge 3$ m, puis la remise est une décision de passe ordinaire du remetteur (candidats restreints aux passes).

---

## 4. Modèles spatiaux

Tous les champs sont des `Float32Array(1802)` réutilisés (pas d'allocation), interpolés bilinéairement par `sampleField(f, q)`.

### 4.1 Temps d'arrivée $T_i(q)$ (modèle de mouvement)

Après le temps de réaction, le joueur part de $p'_i = p_i + \tau_r v_i$ en ligne droite, accélération constante jusqu'à $v_{max}$ :
$$d = \|q - p'_i\|,\quad t_{acc} = \frac{v_{max}}{a_{max}},\quad d_{acc} = \frac{v_{max}^2}{2 a_{max}},\qquad T_i(q) = \tau_r + \begin{cases}\sqrt{2d/a_{max}} & d \le d_{acc}\\ t_{acc} + (d - d_{acc})/v_{max} & \text{sinon.}\end{cases}$$
(Fernández & Bornn 2018.) La branche $\sqrt{2d/a_{max}}$ est indispensable : elle rend compte des courses courtes (pressing, dribble, interception) ; test unitaire : $T_i$ croissante en $d$, continue en $d_{acc}$, $T_i(p'_i) = \tau_r$.

### 4.2 Contrôle du terrain $PC$

Softmin des temps d'arrivée (forme fermée de Spearman simplifiée) :
$$PC_A(q) = \frac{\sum_{i \in A} e^{-T_i(q)/\beta}}{\sum_{i \in A \cup B} e^{-T_i(q)/\beta}},\qquad \beta = 1{,}0\ \text{s}.$$
Justification : prend en compte la **densité** de joueurs (contrairement à une logistique sur les deux minima) ; limite $\beta \to 0$ = diagramme de Voronoï des temps (dominant regions, Taki & Hasegawa), testée unitairement. Le gardien participe uniquement dans sa surface. Coût : $1802 \times 22$ évaluations.

### 4.3 Menace $xT$, danger $D$, exposition $E$

**Substitut analytique de $xT$** (expected threat, Singh 2019), calibré sur les cartes publiées :
$$xG_{loc}(q) = \sigma\big(-1{,}96 + 3{,}0\,\omega(q) - 0{,}08\, d_G(q)\big),\qquad xT(q) = xG_{loc}(q) + \big(1 - xG_{loc}(q)\big)\,\kappa\, e^{-d_G(q)/\rho_x}\, e^{-y^2/2\rho_y^2},$$
où $\omega(q)$ est l'angle sous lequel on voit les poteaux depuis $q$ (rad), $d_G = \|q - G\|$, $\kappa = 0{,}22$, $\rho_x = 25$ m, $\rho_y = 22$ m. ($-1{,}96 = -1{,}1 - 1{,}5 \times 0{,}57$ : $xG$ de §5.4 avec un gardien nominal.) Valeurs de contrôle (tests) : propre surface $\approx 0{,}005$ ; rond central $\approx 0{,}034$ ; entrée de surface axiale $\approx 0{,}22$. Une variante par itération de valeur ($xT \leftarrow \sum_a P(a)[s\, xG + (1-s)\sum_{q'} T(q'|q,a)\, xT(q')]$, 5 itérations, noyau $T$ gaussien $\sigma_m = 10$ m biaisé $+x$) est disponible hors-ligne comme ablation ; **elle n'est jamais réestimée à partir de l'auto-jeu** (cela ferait de $xT$ un point fixe du moteur, non un modèle de menace).

Menace vue par l'adversaire : $xT^{def}(q) = xT(\text{miroir}(q))$.

**Danger** $D(q) = xT(q)\cdot PC_{att}(q)$ (valeur de l'espace effectivement contrôlé). **Exposition** de la défense : $E = \sum_{q \in \Gamma} D(q)\, \Delta^2 / (L W)$. **Menace dynamique d'un point** : $\Theta(q) = xT(q)\, PC_{att}(q)$ — c'est la quantité de base de toutes les évaluations.

### 4.4 Pression $\Pi(q)$

$$\Pi(q) = \sum_{j \in def} \exp\!\Big(-\frac{\|p_j - q\|^2}{2 r_p^2}\Big)\big(1 + \alpha_p \cos\theta_j\big)\big(1 + \alpha_v\, \max(0, c_j)\big),$$
$\theta_j$ = angle entre $q - p_j$ et $\hat x$ (un défenseur côté but pèse plus), $c_j = (v_j \cdot \widehat{(q - p_j)})/v_{max}$ = vitesse de fermeture normalisée (un défenseur qui arrive pèse plus). $r_p = 3{,}5$ m, $\alpha_p = \alpha_v = 0{,}5$. $\Pi \in [0, \sim 4]$ ; $\Pi(b)$ entre dans toutes les probabilités du porteur. Calculé sur la grille et ponctuellement.

### 4.5 Espace disponible

$\text{space}_i = \#\{q \in \Gamma : \|q - p_i\| < R_s,\ \arg\min_j T_j(q) = i\}\cdot \Delta^2$ (m²), $R_s = 8$ m ; lu sur la grille des argmin (gratuit après §4.2). Sert aux explications (« 45 m² libres ») et à l'utilité hors-ballon.

### 4.6 Lignes de passe et interception

Pour une trajectoire $b \to q$ à vitesse initiale $s_0$, on échantillonne $M = 12$ points $q_m$ aux temps balle $T_b(q_m)$. Pour chaque défenseur $j$ : $\varphi_{j,m} = \operatorname{logit}^{-1}\!\big((T_b(q_m) - T_j(q_m))/\sigma_T\big)$ avec $\operatorname{logit}^{-1}(z) = 1/(1+e^{-\pi z/\sqrt 3})$, où $T_j(q_m)$ est le temps pour être **à portée de prise de balle** de $q_m$ : cinématique §4.1 avec la distance à courir réduite de $r_{ctl}$ (§3.3 : le moteur donne le ballon à tout joueur à moins de $r_{ctl} = 1$ m ; un défenseur à 0,8 m de la ligne n'a pas à courir, $\varphi \approx 1$).

- **Probabilité d'interception (une chance par défenseur)** : $\Phi_j = \max_m \varphi_{j,m}$ (son meilleur point de la ligne ; variante $w > 0$ : $\Phi_j = 1 - \prod_{|m - m^\star| \le w}(1 - \varphi_{j,m})$, `models.interceptWindow`), puis
$$P_{int} = 1 - \prod_{j}\big(1 - \eta\, \Phi_j\big),\qquad \eta = 0{,}35,\ \sigma_T = 0{,}4\ \text{s},\ w = 0.$$
Justification : un défenseur ne dispose que d'**une** tentative sur la trajectoire (le moteur n'affecte d'ailleurs qu'un intercepteur par équipe, §8.1) ; l'ancienne agrégation $\prod_m \prod_j$ traitait les 12 échantillons d'un même défenseur comme des chances indépendantes, de sorte qu'un défenseur courant à côté d'une passe lente ($\varphi \approx 1$ partout) valait $1 - 0{,}65^{12} = 0{,}994$, et qu'une passe en retrait de 41 m sans adversaire à 25 m était tarifée $P_{int} \approx 1$. Les défenseurs restent des chances indépendantes entre eux. $\eta$, $\sigma_T$ et $w$ sont **calibrés sur les issues du moteur** (§11.6 : grille minimisant le Brier de $P_{pass}$ sur les passes jouées, rapport `results/calibration.md`, valeurs retenues et écarts en §15.2). Pour un ballon aérien, la chance effective d'un défenseur est $\max_m \eta_m \varphi_{j,m}$ avec $\eta_m \in \{\eta, \eta_{land}\}$.
- **Ballon aérien** : un échantillon n'est interceptable que si la hauteur $z(f) = 4\,\text{apex}\,f(1-f)$ est inférieure à la hauteur de contrôle du moteur (1,6 m) ; l'atterrissage ($f = 1$) est une chance supplémentaire de disputer le ballon retombé, d'efficacité $\eta_{land} = 0{,}6$ et avec une fenêtre $t_{land} = 0{,}3$ s ($\Phi_{land} = \operatorname{logit}^{-1}((T + t_{land} - T_j)/\sigma_T)$). Pour une trajectoire déjà en cours, les temps balle sont mesurés depuis l'instant courant ($T_b(q_m) - t_{écoulé}$) et les points dépassés ne sont plus interceptables.
- **Point faible de la ligne** : $W = \max_{j,m} \varphi_{j,m} = \max_j \Phi_j$, avec le défenseur et le point qui le réalisent. Propriété conservée : $P_{int}^{(\eta = 1)} = 1 - \prod_j (1 - \Phi_j) \ge \max_j \Phi_j = W$ (borne inférieure documentée) ; pour un seul défenseur menaçant, $P_{int} = \eta\,\Phi_j \le \eta$. $W$ est la **feature d'explication** (« l'adversaire 7 arrive 0,3 s avant le ballon au point 6 ») et la quantité d'élagage ; les $\Phi_j$ sont exposés (`defenderIds`, `defenderPhi`) pour la visualisation et la calibration.
- **Marge angulaire** $\beta_{lane} = \min_j \angle\big(q - b,\ p_j - b\big)$ sur les défenseurs avec $\|p_j - b\| < \|q - b\|$ (degrés).
- **Élagage géométrique** : distance perpendiculaire minimale d'un défenseur au segment $[b, q]$ ; un candidat avec distance $< 1$ m et $W > 0{,}8$ n'est pas évalué.
- **Lignes franchies** $n_{lb}$ : les défenseurs de champ sont triés par $x$ ; une « ligne » est un groupe séparé du suivant par un écart $> 6$ m (pas de k-means : stable et $O(n \log n)$) ; $n_{lb}$ = nombre de lignes dont l'abscisse moyenne est strictement entre $x_b$ et $x_q$.

Coût : $12 \times 11 = 132$ évaluations de $T$ par candidat.

### 4.7 Compacité, lignes, supériorité numérique

- Supériorité locale : $N^+(q) = \#\{i \in att : T_i(q) < t^\star\} - \#\{j \in def : T_j(q) < t^\star\}$, $t^\star = 2{,}5$ s ; version lisse $\text{sup}(q) = \operatorname{clamp}(N^+(q), -3, 3)/3$.
- Compacité : aire de l'enveloppe convexe des 10 joueurs de champ (m²) ; étendue $\text{span} = \max x - \min x$ ; ligne défensive $x_{line}$ = 2ᵉ plus petite abscisse (repère miroir) ; largeur $\max y - \min y$.
- Supériorité globale : $\sum_{q \in \text{tiers offensif}} PC_{att}(q)\Delta^2$.

---

## 5. Modèles probabilistes de réussite

Tous les modèles sont des logistiques $P = \sigma(\beta_0 + \beta^\top f)$ sur des grandeurs physiques ; $\sigma(z) = 1/(1+e^{-z})$. Chaque fonction renvoie `{p, features, contribs}` où `contribs[k] = β_k f_k` (pour l'explication). Les coefficients forment le vecteur $\theta_{prob}$, réajusté par régression logistique sur les issues du simulateur (§11.6).

### 5.1 Passe au pied (receveur $r$, cible $q_r$, vitesse d'arrivée $s_{arr}$)

Cible **anticipée** : $q_r = p_r + v_r\, \min\big(T_b(\|p_r - b\|),\ t_{stop}\big)$ (une itération de point fixe), où $t_{stop}$ est le temps que met le receveur à atteindre sa cible de déplacement courante (`Player.target`, connue de la décision : le moteur l'y arrête) — sans cette borne, un receveur lancé vers un poste à 4 m recevait le ballon 15 m plus loin (§15.2). Quatre vitesses $s_{arr} \in \{4, 6, 9, 10\}$ m/s sont candidates ; la meilleure au sens de $EV$ est retenue.
$$P_{pass} = (1 - P_{int})\cdot \sigma\big(2{,}4 - 0{,}03\, d - 0{,}9\,\Pi(b) - 0{,}6\,\Pi(q_r) - 0{,}01\max(0, d - 30) - 0{,}1\max(0, s_{arr} - 9) + \beta_{lob}\big),\quad d = \|q_r - b\|,$$
$\beta_{lob} = -1{,}5$ pour une passe lobée (réception d'un ballon retombé à 2–3 m du point visé, §15.2), 0 sinon ; le terme en $s_{arr}$ pénalise la passe appuyée (contrôle du receveur). Termes de distance réajustés sur les issues du moteur (§11.6, §15.2 ; spécification initiale $-0{,}04\,d - 0{,}02\max(0, d-30)$). Ancrages : 15 m libre ≈ 0,88 ; 35 m sous pression ($\Pi = 1$) ≈ 0,60.

### 5.2 Passe en profondeur (vers un point $q$, receveur $k = \arg\min_{i \in att} T_i(q)$)

$$P_{through} = (1 - P_{int}(b \to q))\cdot \operatorname{logit}^{-1}\!\Big(\frac{\min_{j \in def} T_j(q) - T_k(q)}{\sigma_T}\Big)\cdot \sigma\big(1{,}8 - 0{,}03\, d - 0{,}8\,\Pi(b)\big)\cdot \mathbb 1[\text{onside}(k)],$$
$s_{arr} = 9$ m/s (ballon à prendre en course). Hors-jeu évalué au lancement : $x_k \le \max(x_b, x^{(2)}_{def})$ ou $x_k \le 0$ (sans défenseur, la ligne est la ligne de but adverse). Facteur supplémentaire « receveur au rendez-vous » : $\operatorname{logit}^{-1}\big((T_b(q) + \delta_{reach} - T_k(q))/\sigma_T\big)$, $\delta_{reach} = 0{,}6$ s — un ballon lancé pour arriver à 9 m/s poursuit sa course au-delà de $q$ et un receveur trop en retard le manque, même sans défenseur.

### 5.3 Dribble ($b \to q$, $d \le 8$ m)

$$P_{drib} = \sigma\Big(1{,}5 - 1{,}2\,\bar\Pi_{path} - 0{,}15\, d + 0{,}8\big(PC_{att}(q) - 0{,}5\big) + 1{,}0\tanh\big(\min_{j} T_j(q) - T_{drib}(q)\big)\Big),\quad \bar\Pi_{path} = \tfrac1M\sum_m \Pi(q_m),$$
où $T_{drib}(q)$ est le temps de conduite du ballon avec la même cinématique que les adversaires (accélération bornée depuis la vitesse courante projetée, plafond $v_{drib}$, sans temps de réaction : `dribbleTime`). L'ancienne forme $d/v_{drib}$ accordait au porteur un départ lancé instantané (0,67 s pour 4 m contre 1,27 s depuis l'arrêt), soit +0,6 s de marge systématique en faveur du dribble.
Ancrages : 4 m libre ≈ 0,89 ; 4 m contesté ($\bar\Pi = 1$, $PC = 0{,}5$, course perdue de 0,5 s) ≈ 0,32.

### 5.4 Tir ($xG$ avec gardien)

Features : $\omega$ (rad), $d_G$ (m), couverture du gardien $c_{gk} \in [0,1]$ = fraction de $\omega$ masquée par un segment de largeur $1{,}8 + 2 r_{gk}$ centré en $p_{gk}$, $r_{gk} = \min(1{,}2,\ 0{,}5 + 2{,}0\, T_{flight})$ ; $n_{blk}$ = défenseurs dans le cône de tir (hors gardien) ; $\Pi(b)$.
$$xG = \sigma\big(-1{,}1 + 3{,}0\,\omega - 0{,}08\, d_G - 1{,}5\, c_{gk} - 0{,}9\, n_{blk} - 0{,}5\,\Pi(b)\big).$$
Ancrages (gardien centré, sans pression) : 6 m axial ≈ 0,72 ; point de penalty ≈ 0,29 ; 18 m axial ≈ 0,10 ; 25 m ≈ 0,04 ; 12,8 m à 21° ≈ 0,13. Trois points de visée sont évalués, le meilleur est retenu.

### 5.5 Conservation (garder le ballon pendant $T_{hold} = 0{,}4$ s)

$$P_{hold} = \sigma\big(2{,}5 - 1{,}6\,\Pi(b) - 0{,}3\, n_{2m}\big),\quad n_{2m} = \#\{j : \|p_j - b\| < 2\}.$$

### 5.6 Valeur d'un échec

Une perte de balle en $q^-$ vaut $L(q^-) = xT^{def}(q^-)$ (menace adverse au point de perte, buts). Point de perte : pour une passe, le point faible de la ligne (§4.6) ; pour un dribble ou une conservation, $b$ ; pour un tir, $p_{gk}$ (relance adverse).

---

## 6. Décision du porteur de balle

### 6.1 Génération des candidats (≤ 50)

| Type | Génération | Nombre |
|---|---|---|
| `pass` | un par coéquipier × 4 vitesses $s_{arr}$ (la meilleure est retenue), cible anticipée $q_r$ ; élagage géométrique §4.6 ; variante lobée distincte au-delà de 25 m (cible longue, ou ligne fermée : `planPassVariants`, §15.2) | ≤ 40 → ≤ 20 retenus |
| `through` | $q = p_k + \lambda \hat u_k$, $\lambda \in \{6, 12, 18\}$ m, $\hat u_k$ = direction de course de $k$ mélangée à $\hat x$ (50/50, rabattue sur $\hat x$ si le mélange ne pointe pas vers l'avant), + les 6 points de plus grand $D(q)$ d'un motif polaire centré sur le ballon (distances {8, 16, 24, 32} m × angles ±60°, servis au coéquipier en jeu qui y arrive le premier) ; cibles confondues (< 1 m) dédoublonnées ; élagage $W > 0{,}8$ ; garde les 8 meilleurs $EV_1$ (déviation : $EV_1$ contient déjà $1 - P_{int}$ et la valeur, ce que $W$ seul ignore) | ≤ 8 |
| `dribble` | 8 directions × {4, 8} m | 16 |
| `shot` | si $d_G < 35$ m et $xG \ge xG_{min}\,(1{,}5 - \text{shotEagerness})$ ($xG_{min} = 0{,}04$ : un tir désespéré n'est pas une option), 3 points de visée | ≤ 3 |
| `hold` | 1 | 1 |
| `clear` | dégagement long vers l'aile la plus libre, seulement si $x_b < -25$ et $\Pi(b) > 1{,}5$ | ≤ 1 |

### 6.2 Fonction d'évaluation à un coup (espérance avec risque)

Pour un candidat $a$ de probabilité $P_a$, d'état de succès $q_a^+$ (ballon + porteur) et de point d'échec $q_a^-$, sur l'état **anticipé** (tous les joueurs avancés de $T_a$ à vitesse constante, $PC$ lu sur la grille du cycle) :
$$EV_1(a) = P_a\, V^+(a) - (1 - P_a)\,\lambda_{risk}\, L(q_a^-) - C(a),$$
$$V^+(a) = \Theta(q_a^+) + w_{prog}\frac{\Delta x_a}{L} + w_{sup}\,\text{sup}(q_a^+) + w_{lb}\, n_{lb}(a)\qquad(\text{tir} : V^+ = 1,\ P_a = xG),$$
$$C(a) = w_{time}\, T_a + w_{off}\,\mathbb 1[\text{risque de hors-jeu}] + w_{len}\,(1 - \text{directness})\, P_a\, \frac{\max(0, d_a - d_{sup})}{L}\ (\text{passes}),$$
avec $\lambda_{risk} = 1$, $w_{prog} = 0{,}15$, $w_{sup} = 0{,}02$, $w_{lb} = 0{,}02$, $w_{time} = 0{,}005$ but/s, $w_{off} = 0{,}02$, $w_{len} = 0{,}1$, $d_{sup}$ = distance de soutien du style (11 m possession, 16 m contre). Le « risque de hors-jeu » est vrai si le receveur est devant le ballon ET à moins de 1 m de la ligne des défenseurs (un receveur derrière le ballon ne peut jamais être hors-jeu, le porteur étant alors la ligne). $T_a$ : durée de l'action ($T_b$ pour une passe, $d/v_{drib}$ pour un dribble, $T_{flight}$ pour un tir, $T_{hold}$).

**Tir** : $EV_1 = xG - (1 - xG)\,[\lambda_{risk}\, L(p_{gk}) + w_{poss}\,\Theta(b)] - C$, $w_{poss} = 0{,}25$ : un tir manqué rend le ballon (composante « possession », coût d'opportunité de la possession courante $\Theta(b) = xT(b)\,PC_{att}(b)$) ; sans ce terme, $L(p_{gk}) \approx 0{,}005$ rend un tir de 33 m à $xG = 0{,}02$ meilleur que toute passe. Calibré avec le plancher $xG_{min}$ sur 12 matchs : 4–7 tirs par équipe et 10 min, $xG$ moyen par tir 0,07–0,34.

Décomposition stockée pour chaque candidat : `reward = P·V+`, `risk = (1−P)·λ·L`, `cost = C`, plus les contributions du logit de $P_a$. Elle est strictement additive.

### 6.3 Anticipation à deux coups et réponse adverse (théorie des jeux)

**Ensemble de réponses défensives** $\mathcal R = \{$`hold` (tenir la forme), `press` (les 2 défenseurs les plus proches de $q_a^+$ y courent), `cover` (le défenseur le plus proche de la meilleure ligne de passe issue de $q_a^+$ se place sur son point faible), `drop` (la ligne défensive recule de 5 m)$\}$. Chaque réponse est un re-ciblage de 2–3 défenseurs exécuté pendant $T_a$ avec le modèle de mouvement §4.1 (donc avec réaction et accélération : la pessimisation est bornée physiquement).

**Modèle direct** $F(s, a, r)$ : ballon en $q_a^+$, attaquants avancés vers leurs cibles hors-ballon courantes, défenseurs selon $r$. Le contrôle est **recalculé localement** sur un patch $10 \times 10$ cellules autour de $q_a^+$ pour les joueurs déplacés (les autres cellules gardent la grille du cycle) ; on note $\Theta_r(q_a^+)$ la menace recalculée.

**Gain incrémental de la meilleure suite** : sur $s^+_{a,r}$, on régénère un jeu réduit de candidats $\mathcal C'$ (10 passes à $s_{arr} = 6$, meilleur tir, meilleur dribble, conservation ; interception avec 6 échantillons) et
$$\mathcal G(a, r) = \max_{a' \in \mathcal C'} \big[EV_1(a' \mid s^+_{a,r}) - \Theta_r(q_a^+)\big].$$
(La conservation garantit $\mathcal G \gtrsim 0$.) C'est l'accroissement de valeur que la suite apporte **en plus** de la valeur déjà comptée en $q_a^+$ : aucun double comptage.

**Score final** (retour à deux coups, minimax sur la réponse) :
$$Q(a) = P_a \min_{r \in \mathcal R}\Big[\Theta_r(q_a^+) + w_{prog}\tfrac{\Delta x_a}{L} + w_{sup}\,\text{sup} + w_{lb}\, n_{lb} + \gamma\, \mathcal G(a, r)\Big] - (1 - P_a)\,\lambda_{risk}\, L(q_a^-) - C(a),\qquad \gamma = 0{,}5.$$
Seuls les $K = 5$ meilleurs candidats selon $EV_1$ sont développés ; les autres gardent $Q = EV_1$. Implémentation (`onball.ts`, réponse `press` seule) : $Q(a) = EV_1(a) - P_a\,\delta_a + P_a\,\gamma\,\max(0, \mathcal G(a))$ avec $\delta_a = \Theta(q^+) - \Theta_{press}(q^+) \ge 0$ (composante « response », affichée telle quelle) et $\mathcal G(a) = \max_{a'} EV_1(a' \mid s^+) - \Theta_{press}(q^+)$ ; une suite « tir » est comparée en outre au tir immédiat (sinon « dribbler puis tirer » serait crédité de tout $xG'$). Le gain borné à 0 garantit qu'un candidat non développé ($Q = EV_1$) ne dépasse jamais un candidat développé par simple omission. La réponse $r^\star(a) = \arg\min_r$ est mémorisée pour l'explication (« la meilleure réponse de la défense serait de couvrir la ligne vers le n° 9, ce qui dégrade cette passe de 0,012 »). Branchement : $5 \times 4 \times 13 = 260$ feuilles.

Justification : un critère glouton sur $xT$ ignore les combinaisons « passe au pied puis passe en profondeur » et la réaction adverse ; la profondeur 2 avec un petit ensemble de réponses capture les deux à coût borné ; la profondeur 3 est réservée à l'oracle hors-ligne (§11) qui sert à mesurer le regret de la profondeur 2.

### 6.4 Dilemmes à stratégie mixte (jeu 2×2 à somme nulle)

Lorsque les deux meilleurs candidats $a_1, a_2$ sont de types différents parmi {tir, passe, dribble} et que $|Q(a_1) - Q(a_2)| < \varepsilon_{game} = 0{,}02$, on forme la matrice de gains $M_{kl} = Q_1(a_k \mid r_l)$ (évaluation §6.2 sous la réponse $r_l$, $l \in \{1, 2\}$) avec les deux réponses pertinentes : tir/passe ⇒ {`press` (le gardien/défenseur sort sur le porteur), `cover`} ; passe/dribble ⇒ {`press`, `cover`}.

- Test de point-selle : si $\max_k \min_l M_{kl} = \min_l \max_k M_{kl}$, l'action pure minimax est jouée.
- Sinon, stratégie mixte de Nash : $\pi_1 = \dfrac{M_{22} - M_{21}}{M_{11} - M_{12} - M_{21} + M_{22}}$ (borné à $[0,1]$), valeur du jeu $v = \dfrac{M_{11}M_{22} - M_{12}M_{21}}{M_{11} - M_{12} - M_{21} + M_{22}}$ ; l'action est tirée au RNG avec $\pi_1$ et **engagée pour toute sa durée** (au moins 1 s pour dribble/conservation) : pas de re-tirage à chaque cycle.
- Test unitaire : matching pennies $\begin{pmatrix}1 & -1\\ -1 & 1\end{pmatrix}$ ⇒ $\pi_1 = 0{,}5$ ; matrice à point-selle ⇒ pure.
- L'interface affiche la matrice, $\pi$ et $v$. Justification : un moteur déterministe est exploitable (le défenseur « devine ») ; la randomisation à l'équilibre est la réponse correcte au problème de prédictibilité, et elle explique pourquoi le moteur passe parfois alors que $xG$ est maximal.

### 6.5 Pondération tactique, sélection, hystérésis

Le profil tactique (§9) multiplie $\lambda_{risk}, w_{prog}, w_{lb}, \gamma, w_{time}$ avant évaluation. Sélection : $a^\star = \arg\max Q$ ; égalité à $\varepsilon = 0{,}005$ près ⇒ plus grand $P_a$, puis plus petit $T_a$ (température nulle), ou réponse quantale (softmax de température 0,01) sur la fenêtre $\varepsilon$ ; l'explication signale « départage quantal » lorsque l'action choisie n'est pas le premier candidat. **Hystérésis** : l'intention courante $a_{cur}$ est conservée sauf si $Q(a_{new}) > Q(a_{cur}) + h$ ou si $a_{cur}$ est devenue infaisable. Procédure de calibration de $h$ : distribution des écarts $Q(a_1) - Q(a_2)$ bruts (hors hystérésis) sur les décisions du porteur, $h$ = 30ᵉ percentile — mesuré en match (12 matchs, 3 paires tactiques) : 0,0018–0,0025 ⇒ $h = 0{,}002$ (sur les états construits de la bibliothèque, p30 ≈ 0,006 ; le test `calibration de h` rapporte les percentiles). L'ancienne valeur 0,02 était de l'ordre de la valeur entière d'une action au milieu du terrain et verrouillait le porteur dans son intention (54–65 % des décisions conservées par hystérésis, contre 5–6 % avec 0,002). Une passe ou un tir décidé est exécuté immédiatement (irrévocable) ; un dribble ou une conservation choisis portent `committedUntil` (durée de l'action) et le moteur (`loop.ts`) ne re-décide pas un dribble engagé tant que le porteur garde le ballon et n'a pas atteint sa cible.

### 6.6 Dérivation de l'explication

Chaque candidat porte un `ScoreBreakdown` (§13). L'explication est un **tri des termes additifs**, pas un texte libre :

1. Action choisie, $Q$, $P_a$, les deux alternatives suivantes et leur écart de $Q$.
2. Les deux plus grandes contributions positives (« +0,11 menace : receveur en $xT = 0{,}19$ avec 78 % de contrôle », « +0,03 progression 18 m », « +0,02 franchit 1 ligne »).
3. Les deux plus grandes contributions négatives (« −0,06 risque d'interception : le n° 7 arrive 0,3 s avant le ballon à mi-course » — issu de $W$ ; « −0,01 pression sur le porteur »).
4. « Pourquoi le second a perdu » : le terme unique de plus grande différence entre les deux décompositions.
5. Réponse adverse $r^\star$ et sa dégradation $\Theta(q^+) - \Theta_{r^\star}(q^+)$ ; matrice 2×2 et $\pi$ s'il y a eu jeu mixte ; mention « conservé par hystérésis » le cas échéant.

Rendu Canvas : flèches des candidats colorées par $Q$, points d'échantillonnage avec $\Phi_{j,m}$, carte de chaleur $PC$/$D$, histogramme de la décomposition, matrice 2×2. Comme tout est additif, l'explication est exacte, non reconstituée a posteriori.

---

## 7. Décision sans ballon en attaque

### 7.1 Formulation

Chaque attaquant non porteur $i$ choisit une cible $q$ parmi : 24 points (8 directions × {3, 8, 15} m), son poste tactique $s_i$ (§9), et 4 **points de course** derrière la ligne défensive ($x_q > x_{line}^{def} + 2$ m, onside au moment du lancement, à $\le 20$ m de $p_i$, sur les cellules de plus grand $D$). Utilité :
$$U_i(q) = w_1\underbrace{P_{pass}(b \to q)\, xT(q)}_{\text{valeur recevable}} + w_2\underbrace{\big[PC_{att}(q) - PC_{att}(p_i)\big]}_{\text{gain d'espace}} + w_3\underbrace{\Delta E_{team}(q)}_{\text{exposition créée}} - w_4\frac{\|q - s_i\|^2}{r_{slot}^2} - w_5\sum_{k \in att \setminus i} e^{-\|q - p_k\|^2/2r_{sep}^2} - w_6\,\mathbb 1[\text{hors-jeu}(q)],$$
$w = (1 ; 0{,}3 ; 0{,}3 ; 0{,}2 ; 0{,}4 ; 0{,}5)$, $r_{slot} = 12$ m, $r_{sep} = 8$ m. $\Delta E_{team}(q)$ = variation de l'exposition $E$ si $i$ est déplacé en $q$ (avec son marqueur affecté qui le suit, §8), calculée sur deux patchs $10 \times 10$ autour de $q$ et $p_i$. **Coût maîtrisé** : les termes bon marché sont calculés pour les 29 candidats, $\Delta E$ seulement pour les 6 meilleurs. Le terme $w_1$ utilise $P_{pass}$ avec 6 échantillons d'interception.

Lecture par concepts d'entraîneur (étiquette du mouvement = terme dominant, utilisée pour l'explication) : **soutien** (terme 1 près du ballon), **appel** (terme 1 loin devant / point de course), **largeur** (poste $s_i$ élargi par la tactique), **création d'espace / leurre** (terme 3 : s'éloigner en entraînant son marqueur augmente l'exposition adverse), **conservation de la structure** (terme 4).

### 7.2 Règles collectives, hystérésis, lissage

- **Un seul coureur par bande** : les cibles « course derrière la ligne » sont attribuées gloutonnement par $U$ décroissante avec au plus une course par bande latérale de 15 m ; les perdants gardent leur meilleur candidat non-course.
- **Défenseurs de repos** : `restDefenders` joueurs (§9) — les plus reculés — n'ont que leur poste et les cibles à moins de 5 m.
- **Hystérésis** : la cible est engagée jusqu'à être atteinte (≤ 1,5 m) ou dépassée par un challenger de $h_{off} = 0{,}15$, avec ré-examen forcé toutes les 2 s. Lissage de direction par retard du premier ordre $\tau_{steer} = 0{,}3$ s sur $v^{des}$.
- **KPI de stabilité** (harnais) : taux de changement de cible par joueur et par seconde ; changement de cap moyen (°/s). Cibles : $< 0{,}5$ changement/s, $< 60$°/s.

---

## 8. Décision défensive

### 8.1 Génération des tâches (chaque cycle, pour l'équipe sans ballon)

| Tâche | Cible $q_t$ | Priorité $\pi_t \in [0, 1]$ |
|---|---|---|
| `press` (1 ou $n_{press}$ selon tactique) | point de poursuite $q = b + v_b T$ résolu par point fixe $T_j(q) = T$ (3 itérations) | 1,0 si déclencheur actif, sinon 0,5 (`contain` : 2 m côté but du porteur) |
| `mark k` (pour les $n_{mark}$ attaquants les plus dangereux) | $p_k^+ + \delta\,\widehat{(G_{own} - p_k^+)}$, $p_k^+ = p_k + 0{,}5 v_k$, $\delta = 1{,}5$ m ; en style zonal, décalé de 1 m côté ballon | $xT(p_k^+)\, P_{pass}(b \to p_k^+)/xT_{max}$, $xT_{max}$ = max sur les attaquants |
| `cover z` (≤ 4) | cellules de plus grand $D(q)$ non adjacentes à un attaquant marqué, regroupées (couverture des couloirs de profondeur) | $0{,}7\, D(z)/D_{max}$ |
| `intercept` | point d'interception sur une passe en cours (si $W > 0{,}5$ pour ce défenseur) | 1,0 |
| `recover` (complément à 10) | poste défensif $s_j^{def}$ décalé par le bloc (§9) | 0 |

### 8.2 Déclencheur de pressing

$$\text{trig} = \mathbb 1[\tau_P(h) < \tau_{trig}] + \mathbb 1[\max_a P_{pass} < 0{,}6] + \mathbb 1[\text{passe en retrait reçue}] + \mathbb 1[x_b \text{ dans la zone de pressing}] + \mathbb 1[N^+(b) \le 0],$$
où $\tau_P(h) = \min_j T_j(b)$. Pressing si $\text{trig} \ge n_{trig}$ (tactique : 1 pour un pressing haut, 2 par défaut, 3 pour un bloc bas). En transition défensive (`T-`, 4 s après une perte) : $n_{trig} = 0$ pour les 2 joueurs les plus proches si la tactique a `counterPress` (règle des 5 secondes).

### 8.3 Problème d'affectation

Coût du défenseur $j$ pour la tâche $t$ (tout en secondes) :
$$C_{jt} = T_j(q_t) - \mu_{prio}\,\pi_t + \nu_{shape}\frac{\|q_t - s_j^{def}\|}{L} + \xi\,\mathbb 1[t \ne \text{tâche}_j^{prev}] + \mu_{role}\,\mathbb 1[\text{tâche hors zone naturelle du rôle}],$$
$\mu_{prio} = 6$ s, $\nu_{shape} = 8$ s, $\xi = 0{,}4$ s, $\mu_{role} = 1{,}5$ s ; $C_{jt} = +\infty$ si $T_j(q_t) > 6$ s et $t \ne$ `recover` (plafond de réaffectation transversale). Résolution par l'**algorithme hongrois** (Kuhn–Munkres) sur la matrice $10 \times 10$ complétée par des tâches `recover` : optimum global en $O(n^3)$, $< 0{,}1$ ms. Justification : « qui marque qui » est un problème d'affectation ; l'affectation gloutonne produit des doubles marquages et des attaquants libres (ablation §11). **Hystérésis globale** : la nouvelle affectation n'est adoptée que si le coût total diminue de plus de $\Delta C_{min} = 0{,}5$ s. Test unitaire : hongrois = force brute pour $n \le 6$.

### 8.4 Exécution des tâches

- `press` : course au point de poursuite ; à $\le r_{tackle}$ du porteur, duel (§3.3).
- `mark` : style **homme** — reste à $\delta$ côté but de l'attaquant, suit ses déplacements ; style **zonal** — se place sur le segment [attaquant, ballon] à $\delta$ de l'attaquant, mais n'abandonne pas sa zone de 10 m autour de $s_j^{def}$.
- `cover` : va au centre de zone, s'oriente vers le ballon.
- `recover` : rejoint le poste ; la ligne défensive (les $n$ défenseurs de la ligne basse) est **alignée** sur $x_{line}$ : $s_j^{def}.x \leftarrow \max(s_j^{def}.x, x_{line})$, pour tenir la ligne de hors-jeu.

### 8.5 Bloc et lignes

Le bloc est défini par $x_{line}$ (ligne défensive) et $x_{press}$ (ligne au-delà de laquelle on presse) de la tactique, et par la compacité cible $\Lambda$ : les postes défensifs sont comprimés dans $[x_{line}, x_{line} + \Lambda]$ (§9.2). Repli : en `T-`, tous les joueurs non presseurs situés devant le ballon reçoivent une tâche `recover` avec $\nu_{shape} \times 2$.

### 8.6 Gardien

Politique fixe : se place sur la bissectrice de l'angle de tir à distance $d_{gk} = \min(5{,}5 ; 0{,}2\, d_G)$ de la ligne de but ; sort sur un ballon libre dans sa surface si $T_{gk}(b) < \min_{i \in att} T_i(b)$ ; en possession, décide comme un porteur avec candidats restreints aux passes (pas de dribble ni de tir).

---

## 9. Couche tactique

### 9.1 Formations (postes normalisés : $x \in [0,1]$ depuis son propre but, $y \in [-1, 1]$)

> Implémentation : `src/tactics/formations.ts` stocke directement les postes **en mètres** dans le repère équipe (attaque vers $+x$), avec des coefficients de suivi du ballon `followX`/`followY` par poste ; les valeurs normalisées ci-dessous en sont l'équivalent.

| Formation | Postes (rôle : $(x, y)$) |
|---|---|
| 4-3-3 | GK (0,04;0) ; CB (0,20;±0,20) ; FB (0,25;±0,75) ; DM (0,35;0) ; CM (0,45;±0,35) ; W (0,65;±0,80) ; ST (0,70;0) |
| 4-4-2 | GK ; CB (0,20;±0,20) ; FB (0,25;±0,75) ; CM (0,42;±0,25) ; WM (0,45;±0,80) ; ST (0,68;±0,25) |
| 3-5-2 | GK ; CB (0,20;0), (0,20;±0,35) ; WB (0,42;±0,85) ; DM (0,35;0) ; CM (0,48;±0,30) ; ST (0,68;±0,25) |
| 4-2-3-1 | GK ; CB ; FB ; DM (0,35;±0,20) ; AM (0,55;0) ; W (0,58;±0,80) ; ST (0,70;0) |
| 3-4-3 | GK ; CB (0,20;0), (0,20;±0,35) ; WB (0,40;±0,85) ; CM (0,42;±0,25) ; W (0,65;±0,70) ; ST (0,70;0) |

Multiplicateurs de rôle : W/WB/FB `width × 1,0` sur $y$ (les autres × 0,9) ; DM $\nu_{shape} \times 2$ ; « faux 9 » (option) $w_4 \times 0{,}5$ ; ST/W $w_1 \times$ `runBonus` pour les cibles avec $x_q > x_b + 15$ m.

### 9.2 Instanciation des postes

$$s_i = \Big(x_{base} + \Lambda_\phi\, x_i^{norm},\ \ \tfrac W2\, \text{width}\, y_i^{norm}\Big) + \big(\alpha_x\,(x_b - x_{ref}),\ \alpha_y\, y_b\big),$$
avec $\alpha_x = 0{,}6$, $\alpha_y = 0{,}4$ ; en phase d'attaque $x_{base} = -30$ m, $\Lambda_{att} = 70$ m ; en défense $x_{base} = x_{line}$, $\Lambda_{def} = \Lambda$ ; $x_{ref}$ = abscisse du ballon au coup d'envoi (0). Résultat borné au terrain, ligne basse clipée à $x_{line}$.

### 9.3 Profil tactique = vecteur de paramètres (objet JSON)

```json
{
  "name": "possession-433",
  "formation": "4-3-3",
  "onBall":   { "riskAversion": 1.6, "directness": 0.5, "tempo": 1.0, "lookahead": 1.2 },
  "offBall":  { "width": 1.15, "runBonus": 0.8, "restDefenders": 3 },
  "pressing": { "nTrig": 2, "tauTrig": 1.2, "xPress": 10, "nPress": 1, "prioScale": 1.0, "counterPress": true },
  "block":    { "xLine": -12, "compactness": 38, "marking": "zonal", "nMark": 3 },
  "transition": { "counterWindow": 4, "counterBoost": 1.0 }
}
```

Action des modulateurs (multiplicatifs sur les défauts du §2, ce qui rend l'ablation « sans modulation tactique » triviale — tous à 1) :

| Modulateur | Effet |
|---|---|
| `riskAversion` | $\lambda_{risk} \leftarrow \lambda_{risk} \cdot$ riskAversion |
| `directness` | $w_{prog}, w_{lb} \leftarrow \cdot$ directness ; $\gamma \leftarrow \gamma \cdot$ lookahead |
| `tempo` | $w_{time} \leftarrow \cdot$ tempo (un tempo élevé pénalise les actions lentes) |
| `width`, `runBonus`, `restDefenders` | §9.2 ; $w_1$ des cibles lointaines ; §7.2 |
| `nTrig`, `tauTrig`, `xPress`, `nPress`, `prioScale` | §8.2 ; $\mu_{prio} \leftarrow \cdot$ prioScale |
| `xLine`, `compactness`, `marking`, `nMark` | §8.1, §8.4, §8.5 |
| `counterWindow`, `counterBoost` | en `T+` : $w_{prog}, w_1^{run} \leftarrow \cdot$ counterBoost pendant counterWindow s |

Profils fournis (valeurs des paramètres modulés) :

| Profil | Formation | riskAv. | direct. | tempo | width | runBonus | nTrig / τ_trig / xPress | nPress / prioScale | xLine / Λ | marking / nMark | counterBoost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Possession | 4-3-3 | 1,6 | 0,5 | 1,0 | 1,15 | 0,8 | 2 / 1,2 / 10 | 1 / 1,0 | −12 / 38 | zonal / 3 | 1,0 |
| Contre-attaque | 4-4-2 | 0,6 | 2,3 | 1,4 | 1,0 | 1,6 | 3 / 0,8 / −20 | 1 / 1,0 | −18 / 35 | homme dans son tiers / 4 | 2,0 |
| Pressing haut | 4-3-3 | 1,0 | 1,0 | 1,2 | 1,0 | 1,0 | 1 / 1,8 / 25 | 2 / 1,5 | −5 / 30 | homme / 5 | 1,3 |
| Bloc bas | 4-4-2 | 1,2 | 1,0 | 0,8 | 0,85 | 1,0 | 3 / 0,8 / −25 | 1 / 0,7 | −28 / 25 | zonal / 2 | 1,5 |
| Jeu en largeur | 3-5-2 | 1,2 | 0,8 | 1,0 | 1,25 | 1,0 | 2 / 1,2 / 0 | 1 / 1,0 | −15 / 35 | zonal / 3 | 1,0 |
| Jeu direct | 3-4-3 | 0,8 | 2,0 | 1,3 | 1,05 | 1,4 | 2 / 1,2 / 5 | 1 / 1,0 | −15 / 32 | homme / 4 | 1,5 |

Parce que les mêmes fonctions d'évaluation sont utilisées partout, les tactiques sont des **vecteurs de paramètres**, pas des chemins de code : leurs effets sont mesurables (§11.4, KPI structurels).

### 9.4 Phases de jeu (automate)

États par équipe : `build` (possession, $x_b < -17{,}5$), `attack` (possession, $x_b \ge -17{,}5$), `T+` (4 s après récupération), `T-` (4 s après perte), `press` (sans ballon, déclencheur actif), `block` (sans ballon, déclencheur inactif). Transitions sur changement de possession (fin de `T±` au bout de `counterWindow` s ou sur nouvelle perte/récupération) et sur la position du ballon. Effets : `T+` applique `counterBoost` ; `T-` active le contre-pressing (§8.2) et le repli (§8.5) ; `build` inverse le départage des lignes franchies (§6.5).

---

## 10. Apprentissage : optimisation hors-ligne des poids

**Objet** : le vecteur $\vartheta$ (≈ 25 réels) = $(w_{prog}, w_{sup}, w_{lb}, w_{time}, \lambda_{risk}, \gamma, h, w_1..w_6, h_{off}, \mu_{prio}, \nu_{shape}, \xi, \eta, \sigma_T, \beta, \ldots)$. Les coefficients des logistiques ($\theta_{prob}$) ne sont **pas** dans $\vartheta$ : ils sont ajustés par régression logistique (§11.6), ce qui sépare « modèle du monde » et « préférences ».

**Méthode** : cross-entropy method (CEM, Rubinstein & Kroese), population $N = 32$, élites $N_e = 8$, 25 générations ; $\vartheta \sim \mathcal N(\mu, \operatorname{diag}\sigma^2)$, $\sigma_0 = 30\%$ des défauts, $\mu \leftarrow$ moyenne des élites, $\sigma \leftarrow \max(\text{écart-type des élites}, 0{,}02)$ ; paramètres contraints positifs par paramétrage $\log$.

**Fitness** d'un candidat : $F(\vartheta) = \mathbb E[\Delta xG] + 0{,}3\,\mathbb E[\Delta xT_{créé}] - 0{,}2\,\mathbb E[\text{danger des pertes}] - 0{,}3\,\text{regret}_{lib}$, moyenne sur 8 matchs de 5 min contre un **pool gelé** d'adversaires (poids manuels + les 3 dernières élites, tactique tirée parmi les 6 profils) — évite les cycles de l'auto-jeu. **Nombres aléatoires communs** : la même liste de 8 graines pour toute la population d'une génération (réduction de variance). Coût : $32 \times 8 \times 5$ min ≈ 1 300 min simulées par génération ; à 200× temps réel dans Node avec `worker_threads`, ≈ 7 min/génération, ≈ 3 h au total.

**Baselines d'optimisation** : recherche aléatoire, (1+1)-ES ; courbes d'apprentissage (fitness moyenne ± IC 95 % par génération) stockées avec le hash git, les graines et $\vartheta$ dans `results/learning/`.

**Garde-fous** : validation sur les scénarios réservés (§11.2) et contre l'adversaire manuel ; assertions « action de manuel » ; détection de politiques dégénérées (taux de tir < 0,5/match, longueur moyenne de passe > 40 m, possession < 20 %) ⇒ candidat rejeté.

**Composant en ligne optionnel** : bandit contextuel LinUCB ($d = 8$ features du gain, contexte = phase × tiers × classe de pression = 36) qui ne s'exerce que dans la **zone d'égalité** $|Q_1 - Q_2| < 0{,}02$ ; récompense = $\Delta xT$ réalisé sous 3 s (ou $-L$ si perte). Il ne peut pas déstabiliser la politique hors-ligne ; une Q-table (contexte × type d'action, $\alpha = 0{,}05$, $\gamma = 0{,}9$) sert d'ablation.

**Justification** : l'espace est petit (25 dims), l'objectif est bruité et non différentiable (simulateur), le CEM est robuste, parallélisable et facile à expliquer ; un RL profond serait injustifié pour un problème dont la structure (features physiques, poids interprétables) est déjà connue.

---

## 11. Protocole expérimental

### 11.1 Indicateurs

| Famille | Indicateur | Définition |
|---|---|---|
| Résultat | buts, $xG$ pour/contre, $\Delta xG$ | $\sum xG$ des tirs |
| Création | $xT$ créé par possession | $\max xT$ atteint − $xT$ initial ; $\sum \Delta\Theta$ des actions réussies |
| Fiabilité | taux de réussite passes, profondeur, dribbles ; pertes / 10 min ; danger des pertes | $\sum L(q^-)$ |
| Décision | **regret** $R = \max_a Q^{oracle}(a) - Q^{oracle}(a^\star)$ ; **accord expert** top-1 / top-3 | oracle = expectimax profondeur 3, 200 rollouts Monte-Carlo, hors-ligne ; ensembles d'actions acceptables étiquetés à la main |
| Structure | possession %, PPDA, compacité, hauteur de ligne, largeur, distribution des longueurs de passe, nombre de courses derrière la ligne | montrent que la tactique change les décisions |
| Stabilité | taux de changement d'intention (porteur), de cible (hors-ballon), d'affectation (défense) | §7.2 |
| Calibration | score de Brier, diagramme de fiabilité par modèle (passe, profondeur, dribble, tir, conservation, interception) | §11.6 |
| Performance | latence par cycle (p50, p95, p99, ms), sur 100 états aléatoires et sur match | `perf.spec` |
| Jeu | exploitabilité : score d'une tactique contre sa meilleure réponse dans le tournoi | §11.4 |

### 11.2 Bibliothèque de scénarios

`scenarios/*.json` : ~60 états figés écrits à la main (contre 3v2, construction sous pressing haut, surnombre sur l'aile, bloc bas contre possession, 1v1 gardien, piège du hors-jeu, déclencheur de pressing, renversement de jeu, impasses sans solution de passe, tir ou remise en retrait, relance du gardien) + 500 états générés (générateur à graine : formation × phase × bruit). Chaque scénario manuel porte : l'**ensemble des actions acceptables** (classe + receveur/direction), une assertion « manuel » (vitest), et un KPI (ex. « $xG$ sous 5 s »). Chaque scénario est joué 6 s sur 32 graines. 20 scénarios sont **réservés** (jamais utilisés en optimisation).

### 11.3 Baselines et ablations

| Code | Configuration | Ce qu'elle isole |
|---|---|---|
| B0 | action légale uniforme | plancher |
| B1 | glouton si/alors : passe la plus sûre vers l'avant sinon dribble | la valeur d'une fonction d'évaluation |
| B2 | $EV_1$ seul ($K = 0$, pas de réponse adverse, pas de jeu 2×2) | l'anticipation et la théorie des jeux |
| B3 | moteur complet | référence |
| B4 | $\lambda_{risk} = 0$ | le terme de risque |
| B5 | Voronoï au lieu du modèle de mouvement ($\beta \to 0$, $v = 0$) | le contrôle par temps d'arrivée |
| B6 | affectation gloutonne au lieu du hongrois | l'affectation optimale |
| B7 | tous les modulateurs tactiques à 1 | l'effet des tactiques |
| B8 | sans hystérésis ($h = h_{off} = \xi = 0$) | la stabilité |
| B9 | poids manuels vs poids CEM | l'apprentissage |
| B10 | $P_{int}$ = point faible seul ; $\eta$ non calibré | le modèle d'interception |

### 11.4 Plan d'expériences

1. **Scénarios** : regret, accord expert, KPI, pour B0–B10 (32 graines × 60 scénarios).
2. **Auto-jeu** : B3 contre chaque baseline, 64 matchs de 10 min à graines appariées.
3. **Tournoi tactique** : 6 profils × 6 profils, 64 matchs par paire ; Elo ; KPI structurels par profil ; **exploitabilité** = pour chaque profil, son résultat contre le profil qui le bat le plus.
4. **Ablations de paramètres** : sensibilité de $\Delta xG$ et du regret à $a_{max} \in \{4, 5, 6\}$, $\tau_r \in \{0{,}2 ; 0{,}3 ; 0{,}5\}$, $\eta$, $\beta$, $K \in \{3, 5, 8\}$, $\gamma$.
5. **Apprentissage** : courbes CEM, comparaison B9, généralisation sur les scénarios réservés.

### 11.5 Traitement statistique

Différences appariées par graine ; IC 95 % par bootstrap (2 000 rééchantillonnages) ; test de Wilcoxon signé pour $\Delta xG$ et le regret ; taille d'effet $\delta$ de Cliff ; correction de Holm pour les comparaisons multiples du tournoi. **Limite de puissance énoncée** : les buts sont rares (≈ 2,5 par 10 min simulées), les conclusions reposent donc sur $\Delta xG$ et $xT$ ; la différence de buts est rapportée à titre indicatif. Reproductibilité : test de déterminisme (même graine ⇒ même hash d'état après 10 min) ; chaque résultat est stocké avec hash git, graines, $\vartheta$.

### 11.6 Boucle d'auto-cohérence (calibration)

Pendant l'auto-jeu, chaque action exécutée enregistre `(features, issue réelle)`. Pour chaque modèle du §5, on rapporte le Brier et le diagramme de fiabilité avec les coefficients manuels, puis on **réajuste** par régression logistique (Newton, 20 itérations, ridge $10^{-3}$) et on rapporte les mêmes indicateurs après. $\eta$ est calibré de même : on minimise le Brier de $P_{int}$ contre la fréquence d'interception observée quand les défenseurs jouent `intercept`. Ce protocole ferme l'écart entre modèle de décision et physique et fournit une figure de calibration pour le rapport. Mise en œuvre (`scripts/calibrate.ts`, §15.4) : les caractéristiques brutes $\Delta_{j,m}$ de chaque passe jouée sont enregistrées et $(\eta, \sigma_T, w)$ sont choisis sur une grille minimisant le Brier de $P_{pass}$ contre la réussite réelle (le critère « $P_{int}$ seule contre prise adverse » est rapporté à titre de diagnostic : le compteur d'interception du moteur inclut les réceptions manquées, §15.2) ; le réajustement des coefficients logistiques est contraint aux termes de base et de distance.

---

## 12. Analyse de complexité et budget temps réel

Par cycle de décision (0,2 s), 22 joueurs, $|\Gamma| = 1802$ :

| Composant | Complexité | Estimation |
|---|---|---|
| $T_i(q)$ sur la grille (22 joueurs) | $22 \times 1802$ formes fermées | 0,4 ms |
| $PC$, $D$, $\Pi$, argmin (espace) | $O(|\Gamma| \cdot 22)$ | 0,5 ms |
| Porteur : ≤ 50 candidats × 132 $T$ | 6,6 k évaluations | 0,3 ms |
| Profondeur 2 : $5 \times 4$ réponses × (patch $10 \times 10 \times$ 5 joueurs déplacés + 13 feuilles × 66 $T$) | ≈ 27 k évaluations | 1,0 ms |
| Jeu 2×2 (4 évaluations $Q_1$) | négligeable | < 0,05 ms |
| Hors-ballon : 10 joueurs × 29 candidats (termes bon marché) + 6 × 2 patchs $10 \times 10 \times 22$ | ≈ 30 k | 0,8 ms |
| Défense : tâches + matrice $10 \times 10$ + hongrois | $O(n^3)$ | 0,1 ms |
| **Total** | | **≈ 3,1 ms** (objectif : p95 < 5 ms, Chrome, typed arrays) |

Physique : $O(23)$ par tick, négligeable. Mémoire : 6 grilles `Float32Array(1802)` + 22 grilles de $T$ (≈ 200 ko).

Hygiène : aucune allocation par cycle (tableaux préalloués, `Candidate` en pool), explications construites uniquement pour le porteur et un joueur sélectionné, décisions décalées (11 joueurs par 0,1 s). **Interrupteurs de dégradation** (activés automatiquement si p95 mesuré > 5 ms sur 3 cycles) : $K = 3$, $|\mathcal R| = 2$ (`hold`, `press`), $\Delta E$ pour les 3 meilleurs seulement, $M = 8$. `perf.spec` échoue si p95 > 5 ms sur 100 états aléatoires ; il fait partie de la CI dès le premier jour.

---

## 13. Architecture logicielle

> **Référence normative** : le contrat de types réellement implémenté est le fichier `src/core/types.ts` ; les valeurs par défaut sont dans `src/core/params.ts`. En cas d'écart entre cette section et ces fichiers, **les fichiers TypeScript font foi**. Les noms ci-dessous sont ceux du code.

### 13.1 Modules et responsabilités

```
src/core/               fondations pures (aucune dépendance vers les autres couches)
  types.ts              contrat de types partagé (MatchState, Player, Ball, Action, Candidate, Decision, FieldSet,
                        TacticConfig/TacticParams, SimParams, MatchStats, MatchEvent…)
  params.ts             DEFAULT_PARAMS (source de vérité des défauts), flattenParams / applyFlatParams (vecteur ϑ)
  vec2.ts               géométrie 2D (add, sub, dist, normalize, projectOnSegment, logistic, clamp…)
  pitch.ts              PITCH (dimensions), goalCentre, goalAngle (angle sous-tendu ω), distToGoal, repère équipe
  grid.ts               ScalarField : grille 53 × 34 (pas 2 m), Float32Array, échantillonnage bilinéaire, argmax
  rng.ts                Rng (mulberry32) : next, uniform, normal, bernoulli, pick, fork
  hungarian.ts          hungarian(cost) : affectation à coût minimal (Kuhn–Munkres), matrices rectangulaires
  stats.ts              moyenne, IC de Student, test de Welch, bootstrap, quantiles
  state-builder.ts      buildState / buildFullState : états « à la main » pour tests et scénarios
src/tactics/
  formations.ts         FORMATIONS (4-3-3, 4-4-2, 3-5-2, 4-2-3-1, 3-4-3) : postes en mètres, repère équipe
  styles.ts             profils (balanced, possession, counter, high_press, low_block, wide, direct) → TacticParams
src/models/             modèles mathématiques (fonctions pures)
  motion.ts             timeToArrive, launchSpeed, ballTravelTime, ballDistanceAt
  fields.ts             computeFields → FieldSet {controlA, threatA, threatB, pressureByA, pressureByB} ; versions ponctuelles
  interception.ts       analyseInterception (M échantillons, Φ, P_int, point faible), passingLaneQuality
  probability.ts        passProbability, throughBallProbability, dribbleProbability, shotProbability, holdProbability
  structure.ts          localSuperiority, compactness, offsideLine, isOffsidePosition, voronoiArea
src/engine/             simulation (seule couche qui mute l'état)
  match.ts              createMatch, setupKickoff, slotPosition (postes instanciés), cloneState, giveBall
  physics.ts            stepPhysics : cinématique, ballon, prises de balle, duels
  actions.ts            executeAction : passe / tir / dribble / conservation / déplacement (bruit d'exécution)
  rules.ts              applyRules : buts, sorties, remises en jeu, hors-jeu, tirs, possession, statistiques ; updatePhases
  loop.ts               createSimulation : cycle décision (0,2 s) → exécution → physique → règles
src/decision/           algorithme de décision
  policy.ts             PolicySet {onBall, offBall, defence} et DecisionInput {state, fields, params, tactic, rng}
  onball.ts             evaluateCandidates, decideOnBall (candidats, EV₁, profondeur 2, réponses adverses, jeu 2×2, hystérésis)
  explain.ts            actionLabel, explainDecision (texte français dérivé de la décomposition additive)
  offball.ts            decideOffBall (utilité U sur positions candidates, étiquette d'intention)
  defence.ts            decideDefence (tâches, matrice de coûts, hongrois, hystérésis, pressing, contre-pressing)
  keeper.ts             decideKeeper (bissectrice, sortie, relance)
  coordinator.ts        decideAll : champs, phases, 22 décisions ; FULL_POLICY
  baselines.ts          BASELINES (random, greedy_progress, greedy_safe, no_lookahead, no_risk, no_tactic, nearest_man)
src/experiments/        harnais Node (scénarios, métriques, tournois, CEM, calibration)
src/ui/                 interface Canvas 2D (rendu, calques, panneaux) — ne fait que lire l'état
scripts/                sim.ts, scenarios.ts, experiments.ts, optimize.ts, bench.ts, screenshot.ts
tests/                  vitest : core, models, engine, onball, offball, defence, coordinator, experiments, ui
```

### 13.2 Flux de données par tick (`src/engine/loop.ts`)

1. Si `time ≥ prochain cycle` (période `params.decisionPeriod` = 0,2 s) : `decideAll(state, params, policies, previous, rng)` calcule `computeFields` (stocké dans `state.fields`), met à jour les phases, puis produit une `Decision` pour chacun des 22 joueurs : porteur → `onBall`, coéquipiers → `offBall`, gardien → `keeper`, équipe sans ballon → `defence` (affectation collective), ballon libre → logique de course au ballon.
2. Pour chaque décision : `executeAction(state, playerId, decision.chosen.action, params, rng)` (une passe/un tir libère le ballon avec bruit d'exécution ; un déplacement fixe `player.target` et `player.targetSpeed`). Comptabilité : `stats.decisions`, `decisionMs`, `regret`, `xG` (tir), `expectedP` (passe, pour la calibration).
3. `stepPhysics(state, params, rng, dt)` : mouvement des joueurs, ballon, prises de balle, duels.
4. `applyRules(state, config, rng)` : buts, sorties, remises, hors-jeu, arrêts du gardien, possession, événements, statistiques ; `updatePhases`.
5. L'interface lit `state`, `state.fields` et `player.decision` ; elle n'appelle aucune autre fonction du moteur.

Écart assumé par rapport au §1 : les 22 décisions sont recalculées au même cycle (pas de décalage pair/impair) ; la latence mesurée reste sous le budget (§12).

### 13.3 Contrat des types partagés

Voir `src/core/types.ts`. Points saillants :

- `Action` (union discriminée) : `pass {targetId, targetPoint, kind: ground|through|lob, speed}`, `dribble {direction, distance}`, `hold`, `shoot {targetPoint, power, xg?}`, `clear {targetPoint}`, `move {target, intent, speed, markId?}`. Les passes en profondeur sont des `pass` de `kind: 'through'`.
- `Candidate` : `action, score, probability, valueIfSuccess, valueIfFailure, components: ScoreComponent[], reason, threats?, weakOpponentId?, duration?, successPoint?, failurePoint?, response?, samples?`. **Invariant** : `score = Σ components[k].contribution` (décomposition additive exacte, base de l'explication) ; `threats[0]` est l'adversaire du point faible (`weakOpponentId`), nommé dans la raison du risque d'interception.
- `Decision` : `playerId, time, chosen, candidates (triés par score décroissant), context, explanation, computeMs, keptByHysteresis?, committedUntil?, game?`.
- `FieldSet` : champs `ScalarField` calculés une fois par cycle (`controlA`, `threatA`, `threatB`, `pressureByA`, `pressureByB`) ; des champs supplémentaires (temps d'arrivée, argmin) peuvent être ajoutés par le module `models`.
- `TacticParams` : vecteur de 18 paramètres (attaque : `riskTolerance, progressionBias, tempo, directness, widthUsage, shotEagerness, supportDistance, runFrequency` ; défense : `pressIntensity, pressLine, defensiveLine, compactness, markingTightness, counterPressWindow, pressTriggerCount` ; transitions : `counterAttackBias, recoverPriority` ; `restDefenders`). Correspondance avec les modulateurs du §9.3 :

| Modulateur (§9.3) | Champ `TacticParams` | Relation |
|---|---|---|
| riskAversion | `riskTolerance` | $\lambda_{risk} \leftarrow \lambda_{risk}\,(1{,}6 - 1{,}2\cdot\text{riskTolerance})$ |
| directness (w_prog, w_lb) | `progressionBias` | $w_{prog}, w_{lb} \leftarrow \cdot\,\text{progressionBias}$ |
| passes longues / profondeur | `directness` | bonus multiplicatif $(1 + 0{,}5\,\text{directness})$ sur les candidats `through`/`lob` |
| tempo | `tempo` | $w_{time} \leftarrow w_{time}\,(0{,}5 + \text{tempo})$ ; pénalité de conservation |
| lookahead | — | $\gamma$ fixe (`params.decision.gamma`) |
| width | `widthUsage` | $y_{poste} \leftarrow y_{poste}\,(0{,}7 + 0{,}6\,\text{widthUsage})$ |
| runBonus | `runFrequency` | $w_{run} \leftarrow w_{run}\cdot 2\,\text{runFrequency}$ |
| restDefenders | `restDefenders` | idem |
| nTrig | `pressTriggerCount` | idem |
| nPress, prioScale, τ_trig | `pressIntensity` | $n_{press} = 1 + \mathbb 1[\text{pressIntensity} > 0{,}7]$, $\mu_{prio} \leftarrow \mu_{prio}(0{,}5 + \text{pressIntensity})$, $\tau_{trig} = 0{,}8 + 1{,}2\,\text{pressIntensity}$ |
| xPress | `pressLine` | idem (repère équipe) |
| xLine | `defensiveLine` | idem (repère équipe) |
| compactness Λ | `compactness` | $\Lambda = 45 - 25\,\text{compactness}$ (m) |
| marking, nMark | `markingTightness` | homme si $> 0{,}5$ ; $n_{mark} = 2 + \lfloor 4\,\text{markingTightness} \rfloor$ |
| counterWindow, counterPress | `counterPressWindow` | contre-pressing pendant `counterPressWindow` s |
| counterBoost | `counterAttackBias` | $w_{prog} \leftarrow w_{prog}(1 + 1{,}5\,\text{counterAttackBias})$ en transition offensive |
| shotEagerness | `shotEagerness` | bonus additif $0{,}05\,(\text{shotEagerness} - 0{,}5)$ sur le tir ; plancher $xG_{min} \leftarrow 0{,}04\,(1{,}5 - \text{shotEagerness})$ |
| passes courtes | `directness`, `supportDistance` | pénalité $-(1 - \text{directness})\cdot 0{,}1\cdot P\cdot \max(0, d - d_{sup})/L$ sur `pass`/`lob`/`through` |

### 13.4 Signatures des fonctions clés (extraits des fichiers)

```ts
// models
timeToArrive(pos: Vec2, vel: Vec2, q: Vec2, maxSpeed: number, maxAccel: number, models: ModelParams): number
computeFields(state: MatchState, params: SimParams): FieldSet
analyseInterception(state, from: Vec2, to: Vec2, kind: BallFlightKind, team: TeamId, params, arrivalSpeed?): InterceptionAnalysis
passProbability(state, fields, passerId, receiverId, targetPoint, params): ProbabilityResult   // {p, features, interception?}
shotProbability(state, fields, shooterId, aimPoint, params): ProbabilityResult
localSuperiority(state, q, team, params, tStar?): number ; isOffsidePosition(state, q, attackingTeam): boolean
// engine
createMatch(config: MatchConfig, rng: Rng): MatchState ; stepPhysics(state, params, rng, dt): void
executeAction(state, playerId, action: Action, params, rng): boolean ; applyRules(state, config, rng): void
createSimulation(config: MatchConfig): Simulation   // {state, config, rng, step(), advance(s), decisions}
// decision
decideOnBall(input: DecisionInput, playerId, previous: Decision | null): Decision
decideOffBall(input, playerId, previous): Decision
decideDefence(input, team: TeamId, previous: Map<number, Decision>): Map<number, Decision>
decideAll(state, params, policies: Record<TeamId, PolicySet>, previous, rng): Map<number, Decision>
// experiments
runMatch(config: MatchConfig, policies?): MatchResult
```

### 13.5 Conventions d'implémentation

- Fonctions pures partout sauf dans `src/engine` (seule couche autorisée à muter `MatchState`).
- Aucun `Math.random` : le `Rng` à graine est injecté (déterminisme testé).
- Tout paramètre numérique passe par `SimParams` (`params.ts`) pour rester optimisable et ablatable.
- Le sens d'attaque est explicite : `attackDir(team)` (+1 pour A, −1 pour B) et les helpers de repère équipe (`toTeamFrame`) ; les formations et `TacticParams.pressLine/defensiveLine` sont exprimés dans le repère équipe.
- Identifiants en anglais, commentaires et chaînes utilisateur en français.
- Les tests d'ancrage (§5) sont des tests unitaires à tolérance ±0,05.

### 13.6 Plan de réalisation par tranches

1. **Tranche minimale** (démo jouable) : fondations, physique, règles, $T_i$, $PC$, $xT$ analytique, $\Pi$, interception, probabilités, candidats + $EV_1$, hors-ballon, défense hongroise, formations, profils, rendu Canvas.
2. **Tranche décision avancée** : profondeur 2 avec $\mathcal R$, jeu 2×2, explications complètes, hystérésis.
3. **Tranche scientifique** : bibliothèque de scénarios, baselines, tournoi tactique, CEM, calibration, statistiques.
4. **Options** : ballons aériens, itération de valeur $xT$, LinUCB, faux 9.

---

## 14. Références bibliographiques

1. Spearman W., Basye A., Dick G., Hotovy R., Pop P. (2017). *Physics-Based Modeling of Pass Probabilities in Soccer.* MIT Sloan Sports Analytics Conference. — modèle de passe, temps d'arrivée, contrôle.
2. Spearman W. (2018). *Beyond Expected Goals.* MIT Sloan Sports Analytics Conference. — pitch control, off-ball scoring opportunity.
3. Fernández J., Bornn L. (2018). *Wide Open Spaces: A statistical technique for measuring space creation in professional soccer.* MIT Sloan SAC. — modèle de mouvement en forme fermée, valeur de l'espace.
4. Singh K. (2019). *Introducing Expected Threat (xT).* karun.in/blog. — menace espérée par itération de valeur.
5. Power P., Ruiz H., Wei X., Lucey P. (2017). *Not All Passes Are Created Equal: Objectively Measuring the Risk and Reward of Passes in Soccer from Tracking Data.* KDD. — risque/récompense des passes.
6. Andrienko G. et al. (2017). *Visual analysis of pressure in football.* Data Mining and Knowledge Discovery. — indice de pression.
7. Taki T., Hasegawa J. (2000). *Visualization of dominant region in team games and its application to teamwork analysis.* Computer Graphics International. — régions dominantes (Voronoï cinématique).
8. Caley M. (2015). *Premier League Projections and New Expected Goals.* ; StatsBomb (2018) *xG model features.* — formes géométriques des modèles $xG$.
9. Kuhn H. W. (1955). *The Hungarian method for the assignment problem.* Naval Research Logistics Quarterly. — affectation optimale.
10. Khatib O. (1986). *Real-time obstacle avoidance for manipulators and mobile robots.* IJRR. — champs de potentiel.
11. Russell S., Norvig P. (2020). *Artificial Intelligence: A Modern Approach*, 4ᵉ éd., chap. 5–6. — expectimax, minimax, élagage.
12. von Neumann J., Morgenstern O. (1944). *Theory of Games and Economic Behavior.* — jeux à somme nulle, stratégies mixtes ; solution fermée des jeux 2×2.
13. Rubinstein R. Y., Kroese D. P. (2004). *The Cross-Entropy Method.* Springer. — CEM.
14. Salimans T. et al. (2017). *Evolution Strategies as a Scalable Alternative to Reinforcement Learning.* arXiv:1703.03864. — ES antithétique (baseline).
15. Li L., Chu W., Langford J., Schapire R. (2010). *A contextual-bandit approach to personalized news article recommendation.* WWW. — LinUCB.
16. McKelvey R., Palfrey T. (1995). *Quantal Response Equilibria for Normal Form Games.* Games and Economic Behavior. — justification de la randomisation bornée (ablation).
17. Efron B., Tibshirani R. (1993). *An Introduction to the Bootstrap.* — intervalles de confiance ; Cliff N. (1993) *Dominance statistics.* — taille d'effet.
18. Law A. M. (2015). *Simulation Modeling and Analysis*, chap. 11. — nombres aléatoires communs.

---

## 15. Écarts d'implémentation et réglages

Cette section recense les écarts **délibérés** entre la spécification (§1–§12) et le code livré, avec leur motif (mesures des rapports de correction, réalisme, coût), puis les valeurs par défaut qui diffèrent du tableau du §2. Règle de lecture inchangée (§13) : en cas de doute, `src/core/params.ts` et `src/core/types.ts` font foi.

### 15.1 Moteur et règles (§1, §3)

| Réf. | Spécification | Implémentation | Motif |
|---|---|---|---|
| §1, §13.2 | 11 joueurs décidés tous les 0,1 s (décalage) | les 22 décisions au même cycle de 0,2 s | latence mesurée sous le budget (mean 2,1–2,5 ms, p95 4,5–4,9 ms par cycle) |
| §3.1 | pas de temps de réaction simulé | `physics.playerReactionTime` = 0,25 s avant de suivre une nouvelle cible, et **lissage de direction** τ_steer = `physics.steeringTau` = 0,3 s (retard du premier ordre sur la vitesse désirée, `Player.steerVel`), appliqué à tous les joueurs, pas seulement hors-ballon (§7.2) ; la norme de la vitesse lissée reste bornée par le profil de freinage | trajectoires sans zigzag ; le sprint de 20 m reste dans 2,8–4,5 s (l'accélération bornée domine) |
| §3.4 | gel 1 s (2 s après but) ; adversaires à ≥ 3 m | `restartFreeze` 1,5 s, `kickoffFreeze` 1,5 s, `goalFreeze` 3 s ; adversaires replacés à ≥ `physics.restartClearance` = 3 m du ballon et, sur une **sortie de but, hors de la surface de réparation** (loi 16) | sans ce replacement, la relance de 2–3 m du gardien était interceptée devant le but vide (buts à xG ≈ 0,9) |
| §3.3 | — | tir contré (`block`) distinct du tacle ; déclenchement des duels par vitesse de rapprochement / contact continu ; ballons aériens (lob, dégagement) avec atterrissage amorti (`lobLandingSpeed`, `lobBounce`) | réalisme des duels et des ballons longs (rapport moteur) |

### 15.2 Porteur de balle (§5, §6)

| Réf. | Spécification | Implémentation | Motif |
|---|---|---|---|
| §5.3, §6.2 | durée d'un dribble T_a = d / v_drib | T_a = `dribbleTime` (accélération bornée depuis la vitesse courante projetée, plafond v_drib, sans réaction) — même modèle que §5.3 ; l'engagement `committedUntil` suit | un départ arrêté n'était pas facturé (+0,6 s de marge pour le dribble) |
| §6.1 | `through` : garder les 8 plus petits W | garder les 8 meilleurs EV₁ après élagage W > 0,8 ; cibles polaires de danger (distances {8, 16, 24, 32} m × ±60°) dédoublonnées à 1 m | EV₁ contient déjà (1 − P_int) et la valeur |
| §4.6 | $P_{int} = 1 - \prod_m \prod_j (1 - \eta\,\Phi_{j,m})$, $\eta = 0{,}35$, $T_j$ = temps au point exact | **une chance par défenseur** $P_{int} = 1 - \prod_j (1 - \eta\,\Phi_j)$, $\Phi_j = \max_m \varphi_{j,m}$ (`interceptWindow` = 0) ; distance à courir réduite de $r_{ctl}$ (`timeToReach`) ; grille §11.6 (6 matchs × 5 min, graines 300–305) : Brier de $P_{pass}$ 0,2032 à $(\eta, \sigma_T) = (0{,}35 ; 0{,}4)$ contre 0,1981 au minimum de la grille $(0{,}30 ; 0{,}3)$ — objectif plat (Δ < 0,005, sous l'écart entre deux auto-jeux sur les mêmes graines, 0,19–0,22) : $\eta = 0{,}35$ et $\sigma_T = 0{,}4$ conservés (valeurs auxquelles le modèle rapide hors-ballon `quickPassProbability`, encore en produit par échantillon, et les tests de quasi-égalité sont réglés ; l'alignement de `quickPassProbability` sur « une chance par défenseur » a été essayé et **rejeté** : sur 12 matchs × 4 graines, il double les fenêtres sans événement de plus de 20 s — 8 → 16, la plus longue 48 → 73 s — car des lignes jugées moins fermées incitent moins les joueurs sans ballon à se démarquer, même s'il rapproche tirs et buts des cibles, 7,0 → 5,6 et 2,0 → 1,2 par équipe) ; $w = 1$ toujours moins bon (Brier +0,004 à +0,03). Le critère « $P_{int}$ seule contre prise adverse » préfère $\eta \approx 0{,}6$ et $\sigma_T$ grand parce que 29 % des passes sans menace ($W < 0{,}2$) sont quand même prises : ce sont des réceptions manquées, pas des interceptions de ligne | sur 1114 décisions, la meilleure passe au sol valait $P$ = 0,34 en moyenne (0,70 sans interception) ; un ballon de 41 m sans adversaire à 25 m valait $P_{int} \approx 1$ ; les cinq scénarios de renversement à 0 % |
| §5.1 | $-0{,}04\,d - 0{,}02\max(0,d-30)$ ; $s_{arr} \in \{4,6,9\}$ ; $q_r = p_r + v_r T_b$ | termes de distance $-0{,}03\,d - 0{,}01\max(0, d-30)$ (**demi-pas** vers le réajustement §11.6, qui donne $-0{,}02\,d$ et 0 au-delà de 30 m, puis $-0{,}005\,d$ à l'itération suivante : la réussite observée dans le moteur dépend peu de la distance — 0–10 m 76 %, 10–20 m 64 %, 20–30 m 74 %, 30+ m 74 % — parce que les échecs sont surtout des réceptions manquées ; le pas complet n'est pas un point fixe de l'auto-jeu (biais de sélection : seules les passes que le modèle aime sont jouées) et ramenait le banc de scénarios à 65 %) ; terme $-0{,}1\max(0, s_{arr}-9)$ (`pass.arrivalSpeed`) ; $\beta_{lob}$ = `pass.lobPenalty` = −1,5 (lobs réussis à 16 % contre 42 % prédits sans ce terme) ; cible anticipée bornée à la cible de déplacement du receveur ; modèle de profondeur §5.2 inchangé (son réajustement — base 1,8 → 2,1–2,3 — rendait la profondeur de 38 m préférable à une passe sûre à 78 % en style possession) | Brier par distance 0,240 → 0,154 au-delà de 30 m ; fiabilité mesurée : prédit 0,75 → observé 0,75, 0,85 → 0,85, mais 0,45–0,65 → 0,58–0,81 (encore pessimiste au milieu) |
| §6.1 | passe : 3 vitesses, lob seulement si la ligne est fermée et $d > 25$ m | **cible longue** ($d$ > `decision.longPassDistance` = 25 m) : passe appuyée ($s_{arr}$ = 10 m/s, plus grande de `passArrivalSpeeds` = {4, 6, 9, 10}) ET lob toujours évalués, ligne fermée ou non (`planPassVariants`) ; le lob est un candidat distinct (≤ 10 de plus, total ≤ 47) ; 12 m/s exclu : `physics.controlMaxRelSpeed` = 12 est une inégalité stricte à la prise de balle et le bruit de vitesse ±5 % ferait échouer la réception | un renversement de 40 m en ballon roulant à 6 m/s met 4,3 s ; le driven à 10 m/s 3,0 s |
| §6.1 | toute passe vers un coéquipier est candidate | une passe au sol dont la **course résiduelle** (portée s₀²/2μ au-delà de la cible) franchirait sa propre ligne de but entre les poteaux ± `decision.ownGoalMargin` = 1 m n'est pas proposée (`rollsIntoOwnGoal`, aussi pour la relance du gardien) | 4 buts contre son camp du gardien en 5 matchs (relance de 1,5 m vers un défenseur collé au but, ballon roulant jusque dans le filet) |
| §6.2 | coût d'opportunité de la possession Θ(b) sur le tir seul | composante « possession » = −(1 − P)·w_poss·Θ(b) sur **toutes** les actions, w_poss = `wPossession`·(1,6 − 1,2·riskTolerance) avec `wPossession` = 1,0 ; tir : `wShotPossession` = 0,4 ; plancher xG_min = `shotMinXg` = 0,06 | sans ce terme, une perte dans le camp adverse ne coûte que L(q⁻) ≈ 0,005 et les passes à 50 % battent les passes sûres ; 19 tirs sur 38 avaient xG < 0,08 |
| §6.3 | 𝓡 = {hold, press, cover, drop}, contrôle recalculé sur un patch 10 × 10 ; jeu réduit régénéré sous chaque réponse | 𝓡 complet (`responseCount` = 4, minimum 2 = hold + press), déplacements bornés par la cinématique §4.1 (`displaceToward`) ; Θ_r = xT(q⁺)·PC(q⁺) **ponctuel exact** sur l'état ajusté (pas de patch) ; sous r ≠ hold, les `responseReevaluate` = 4 meilleures suites trouvées sous hold sont ré-évaluées sur s⁺_{a,r} (0 = régénération complète) ; δ = Θ_hold − Θ_r peut être **négatif** pour cover/drop ; Q = EV₁ − P·δ + P·γ·max(0, 𝓖(a, r*)) ; une suite « tir » est comparée au tir immédiat | 3,8 ms par décision au lieu de 7,2 ms avec régénération complète (bench sur 80 états) ; la sous-estimation de 𝓖 est dans le sens pessimiste |
| §6.4 | réponses {press, cover} selon la paire ; tirage à chaque cycle possible | réponses {press, cover} pour toute paire de classes ; un tir garde Q sous les deux réponses (exécuté avant tout re-ciblage) ; engagement ≥ `gameCommitMin` = 1 s pour dribble / conservation ; jeu non joué lorsque la règle de conservation de l'hystérésis s'applique | §6.4 « pas de re-tirage à chaque cycle » |
| §6.5 | ε = 0,005 ; réponse quantale sur la fenêtre ε ; hystérésis sur toute intention | ε = `epsilonTie` = 0,002 ; **règle de conservation déterministe** : l'intention courante (+ h) est gardée sans re-tirage tant qu'aucun candidat ne dépasse Q(a_cur) + h, le bonus allant au meilleur candidat de la même intention ; `hold` exclu de l'hystérésis | la fenêtre 0,005 était de l'ordre des écarts Q₁ − Q₂ (25 % de décisions hors argmax) ; le re-tirage sur 16 dribbles quasi identiques produisait un zigzag ; une conservation gardée indéfiniment donnait 89 % de possession et 14 passes |
| §6.6 | — | familles « risque + possession » regroupées sous « échec » (l'intercepteur reste nommé) ; phrases « RÉPONSE ADVERSE » et « JEU 2×2 » ; ≤ 12 lignes | lisibilité |
| §6.2 | $C(a) = w_{time} T_a + \ldots$ | **pression du temps de possession** (composante `holdTime`) sur les actions qui gardent le ballon (dribble, conservation) : $C \mathrel{+}= w_{time}\,\kappa\,g\,\min(t_{max}, \max(0, t_{held} - t_0))$, $t_{held}$ = possession continue du porteur (`Player.lastControlTime` du moteur, gel de remise exclu, `heldTime`), $\kappa$ = `holdTimeKappa` = 4, $t_0$ = `holdTimeDelay` = 2 s, $t_{max}$ = `holdTimeMax` = 6 s, porte $g = \operatorname{clip}\big((P_{max} - 0{,}4)/0{,}2\big)$ sur la meilleure passe candidate (`holdTimePassMin/Full`) ; coût **par décision**, indépendant de $T_a$ (une conservation de 0,4 s coûterait sinon trois fois moins qu'un dribble de 1,2 s et « attendre 0,4 s de plus » gagnerait toujours) ; en profondeur 2 le receveur d'une passe repart de $t_{held} = 0$ | « dribble par défaut » (§15.5 « jeu figé ») : un porteur contenu à 4–8 m conduisait le ballon en va-et-vient jusqu'à 37 s alors qu'une passe à $P$ = 0,6–0,8 valait −0,01 à −0,05 contre ≈ 0 pour le dribble ; sans la porte $g$, la pression forçait des passes à $P$ < 0,4 (réussite des passes 68,5 %) |
| §6.2 | $n_{lb}$ sur l'état courant | lignes franchies comptées sur l'**état anticipé** (défenseurs avancés de $T_a$, comme $\Theta$) et avec une marge `lineBreakMargin` = 2 m au-delà de la ligne | un dribble de 4 m vers un défenseur qui contient en reculant « franchissait » sa ligne à chaque cycle (+0,01 à +0,017, l'ordre de grandeur de l'écart entre candidats) |

### 15.3 Sans ballon, défense, gardien (§7, §8)

| Réf. | Spécification | Implémentation | Motif |
|---|---|---|---|
| §7.1 | 24 points à {3, 8, 15} m | `candidateDistances` = {6, 12, 20} m ; composante de **coût de déplacement** −w_move·‖q − p‖ (`wMove` = 0,015) sur tout candidat ; poids supplémentaires `wRun` (0,4 × 2·runFrequency) et `wSupport` (0,1) ; vitesses par intention (`intentSpeed`), vitesse minimale 2 m/s | distance parcourue 2,0–2,2 → 1,1–1,7 km / joueur / 10 min ; stabilité des cibles |
| §7.2 | cible atteinte à 1,5 m ; ré-examen 2 s | l'état « atteint » (≤ 1,5 m) devient le candidat `stay` ; un poste non atteint suit le poste ; après une bascule de possession, la cible défensive précédente garde `hysteresis`·`transitionHysteresis` (0,5) pendant `reexamineEvery` = 2 s ; référence de ballon des postes filtrée à `slotFollowRate` = 5 m/s | 10 joueurs ne se re-ciblent plus au même instant ; churn 0,52–0,63 → 0,3–0,45 /(joueur·s) |
| §7.2 | un coureur par bande de 15 m | `allocateRuns` (coordinateur) : attribution gloutonne par utilité, bande = ⌊(y + W/2)/`runBandWidth`⌋ ; les perdants prennent leur meilleur candidat non-course (repli `hold_shape` sinon) | 21–27 appels doublons par 120 s → 0 |
| §7 / §13 | point de rencontre = re-planifié à chaque cycle | `receiveMeeting` / `meetingStillValid` : l'ancien point est gardé tant que le joueur engagé (cinématique exacte `engagedArrivalTime`, sans réaction) y est avant le ballon et que le nouveau point n'est pas plus tôt de plus de `meetingKeepGain` = 0,5 s | cibles distinctes par passe 2,5 → 1,3 ; passes instables 39 % → 8 % |
| §9.2 | postes instanciés = poste + α·ballon, bornés au terrain | en possession, les postes de champ ont un **plancher** `slotFloorX` = −38 m (repère équipe) | avec followX ≈ 0,5, ballon au gardien ⇒ défenseurs sur leur ligne de but (relances de 2 m, buts contre son camp, interceptions devant le but vide) |
| §8.1 | `contain` à 2 m côté but | `containOffset` 2 m + `containSlack`·(1 − pressIntensity), `containSlack` = 6 (≈ 2 m en pressing haut, 5 m équilibré, 7 m bloc bas) ; tâche tenue sur place sous `standDistance` = 3 m | contraste pressing haut / bloc bas sur la distance du défenseur le plus proche du porteur |
| §8.4 | tâches exécutées à v_max | vitesses de consigne `taskSpeed` (fractions de v_max) : contain 0,7 ; zone 0,3 ; marquage 0,45 + 0,3·priorité ; repli 0,25 + 0,3·recoverPriority ; zone et repli montent linéairement au sprint entre 6 et 20 m de leur point ; press / intercept / chase au sprint | distance parcourue et calme du bloc ; remontée rapide après un dégagement |
| §8.4 | ligne alignée sur x_line pour `recover` seulement | **tenue de ligne** pour marquage et zone : points bornés à x' ≥ ligne du bloc − `lineHoldSlack` (1 m), les attaquants plus profonds sont laissés au hors-jeu ; clé de tâche précédente par `successPoint` | la ligne descendait de 9–21 m sous son poste quel que soit le style |
| §8.1 | interception d'une passe en cours | vol réel du ballon (`elapsed`, `initialSpeed`) dans l'analyse d'interception ; un seul chasseur par équipe ; temps t_j par défenseur ; bisection de `timeToBall` | interceptions fantômes (rapport modèles) |
| §8.6 | sortie sur ballon libre si le gardien arrive le premier | sortie aussi **systématique** lorsque le point de rencontre est dans la surface de but ; appui à 8 m de la ligne en possession ; long ballon crédité à 50 % (duel aérien) ; relance = passe courte vers l'un des 3 défenseurs (P × menace) hors passes `rollsIntoOwnGoal` | un centre au sol traversait les six mètres sans réaction du gardien |
| §9.1 | postes normalisés | postes en mètres avec `followX`/`followY` par poste ; Λ = 45 − 25·compacité ; y × (0,7 + 0,6·widthUsage) | déjà signalé §9.1 / §13.3 |
| §7.1 | $U_i$ fixe | **soutien urgent** : le coordonnateur calcule une fois par cycle le contexte du porteur (`DecisionInput.carrier` : $t_{held}$, $P_{max}$ du modèle rapide, urgence $u = 1 + (u_{max} - 1)\max(f_t, f_P)$, $f_t = \operatorname{clip}((t_{held} - 2)/3)$, $f_P = \operatorname{clip}((0{,}6 - P_{max})/0{,}6)$, `supportUrgency*`, $u_{max}$ = 3) ; les coéquipiers à moins de 30 m reçoivent la composante `urgency` $= w_{urg}(u - 1)\,G(\|q - b\| ; d_{sup})\,P_{pass}(b \to q)$ ($w_{urg}$ = `wSupportUrgency` = 0,4 : à la distance de soutien ET sur une ligne ouverte), leurs poids $w_4$ (poste) et $w_5$ (séparation) sont divisés par $1 + (u - 1)$ (`supportUrgencyRelax` = 1) et la laisse des défenseurs de repos (5 m) est multipliée par $u$ | dans les fenêtres figées, les 2 coéquipiers les plus proches étaient à 20–30 m : la séparation (le porteur compte dans la somme : −0,155 à 11 m), le rappel au poste et le coût de déplacement l'emportaient sur le bonus de soutien (+0,1 au mieux) ; sans relâchement, l'urgence seule ne rapprochait personne (26 fenêtres contre 7) |
| §8.2 | 5 conditions, seuil $n_{trig}$ | **déclencheur « porteur bloqué »** : $t_{held}$ > `pressHoldTime` = 3 s et $\max_a P_{pass}$ < `pressHoldPass` = 0,75 ⇒ pressing quel que soit $n_{trig}$ (le défenseur qui contenait s'engage, le duel §3.3 tranche) | un bloc bas (n_trig = 3) contenait à 5–7 m un porteur sans solution indéfiniment |

### 15.4 Protocole et tests (§11, §12)

- Le test de bloc tactique (`tests/defence.test.ts`) mesure la hauteur de ligne sur **trois** matchs de 120 s (graines 21–23) et compare les moyennes : sur une seule graine, la hauteur mesurée dépend surtout de la position du ballon pendant les rares phases défensives du pressing haut (écart de 3 m à 25 m selon la graine).
- Le test « 600 s avec la décision factice » vérifie la vie du match par les compteurs cumulés (`turnovers`) et non par le journal `events`, borné à 200 entrées : la politique factice « passe au plus proche » finit par boucler entre deux joueurs.
- `scripts/scenarios.ts` : 26 scénarios manuels (0 générés), 4 graines, horizon 6 s ; accord top-1 **71,2 %** (réservés 75,0 %), contre 58,7 % avec l'interception en produit par échantillon (§4.6, §15.2) : `keeper_distribution`, `through_ball_high_line`, `striker_between_lines`, `overlap_left_cross` passent de 0–50 % à 100 %. Scénarios encore à 0 % : `switch_of_play` et `long_diagonal_switch` demandent un ballon de 44–52 m ; le lob du moteur (tir à 45°, `lobKinematics`) met 3,25 s sur 52 m, assez pour qu'un défenseur à 17 m rejoigne le receveur (un lob tendu à 30° mettrait 2,5 s sous le même plafond de 25 m/s), et le receveur d'un ballon aérien attend au **point visé** (`receiveMeeting`, src/decision/loose.ts) sans suivre le point de chute réel (bruit d'exécution de 2–3 m, puis 4 m de roulement), d'où 16 % de lobs réussis : ces deux limites sont hors de la couche décision ; `cross_or_recycle`, `shot_from_distance_or_pass`, `press_trigger`, `no_pass_option`, `back_pass_under_pressure` (réservé) tiennent au classement dribble / profondeur, non à l'interception.
- Calibration §11.6 (`scripts/calibrate.ts`, 6 matchs × 5 min, graines 300–305, exécution séquentielle avec collecte des caractéristiques d'interception par passe) : l'appariement des issues attribuait `pass_intercepted` à l'équipe de l'intercepteur (convention du moteur, frappeur dans `targetId`) au lieu du passeur — tables de fiabilité plates et pente de Platt 0,05 avant correction. Après correction et avec les réglages retenus : 368 passes, réussite observée 70,4 %, Brier 0,2032 (Platt 0,1910), ECE 0,099 ; par distance (observé / prédit) : 0–10 m 76 % / 0,72, 10–20 m 64 % / 0,65, 20–30 m 74 % / 0,54, 30+ m 74 % / 0,44 (le réajustement complet des termes de distance donnerait 0,76 / 0,76 / 0,69 / 0,62, non adopté : §15.2). Le recalcul de $P_{pass}$ à partir des caractéristiques enregistrées reproduit exactement la probabilité annoncée par la décision (écart moyen 0,000).
- Interrupteurs de dégradation (§12) : non implémentés (le p95 mesuré reste < 5 ms) ; `responseCount` et `responseReevaluate` en tiennent lieu manuellement.

### 15.5 État mesuré (6 matchs de 10 min, graines 1–2, paires équilibré / possession–contre / pressing haut–bloc bas)

Cibles atteintes : possession 42–58 % (69/31 pour possession–contre, voulu) ; passes 46–90 par équipe ; longueur moyenne de passe 13,7–18,8 m ; tacles 4–13 ; remises en jeu 0–9 par équipe ; distance 1,1–1,7 km / joueur ; plus proche coéquipier 10–15 m ; gardien à 6,7–7,4 m de son but (> 20 m dans ≤ 1 % des cycles) ; ligne défensive en phase défensive −12 à −32 m (pressing haut −12/−17 vs bloc bas −27/−32) ; étendue x du bloc en défense 35–44 m ; changements de cible 0,19–0,43 /(joueur·s) ; changements d'intention du porteur 0,36–0,57 /s ; latence par cycle mean 2,1–2,5 ms, p95 4,5–4,9 ms ; part de passes en profondeur 15–17 % (possession) contre 40–42 % (contre).

Cibles manquées, dans l'ordre d'importance, avec la cause identifiée : **buts** 1–3 par équipe (moyenne 2,0 ; cible 0,2–1,0) et **tirs** 3–11 (moyenne 6,8 ; cible 1–4) avec xG moyen par tir 0,12–0,57 : les tirs sont pris à moins de 8 m du but après des entrées de surface non contestées (défense qui laisse recevoir dans les six mètres ; deux buts sur des passes en retrait qui roulent jusque dans le but) — cause structurelle (défense de surface, marquage dans la surface), pas un réglage local ; **dribbles** 11–36 tentatives (moyenne 20,5 ; cible 3–12) et **mix des décisions distinctes du porteur** passes 15–42 % / dribbles 36–62 % / conservations 4–30 % / tirs 1–4 % (cible : passes ≥ 50 % et dribbles ≤ 25 % des décisions hors conservation) : chaque segment de conduite de 4–8 m est une décision, et un dribble est choisi dès qu'aucune passe à P ≥ 0,8 n'existe ; **interceptions** 13–26 (moyenne 19,8) et **pertes** 21–36 (moyenne 28,9) (cibles 2–10 et 8–22) ; distance du défenseur le plus proche du porteur, pressing haut 3,8–4,5 m contre bloc bas 3,9–4,4 m : contraste faible et non ordonné sur les deux graines.

**Après la révision de l'interception (§4.6 « une chance par défenseur », §5.1, §6.1 cibles longues, §15.2)**, mêmes 6 matchs : réussite des passes 56–77 %, moyenne **70,3 %** (67,3 % avant ; cible 70–88 %, 8 équipes-matchs sur 12 dans la cible, les deux équipes en style contre-attaque à 56–57 % avec 39–52 % de passes en profondeur) ; interceptions 19,8 (20,6 avant) ; pertes 28,9 (31,3) ; part de profondeur 26 % (29 %) ; dribbles 20,5 (22,0) ; tirs 6,8 (5,6) ; buts 2,0 (1,9) ; latence par cycle mean 2,9–3,5 ms, p95 5,6–6,8 ms (banc sur 100 états générés : mean 5,5 ms, p95 8,2 ms, contre 5,7 / 8,5 avant). Ce qui bloque encore **interceptions** et **pertes** n'est plus le modèle de décision : le compteur `pass_intercepted` du moteur compte toute prise adverse après une passe, et sur les passes au sol **sans menace de ligne** ($W < 0{,}2$, 60 % des passes) 17 % finissent quand même chez l'adversaire (28 % avant la borne de la cible anticipée), contre 62 % quand $W \ge 0{,}8$ : ce sont des ballons que le receveur ne recueille pas (le receveur d'un ballon roulant est re-planifié par `receiveMeeting` ; celui d'un ballon aérien attend au point visé), puis ramassés par l'adversaire — couche sans ballon et moteur, hors §4.6–§6.1.

**Validation indépendante de la révision de l'interception** (mêmes paires, graines 1–4, journaux complets, avant la correction du jeu figé ci-dessous) : aucun but contre son camp, gardien jamais à plus de 20 m de son but, aucun lob sorti du terrain. Deux effets de bord mesurés : (1) les **lobs** ont presque disparu (43 joués / 5 réussis sur 6 matchs avant la révision, 3 / 0 après : `pass.lobPenalty` = −1,5 et la variante appuyée les dominent) ; (2) **jeu figé** : la plus longue fenêtre sans événement passe de 15–19 s par match (avant la révision) à 24–48 s dans la paire possession–contre (8 fenêtres > 20 s sur 12 matchs — graines 1–4 —, contre 0 sur les 6 matchs des graines 1–2 avant la révision) — un attaquant isolé à la touche (y ≈ ±31 m) conduit le ballon en va-et-vient de 4 m, le défenseur le plus proche le contient à 4–8 m sans engager, ses coéquipiers restent 15–55 m derrière et les meilleures passes (P = 0,66–0,79, 40 m en retrait) ont un score −0,01 à −0,06 (risque, longueur, possession) contre ≈ 0 ± 0,005 pour les dribbles latéraux : c'est la cause structurelle « dribble par défaut » ci-dessus, rendue plus fréquente par des P de passe moins pessimistes sans soutien plus proche (§7.1 : soutien / démarquage).

**Jeu figé — mesure et correction, dernière étape (sonde : mêmes 6 matchs, fenêtres où la même équipe garde le ballon sans passe, tir ni dégagement).** Avant : 63 fenêtres > 8 s (10 > 20 s, la plus longue 36,6 s), toutes du même type — porteur contenu à 3–6 m (souvent à la touche), va-et-vient de 4 m, 2 coéquipiers les plus proches à 20–30 m, meilleure passe $P$ = 0,3–0,7 à −0,01…−0,05 contre ≈ 0 ± 0,02 pour les dribbles latéraux (dont +0,01 de « ligne franchie » à chaque cycle) ; décisions du porteur : dribble 53 %, conservation 20 %, passe 24 %. Après (pression du temps de possession §15.2, soutien urgent et déclencheur « porteur bloqué » §15.3) : **0 fenêtre > 8 s** ; passes 74,8 → 97,4 par équipe et 10 min (réussite 70,8 → 70,0 %, part des passes jouées à $P$ < 0,5 : 27 → 26 %), dribbles (prises à défaut) 20,5 → 15,2, interceptions 19,8 → 27,0, pertes 28,9 → 34,3 (pertes hors interception 9,1 → 7,3), tirs 6,8 → 5,7, buts 2,0 → 1,8 ; décisions du porteur : passe 38 %, dribble 40 %, conservation 18 %. Ablations (6 matchs) : sans pression du temps 77 fenêtres ; sans soutien urgent 2 fenêtres mais 2 coéquipiers à 21 m et P moyenne des passes inchangée ; sans porte $g$ 0 fenêtre mais réussite 68,5 % et pertes 37 ; pression proportionnelle à $T_a$ (première forme) : la conservation de 0,4 s devenait l'action la moins chère (fenêtres de 8–12 s « conservation » à 24 m du but). Le supplément d'interceptions est entièrement le supplément de passes (26–27 % d'échec par passe dans toutes les variantes, la réception manquée du moteur §15.5 ci-dessus) : la cible « interceptions 2–10 » reste hors de portée de la couche décision tant que le moteur perd 17 % des passes sans menace. Latence inchangée (même machine, avant → après) : par cycle en match moyenne 2,6 → 2,5 ms, p95 5,1 → 5,6 ms ; banc sur 100 états générés moyenne 5,8 → 5,6 ms, p95 8,3 → 7,7 ms (274 tests). Banc de scénarios 71,2 → 69,2 % (`dribble_isolated_defender` perd son dribble de 4 m au profit de la conservation — 0,009 contre 0,006 — depuis la marge des lignes franchies ; `no_pass_option` 0 → 50 %, `long_diagonal_switch` 0 → 50 %).
