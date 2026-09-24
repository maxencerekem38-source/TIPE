/**
 * Géométrie et probabilité d'interception d'une trajectoire de balle (docs/CONCEPTION.md §4.6).
 *
 * Pour une trajectoire b → q on échantillonne M points q_m aux temps balle T_b(q_m) ; pour chaque
 * adversaire j, φ_{j,m} = logit⁻¹((T_b(q_m) − T_j(q_m))/σ_T) est la probabilité qu'il arrive à temps au point m.
 * **Une chance par défenseur** : Φ_j = max_m φ_{j,m} (son meilleur point de la ligne, élargi aux échantillons voisins
 * ±w si models.interceptWindow = w > 0 : Φ_j = 1 − Π_{|m − m*| ≤ w} (1 − φ_{j,m})), puis
 *   P_int = 1 − Π_j (1 − η Φ_j).
 * L'ancienne agrégation Π_m Π_j traitait les 12 échantillons d'un MÊME défenseur comme des chances indépendantes :
 * un défenseur qui court à côté d'une passe lente (φ ≈ 1 sur tous les points) donnait 1 − 0,65¹² = 0,994 alors qu'il
 * ne dispose physiquement que d'une tentative (le moteur n'affecte d'ailleurs qu'un intercepteur par équipe).
 * Borne conservée : P_int^(η = 1) ≥ W = max_{j,m} φ_{j,m}. η et σ_T sont calibrés sur les issues du moteur (§11.6,
 * scripts/calibrate.ts : grille η × σ_T minimisant le Brier de P_pass).
 *
 * Ballons aériens (lob, dégagement) : le vol est celui du moteur (`lobFlight`, tir à 45°) ; un échantillon n'est
 * interceptable que si la hauteur z(f) = 4·apex·f·(1 − f) est inférieure à physics.controlMaxHeight (même
 * condition que la prise de balle du moteur), et l'atterrissage (f = 1) est une chance supplémentaire de
 * disputer le ballon retombé (efficacité η_land, fenêtre de temps t_land après le contact au sol, §4.6) ; la chance
 * effective d'un défenseur est alors max_m η_m φ_{j,m} avec η_m ∈ {η, η_land} selon l'échantillon.
 */
import type { Vec2 } from '../core/vec2';
import { projectOnSegment, angleBetween, sub, len } from '../core/vec2';
import type { BallFlightKind, MatchState, Player, SimParams, TeamId } from '../core/types';
import { attackDir } from '../core/types';
import { ballTravelTime, launchSpeed, lobFlight, lobHeightAt, runTime } from './motion';

export interface InterceptionSample {
  point: Vec2;
  ballTime: number;
  /** Meilleur adversaire (id) et son temps d'arrivée. */
  opponentId: number;
  opponentTime: number;
  /** Probabilité d'arrivée à temps de cet adversaire (sigmoïde de la différence de temps). */
  phi: number;
}

export interface InterceptionAnalysis {
  /** Probabilité globale d'interception sur la trajectoire. */
  pIntercept: number;
  samples: InterceptionSample[];
  /** Adversaires dont φ ≥ 0,2 sur au moins un échantillon (pour la visualisation). */
  threats: number[];
  /** Vitesse initiale utilisée et temps de trajet total. */
  initialSpeed: number;
  travelTime: number;
  /** Point faible de la ligne W = max_{j,m} Φ_{j,m} (§4.6) : feature d'explication et borne inférieure de P_int (η = 1). */
  weakPhi: number;
  weakSampleIndex: number;
  weakOpponentId: number;
  /** Avance (s) de l'adversaire du point faible sur le ballon : T_b − T_j (> 0 : il arrive avant le ballon). */
  weakLead: number;
  /** Adversaires (ids, ordre de `state.players`) et leur meilleure chance Φ_j = max_m φ_{j,m} (élargie ±w) — une chance par défenseur (§4.6). */
  defenderIds: number[];
  defenderPhi: number[];
}

