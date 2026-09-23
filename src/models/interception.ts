/**
 * Géométrie et probabilité d'interception d'une trajectoire de balle (docs/CONCEPTION.md §4.6).
 *
 * Pour une trajectoire b → q on échantillonne M points q_m aux temps balle T_b(q_m) ; pour chaque
 * adversaire j, Φ_{j,m} = logit⁻¹((T_b(q_m) − T_j(q_m))/σ_T) est la probabilité qu'il arrive à temps ;
 * P_int = 1 − Π_m Π_j (1 − η Φ_{j,m}) (chances séquentielles indépendantes, η calibré par Monte-Carlo).
 */
import type { Vec2 } from '../core/vec2';
import { projectOnSegment, angleBetween, sub, len } from '../core/vec2';
import type { BallFlightKind, MatchState, Player, SimParams, TeamId } from '../core/types';
import { attackDir } from '../core/types';
import { ballTravelTime, launchSpeed, timeToArrive } from './motion';

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
}

/** Accélération de la pesanteur (m/s²), pour le temps de vol approché d'un ballon aérien. */
const GRAVITY = 9.81;
/** Fraction initiale / finale d'un ballon aérien pendant laquelle il est interceptable (au sol ou à hauteur de tête). */
const AERIAL_WINDOW = 0.2;
/** Seuil de φ à partir duquel un adversaire est signalé comme menace. */
const THREAT_PHI = 0.2;

/**
 * logit⁻¹ à l'échelle d'une loi logistique d'écart-type 1 : 1/(1 + e^{−πz/√3}) (§4.6).
 * z = (T_ball − T_j)/σ_T ; z > 0 ⇔ l'adversaire arrive avant le ballon.
 */
export const arrivalLogistic = (z: number): number => 1 / (1 + Math.exp((-Math.PI / Math.sqrt(3)) * z));

/** Modèle de vol d'un ballon selon le type de frappe : vitesse initiale, durée totale et temps au point d'abscisse curviligne f·d. */
export function flightModel(kind: BallFlightKind, distance: number, params: SimParams, arrivalSpeed?: number): { initialSpeed: number; travelTime: number; timeAt: (f: number) => number; aerial: boolean } {
  const ph = params.physics;
  const d = Math.max(0, distance);
  switch (kind) {
    case 'shot': {
      const s0 = ph.shotSpeed;
      const T = d / s0;
      return { initialSpeed: s0, travelTime: T, timeAt: (f) => f * T, aerial: false };
    }
    case 'lob':
    case 'clearance': {
      // Ballon aérien : tir balistique à 45° (v₀ = √(g d), composante horizontale v₀/√2), approximation documentée (hors périmètre §13.6).
      const s0 = Math.min(ph.passSpeedMax, Math.sqrt(GRAVITY * d));
      const T = s0 > 0 ? d / (s0 / Math.SQRT2) : 0;
      return { initialSpeed: s0, travelTime: T, timeAt: (f) => f * T, aerial: true };
    }
    default: {
      // Ballon au sol (passe, passe en profondeur, ballon libre) : décélération constante μ.
      const sArr = arrivalSpeed ?? (kind === 'through' ? ph.throughArrivalSpeed : ph.passArrivalSpeed);
      const s0 = launchSpeed(d, sArr, ph);
      const T = ballTravelTime(d, s0, ph);
      return { initialSpeed: s0, travelTime: T, timeAt: (f) => ballTravelTime(f * d, s0, ph), aerial: false };
    }
  }
}

/**
 * Analyse d'interception d'une passe de `from` vers `to` jouée par `team`
 * (les adversaires de `team` tentent d'intercepter).
 * `kind` : 'pass'/'through'/'loose' = ballon roulant (vitesse de lancement issue de `arrivalSpeed`
 * ou de physics.passArrivalSpeed / throughArrivalSpeed) ; 'lob'/'clearance' = interceptable seulement
 * dans les 20 % initiaux et finaux du vol ; 'shot' = ligne droite à physics.shotSpeed.
 */
export function analyseInterception(state: MatchState, from: Vec2, to: Vec2, kind: BallFlightKind, team: TeamId, params: SimParams, arrivalSpeed?: number): InterceptionAnalysis {
  const m = params.models;
  const M = Math.max(1, Math.floor(m.interceptSamples));
  const eta = m.interceptEfficiency;
  const invSigma = 1 / Math.max(1e-6, m.arrivalSigma);
  const dx = to.x - from.x, dy = to.y - from.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const flight = flightModel(kind, d, params, arrivalSpeed);

  const players = state.players;
  const opponents: Player[] = [];
  for (let k = 0; k < players.length; k++) if (players[k].team !== team) opponents.push(players[k]);
  const threatened = new Uint8Array(opponents.length);

  const samples: InterceptionSample[] = new Array(M);
  let survive = 1; // Π (1 − η Φ)
  let weakPhi = -1, weakSampleIndex = -1, weakOpponentId = -1, weakLead = 0;

  for (let s = 0; s < M; s++) {
    const f = (s + 1) / M;
    const point = { x: from.x + dx * f, y: from.y + dy * f };
    const tb = flight.timeAt(f);
    const interceptable = !flight.aerial || f <= AERIAL_WINDOW || f >= 1 - AERIAL_WINDOW;
    let bestId = -1, bestT = Infinity, bestPhi = 0;
    for (let k = 0; k < opponents.length; k++) {
      const o = opponents[k];
      const T = timeToArrive(o.pos, o.vel, point, o.maxSpeed, o.maxAccel, m);
      const phi = interceptable ? arrivalLogistic((tb - T) * invSigma) : 0;
      survive *= 1 - eta * phi;
      if (phi >= THREAT_PHI) threatened[k] = 1;
      if (T < bestT) { bestT = T; bestId = o.id; bestPhi = phi; }
      if (phi > weakPhi) { weakPhi = phi; weakSampleIndex = s; weakOpponentId = o.id; weakLead = tb - T; }
    }
    samples[s] = { point, ballTime: tb, opponentId: bestId, opponentTime: bestT, phi: bestPhi };
  }

  const threats: number[] = [];
  for (let k = 0; k < opponents.length; k++) if (threatened[k]) threats.push(opponents[k].id);

  return {
    pIntercept: Math.min(1, Math.max(0, 1 - survive)),
    samples,
    threats,
    initialSpeed: flight.initialSpeed,
    travelTime: flight.travelTime,
    weakPhi: Math.max(0, weakPhi),
    weakSampleIndex,
    weakOpponentId,
    weakLead,
  };
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