/**
 * Caractéristiques brutes d'une trajectoire pour la calibration (§11.6) : avances Δ_{j,m} = T_b^{eff}(q_m) − T_j(q_m) (s)
 * par défenseur et par échantillon (NaN si l'échantillon n'est pas interceptable), échantillon d'atterrissage (ballon
 * aérien : efficacité η_land). `rescoreInterception` recalcule P_int pour d'autres (η, σ_T, w, η_land) sans rejouer le match.
 */
export interface InterceptionFeatures {
  samples: number;
  defenderIds: number[];
  /** Δ_{j,m}, ligne j = défenseur, colonne m = échantillon (longueur defenderIds.length × samples). */
  deltas: number[];
  /** landing[m] = 1 si l'échantillon m est l'atterrissage d'un ballon aérien. */
  landing: number[];
  travelTime: number;
}

/** Paramètres d'agrégation de l'interception (sous-ensemble de ModelParams, valeurs explicites). */
export interface InterceptionModel { eta: number; etaLand: number; sigma: number; window: number }

export function interceptionModelOf(params: SimParams): InterceptionModel {
  const m = params.models;
  return {
    eta: m.interceptEfficiency,
    etaLand: m.interceptLandingEfficiency ?? DEFAULT_LANDING_EFFICIENCY,
    sigma: Math.max(1e-6, m.arrivalSigma),
    window: Math.max(0, Math.floor(m.interceptWindow ?? DEFAULT_WINDOW)),
  };
}

/** Trajectoire déjà en cours (ballon libre) : `from` est alors l'origine de la frappe, `elapsed` le temps écoulé depuis. */
export interface LiveFlight {
  /** Temps écoulé depuis la frappe (s) : les échantillons déjà dépassés par le ballon ne sont plus interceptables. */
  elapsed: number;
  /** Vitesse initiale réellement imprimée (ballon roulant, avec le bruit d'exécution) ; ignorée pour un ballon aérien. */
  initialSpeed?: number;
}

/** Seuil de φ à partir duquel un adversaire est signalé comme menace. */
const THREAT_PHI = 0.2;
/** Efficacité de la chance d'atterrissage d'un ballon aérien (repli si models.interceptLandingEfficiency est absent). */
const DEFAULT_LANDING_EFFICIENCY = 0.6;
/** Fenêtre (s) après l'atterrissage pendant laquelle le ballon retombé reste disputable près du point de chute (repli). */
const DEFAULT_LANDING_WINDOW = 0.3;
/** Demi-largeur (échantillons) de la fenêtre autour du meilleur point d'un défenseur (repli si models.interceptWindow est absent) : 0 = son meilleur point seul. */
const DEFAULT_WINDOW = 0;

/** Tampons réutilisés (aucune allocation par appel) : φ_{j,m} et η_m ; agrandis à la demande. */
let phiBuf = new Float64Array(22 * 16);
let maxPhiBuf = new Float64Array(22);
const ensurePhiBuf = (n: number): Float64Array => (phiBuf.length < n ? (phiBuf = new Float64Array(n)) : phiBuf);
const ensureMaxPhiBuf = (n: number): Float64Array => {
  if (maxPhiBuf.length < n) maxPhiBuf = new Float64Array(n);
  maxPhiBuf.fill(0, 0, n);
  return maxPhiBuf;
};

/**
 * Chance effective d'un défenseur sur la ligne à partir de ses chances par échantillon c_m = η_m φ_{j,m} (§4.6) :
 * son meilleur échantillon m*, élargi aux échantillons |m − m*| ≤ w : 1 − Π (1 − c_m). Avec w = 0 : max_m c_m.
 */
function defenderChance(chances: ArrayLike<number>, offset: number, M: number, window: number): number {
  let best = -1, bestM = 0;
  for (let m = 0; m < M; m++) { const c = chances[offset + m]; if (c > best) { best = c; bestM = m; } }
  if (best <= 0) return 0;
  if (window <= 0) return best;
  let survive = 1;
  const lo = Math.max(0, bestM - window), hi = Math.min(M - 1, bestM + window);
  for (let m = lo; m <= hi; m++) survive *= 1 - chances[offset + m];
  return 1 - survive;
}

/**
 * logit⁻¹ à l'échelle d'une loi logistique d'écart-type 1 : 1/(1 + e^{−πz/√3}) (§4.6).
 * z = (T_ball − T_j)/σ_T ; z > 0 ⇔ l'adversaire arrive avant le ballon.
 */
export const arrivalLogistic = (z: number): number => 1 / (1 + Math.exp((-Math.PI / Math.sqrt(3)) * z));

/**
 * Temps (s) qu'il faut à un défenseur pour être à portée de prise de balle du point q_m (§4.6) : même cinématique que
 * §4.1 (réaction τ_r puis course), mais la distance à courir est réduite du rayon de prise de balle r_ctl du moteur
 * (§3.3 : « tout joueur à moins de r_ctl du ballon prend le contrôle ») — un défenseur à 0,8 m de la ligne n'a pas à
 * courir jusqu'au point exact, il y est déjà (φ ≈ 1), ce que le modèle sans rayon notait φ ≈ 0,45.
 */
export function timeToReach(o: Player, q: Vec2, reach: number, models: SimParams['models']): number {
  const tau = models.reactionTime;
  const dx = q.x - (o.pos.x + tau * o.vel.x);
  const dy = q.y - (o.pos.y + tau * o.vel.y);
  return tau + runTime(Math.max(0, Math.sqrt(dx * dx + dy * dy) - reach), o.maxSpeed, o.maxAccel);
}

export interface FlightModel {
  initialSpeed: number;
  travelTime: number;
  /** Temps balle au point d'abscisse curviligne f·d. */
  timeAt: (f: number) => number;
  aerial: boolean;
  /** Hauteur (m) du ballon à la fraction f du trajet (0 pour un ballon au sol). */
  heightAt: (f: number) => number;
}

/**
 * Modèle de vol d'un ballon selon le type de frappe : vitesse initiale, durée totale, temps et hauteur au point
 * d'abscisse curviligne f·d. `initialSpeed` (ballon roulant) remplace la vitesse de lancement calculée depuis
 * `arrivalSpeed` (trajectoire en cours, vitesse réellement imprimée).
 */
export function flightModel(kind: BallFlightKind, distance: number, params: SimParams, arrivalSpeed?: number, initialSpeed?: number): FlightModel {
  const ph = params.physics;
  const d = Math.max(0, distance);
  const ground = (): number => 0;
  switch (kind) {
    case 'shot': {
      const s0 = ph.shotSpeed;
      const T = d / s0;
      return { initialSpeed: s0, travelTime: T, timeAt: (f) => f * T, aerial: false, heightAt: ground };
    }
    case 'lob':
    case 'clearance': {
      // Ballon aérien : même cinématique que le moteur (tir à 45°, `lobFlight`), vitesse horizontale constante.
      const lf = lobFlight(d, ph);
      const T = lf.travelTime;
      return { initialSpeed: lf.initialSpeed, travelTime: T, timeAt: (f) => f * T, aerial: true, heightAt: (f) => lobHeightAt(lf.apex, f) };
    }
    default: {
      // Ballon au sol (passe, passe en profondeur, ballon libre) : décélération constante μ.
      const sArr = arrivalSpeed ?? (kind === 'through' ? ph.throughArrivalSpeed : ph.passArrivalSpeed);
      const s0 = initialSpeed !== undefined && initialSpeed > 0 ? initialSpeed : launchSpeed(d, sArr, ph);
      const T = ballTravelTime(d, s0, ph);
      return { initialSpeed: s0, travelTime: T, timeAt: (f) => ballTravelTime(f * d, s0, ph), aerial: false, heightAt: ground };
    }
  }
}

/**
 * Analyse d'interception d'une passe de `from` vers `to` jouée par `team`
 * (les adversaires de `team` tentent d'intercepter).
 * `kind` : 'pass'/'through'/'loose' = ballon roulant (vitesse de lancement issue de `arrivalSpeed`
 * ou de physics.passArrivalSpeed / throughArrivalSpeed) ; 'lob'/'clearance' = ballon aérien interceptable
 * seulement quand il vole sous physics.controlMaxHeight, plus la chance d'atterrissage ; 'shot' = ligne droite à physics.shotSpeed.
 * `live` : trajectoire déjà en cours (`from` = origine de la frappe) — les temps balle sont mesurés depuis maintenant
 * (T_b − elapsed) et les points déjà dépassés ne sont plus interceptables.
 */
export function analyseInterception(state: MatchState, from: Vec2, to: Vec2, kind: BallFlightKind, team: TeamId, params: SimParams, arrivalSpeed?: number, live?: LiveFlight): InterceptionAnalysis {
  const m = params.models;
  const M = Math.max(1, Math.floor(m.interceptSamples));
  const model = interceptionModelOf(params);
  const landingWindow = m.interceptLandingWindow ?? DEFAULT_LANDING_WINDOW;
  const maxHeight = params.physics.controlMaxHeight;
  const reach = params.physics.controlRadius;
  const invSigma = 1 / model.sigma;
  const dx = to.x - from.x, dy = to.y - from.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const flight = flightModel(kind, d, params, arrivalSpeed, liveInitialSpeed(kind, live));
  const elapsed = live ? Math.max(0, live.elapsed) : 0;

  const players = state.players;
  const opponents: Player[] = [];
  for (let k = 0; k < players.length; k++) if (players[k].team !== team) opponents.push(players[k]);
  const nOpp = opponents.length;
  const chances = ensurePhiBuf(nOpp * M); // c_{j,m} = η_m φ_{j,m}
  const phis = ensureMaxPhiBuf(nOpp); // Φ_j = max_m φ_{j,m} (feature nommée, indépendante de η)

  const samples: InterceptionSample[] = new Array(M);
  let weakPhi = -1, weakSampleIndex = -1, weakOpponentId = -1, weakLead = 0;

  for (let s = 0; s < M; s++) {
    const f = (s + 1) / M;
    const point = { x: from.x + dx * f, y: from.y + dy * f };
    const tb = flight.timeAt(f) - elapsed;
    const landing = flight.aerial && s === M - 1;
    // Ballon au sol : toujours interceptable ; aérien : seulement sous la hauteur de contrôle, ou à l'atterrissage.
    const interceptable = tb >= 0 && (!flight.aerial || landing || flight.heightAt(f) < maxHeight);
    const etaHere = landing ? model.etaLand : model.eta;
    const tbEff = landing ? tb + landingWindow : tb;
    let bestId = -1, bestT = Infinity, bestPhi = 0;
    for (let k = 0; k < nOpp; k++) {
      const o = opponents[k];
      const T = timeToReach(o, point, reach, m);
      const phi = interceptable ? arrivalLogistic((tbEff - T) * invSigma) : 0;
      chances[k * M + s] = etaHere * phi;
      if (phi > phis[k]) phis[k] = phi;
      if (T < bestT) { bestT = T; bestId = o.id; bestPhi = phi; }
      if (phi > weakPhi) { weakPhi = phi; weakSampleIndex = s; weakOpponentId = o.id; weakLead = tbEff - T; }
    }
    samples[s] = { point, ballTime: tb, opponentId: bestId, opponentTime: bestT, phi: bestPhi };
  }

  // Une chance par défenseur : P_int = 1 − Π_j (1 − c_j), c_j = chance effective au meilleur point (élargie ±w).
  let survive = 1;
  const threats: number[] = [];
  const defenderIds: number[] = new Array(nOpp);
  const defenderPhi: number[] = new Array(nOpp);
  for (let k = 0; k < nOpp; k++) {
    survive *= 1 - defenderChance(chances, k * M, M, model.window);
    defenderIds[k] = opponents[k].id;
    defenderPhi[k] = phis[k];
    if (phis[k] >= THREAT_PHI) threats.push(opponents[k].id);
  }

  return {
    pIntercept: Math.min(1, Math.max(0, 1 - survive)),
    samples,
    threats,
    initialSpeed: flight.initialSpeed,
    travelTime: Math.max(0, flight.travelTime - elapsed),
    weakPhi: Math.max(0, weakPhi),
    weakSampleIndex,
    weakOpponentId,
    weakLead,
    defenderIds,
    defenderPhi,
  };
}

/**
 * Caractéristiques brutes (avances Δ_{j,m}) d'une trajectoire, pour la calibration hors-ligne de (η, σ_T, w) (§11.6).
 * Même échantillonnage que `analyseInterception` (sans trajectoire en cours) ; `rescoreInterception(features, model)`
 * avec le modèle courant redonne exactement `analyseInterception(...).pIntercept` (test unitaire).
 */
export function interceptionFeatures(state: MatchState, from: Vec2, to: Vec2, kind: BallFlightKind, team: TeamId, params: SimParams, arrivalSpeed?: number): InterceptionFeatures {
  const m = params.models;
  const M = Math.max(1, Math.floor(m.interceptSamples));
  const landingWindow = m.interceptLandingWindow ?? DEFAULT_LANDING_WINDOW;
  const maxHeight = params.physics.controlMaxHeight;
  const reach = params.physics.controlRadius;
  const dx = to.x - from.x, dy = to.y - from.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const flight = flightModel(kind, d, params, arrivalSpeed);
  const opponents: Player[] = [];
  for (const p of state.players) if (p.team !== team) opponents.push(p);
  const deltas: number[] = new Array(opponents.length * M).fill(NaN);
  const landing: number[] = new Array(M).fill(0);
  for (let s = 0; s < M; s++) {
    const f = (s + 1) / M;
    const point = { x: from.x + dx * f, y: from.y + dy * f };
    const tb = flight.timeAt(f);
    const isLanding = flight.aerial && s === M - 1;
    const interceptable = tb >= 0 && (!flight.aerial || isLanding || flight.heightAt(f) < maxHeight);
    if (isLanding) landing[s] = 1;
    if (!interceptable) continue;
    const tbEff = isLanding ? tb + landingWindow : tb;
    for (let k = 0; k < opponents.length; k++) deltas[k * M + s] = tbEff - timeToReach(opponents[k], point, reach, m);
  }
  return { samples: M, defenderIds: opponents.map((o) => o.id), deltas, landing, travelTime: flight.travelTime };
}

/** P_int recalculée à partir des caractéristiques brutes pour un modèle (η, η_land, σ_T, w) donné (§11.6). */
export function rescoreInterception(features: InterceptionFeatures, model: InterceptionModel): number {
  const M = features.samples;
  const n = features.defenderIds.length;
  const invSigma = 1 / Math.max(1e-6, model.sigma);
  const chances = ensurePhiBuf(n * M);
  let survive = 1;
  for (let k = 0; k < n; k++) {
    for (let s = 0; s < M; s++) {
      const delta = features.deltas[k * M + s];
      const etaHere = features.landing[s] ? model.etaLand : model.eta;
      chances[k * M + s] = Number.isNaN(delta) ? 0 : etaHere * arrivalLogistic(delta * invSigma);
    }
    survive *= 1 - defenderChance(chances, k * M, M, model.window);
  }
  return Math.min(1, Math.max(0, 1 - survive));
}

/** Vitesse initiale à imposer au modèle de vol pour une trajectoire en cours (ballon roulant seulement). */
function liveInitialSpeed(kind: BallFlightKind, live: LiveFlight | undefined): number | undefined {
  if (!live || live.initialSpeed === undefined) return undefined;
  return kind === 'lob' || kind === 'clearance' || kind === 'shot' ? undefined : live.initialSpeed;
}

/**
 * Qualité géométrique d'une ligne de passe (m, élagage §4.6) : minimum sur les adversaires de la
 * distance au segment [from, to] (distance perpendiculaire si la projection tombe dans le segment,
 * sinon distance euclidienne à l'extrémité la plus proche), pondérée par la marge angulaire :
 *   q_j = d_j · (1 + 0,5·min(1, θ_j / 90°)),  θ_j = angle(to − from, p_j − from).
 * À distance perpendiculaire égale, un adversaire vu sous un grand angle depuis le passeur laisse
 * une marge de correction (passe légèrement décalée) et pèse donc moins. Retourne +∞ sans adversaire.
 */
export function passingLaneQuality(state: MatchState, from: Vec2, to: Vec2, team: TeamId): number {
  const lane = sub(to, from);
  let best = Infinity;
  for (const p of state.players) {
    if (p.team === team) continue;
    const proj = projectOnSegment(p.pos, from, to);
    const theta = angleBetween(lane, sub(p.pos, from));
    const q = proj.distance * (1 + 0.5 * Math.min(1, theta / (Math.PI / 2)));
    if (q < best) best = q;
  }
  return best;
}

/**
 * Marge angulaire β_lane (degrés, §4.6) : plus petit angle entre la ligne de passe et la direction
 * d'un adversaire plus proche du passeur que la cible. 180 si aucun adversaire n'est concerné.
 */
export function laneAngularMargin(state: MatchState, from: Vec2, to: Vec2, team: TeamId): number {
  const lane = sub(to, from);
  const d = len(lane);
  let best = Math.PI;
  for (const p of state.players) {
    if (p.team === team) continue;
    const rel = sub(p.pos, from);
    if (len(rel) >= d) continue;
    const a = angleBetween(lane, rel);
    if (a < best) best = a;
  }
  return (best * 180) / Math.PI;
}

/**
 * Lignes défensives (§4.6) : les défenseurs de champ adverses sont triés par abscisse (repère de
 * `team`) ; une ligne est un groupe séparé du suivant par un écart > `gap` m. Retourne l'abscisse
 * moyenne (repère équipe) de chaque ligne, triées croissantes.
 */
export function defensiveLines(state: MatchState, team: TeamId, gap = 6): number[] {
  const dir = attackDir(team);
  const xs: number[] = [];
  for (const p of state.players) if (p.team !== team && p.role !== 'GK') xs.push(dir * p.pos.x);
  xs.sort((a, b) => a - b);
  const lines: number[] = [];
  let start = 0;
  for (let i = 1; i <= xs.length; i++) {
    if (i === xs.length || xs[i] - xs[i - 1] > gap) {
      let s = 0;
      for (let k = start; k < i; k++) s += xs[k];
      lines.push(s / (i - start));
      start = i;
    }
  }
  return lines;
}

/**
 * Nombre de lignes défensives franchies n_lb par une trajectoire from → to (§4.6) : lignes dont
 * l'abscisse moyenne (repère de `team`) est strictement entre x_from et x_to, pour une passe vers l'avant
 * (0 pour une passe en retrait : une ligne recroisée vers l'arrière n'est pas « franchie »).
 */
export function lineBreaks(state: MatchState, from: Vec2, to: Vec2, team: TeamId, gap = 6): number {
  const dir = attackDir(team);
  const x0 = dir * from.x, x1 = dir * to.x;
  if (x1 <= x0) return 0;
  let n = 0;
  for (const x of defensiveLines(state, team, gap)) if (x > x0 && x < x1) n++;
  return n;
}
