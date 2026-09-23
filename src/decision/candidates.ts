/**
 * Génération des candidats du porteur de balle (docs/CONCEPTION.md §6.1).
 *
 * Chaque « proposition » décrit une action possible (passe au pied, passe en profondeur, dribble, tir,
 * conservation, dégagement) avec son point d'arrivée en cas de succès ; l'évaluation (evaluate.ts) lui
 * associe ensuite probabilité, valeur et décomposition. Fonctions pures, sans accès au RNG.
 *
 * Repère : le terrain (origine au centre) ; les directions « vers l'avant » sont exprimées avec attackDir(team).
 */
import type { Vec2 } from '../core/vec2';
import { dist, normalize } from '../core/vec2';
import { PITCH, clampToPitch, distToGoal, isInsidePitch } from '../core/pitch';
import type { Action, FieldSet, MatchState, Player, SimParams, TeamId } from '../core/types';
import { attackDir, otherTeam } from '../core/types';
import { launchSpeed, ballTravelTime, ballRange, timeToArrive } from '../models/motion';
import { pressureAt } from '../models/fields';
import { isOffsidePosition } from '../models/structure';
import { isAimCovered } from '../models/probability';

export type ProposalKind = 'pass' | 'lob' | 'through' | 'dribble' | 'shot' | 'hold' | 'clear';

export interface Proposal {
  kind: ProposalKind;
  action: Action;
  /** Receveur visé (passes), −1 sinon. */
  receiverId: number;
  /** Point d'arrivée du ballon en cas de succès (borné au terrain). */
  successPoint: Vec2;
  /** Vitesse d'arrivée souhaitée (m/s, passes au sol). */
  arrivalSpeed?: number;
  /** Partie logistique du logit de P_pass déjà calculée pour la même cible (variante lobée d'une passe évaluée). */
  logit?: number;
}

/** Ordonnées des trois points de visée sur la ligne de but (§3.2). */
export const SHOT_AIMS: readonly number[] = [-2.9, 0, 2.9];
/** Marge (m) gardée à l'intérieur du terrain pour les cibles de dribble et de profondeur. */
const PITCH_MARGIN = 0.5;
/** Limite (repère équipe, m) du tiers défensif : un dégagement n'est envisagé qu'en deçà. */
export const CLEAR_MAX_X = -PITCH.halfLength / 3; // −17,5 m
/** Pression minimale sur le porteur pour envisager un dégagement (§6.1 : Π(b) > 1,5). */
export const CLEAR_MIN_PRESSURE = 1.5;
/** Portée (m) et écartement latéral (m) d'un dégagement vers l'aile la plus libre. */
const CLEAR_RANGE = 40;
const CLEAR_WING_Y = 25;
/** Vitesse (m/s) en dessous de laquelle un coéquipier est considéré à l'arrêt (direction de course = axe d'attaque). */
const RUN_SPEED_MIN = 0.5;
/**
 * Passes en profondeur vers l'espace (§6.1) : nombre de points de plus grand danger D(q) retenus parmi un motif polaire
 * centré sur le ballon (distances × angles autour de l'axe d'attaque, portée ≤ 35 m devant le ballon). Le motif est
 * relatif au ballon (et non aux nœuds de la grille) afin que la génération respecte la symétrie miroir du terrain.
 */
const DANGER_TARGETS = 6;
const DANGER_DISTANCES: readonly number[] = [8, 16, 24, 32];
const DANGER_ANGLES: readonly number[] = [-60, -30, 0, 30, 60].map((deg) => (deg * Math.PI) / 180);
/** Deux cibles de profondeur à moins de cette distance (m) sont confondues (dédoublonnage). */
const TARGET_MERGE = 1.0;

/** Point de départ de l'action : le ballon s'il est au joueur, sinon la position du joueur. */
export const actionOrigin = (state: MatchState, player: Player): Vec2 => (state.ball.ownerId === player.id ? state.ball.pos : player.pos);

/** Gardien de l'équipe `team` (null s'il n'y en a pas dans l'état). */
export function keeperOf(state: MatchState, team: TeamId): Player | null {
  for (const p of state.players) if (p.team === team && p.role === 'GK') return p;
  return null;
}

/**
 * Cible anticipée d'une passe au pied (§5.1) : q_r = p_r + v_r · T_b(‖p_r − b‖) (une itération de point fixe),
 * bornée au terrain.
 */
export function anticipatedTarget(origin: Vec2, receiver: Player, arrivalSpeed: number, params: SimParams): Vec2 {
  const d0 = dist(origin, receiver.pos);
  const s0 = launchSpeed(d0, arrivalSpeed, params.physics);
  let t = ballTravelTime(d0, s0, params.physics);
  if (!Number.isFinite(t)) t = d0 / Math.max(1, arrivalSpeed);
  return clampToPitch({ x: receiver.pos.x + receiver.vel.x * t, y: receiver.pos.y + receiver.vel.y * t }, PITCH_MARGIN);
}

/** Passe au pied vers `receiver` à la vitesse d'arrivée `arrivalSpeed`. */
export function proposePass(state: MatchState, passer: Player, receiver: Player, arrivalSpeed: number, params: SimParams): Proposal {
  const target = anticipatedTarget(actionOrigin(state, passer), receiver, arrivalSpeed, params);
  return {
    kind: 'pass',
    action: { type: 'pass', targetId: receiver.id, targetPoint: target, kind: 'ground', speed: arrivalSpeed },
    receiverId: receiver.id,
    successPoint: target,
    arrivalSpeed,
  };
}

/** Variante lobée d'une passe (même cible) : utilisée quand la ligne au sol est fermée et la distance > 25 m. */
export function proposeLob(pass: Proposal, logit?: number): Proposal {
  const a = pass.action as Extract<Action, { type: 'pass' }>;
  return {
    kind: 'lob',
    action: { type: 'pass', targetId: a.targetId, targetPoint: a.targetPoint, kind: 'lob', speed: a.speed },
    receiverId: pass.receiverId,
    successPoint: pass.successPoint,
    arrivalSpeed: pass.arrivalSpeed,
    logit: logit ?? pass.logit,
  };
}

/**
 * Passes en profondeur (§6.1) : pour chaque coéquipier k en jeu (pas hors-jeu), q = p_k + λ·û_k,
 * λ ∈ params.decision.throughDistances, û_k = direction de course de k mélangée 50/50 à l'axe d'attaque
 * (rabattue sur l'axe d'attaque si le mélange n'est pas dirigé vers l'avant : un receveur qui recule n'appelle pas
 * de passe « en profondeur » à ses pieds) ; plus, si `fields` est fourni, les DANGER_TARGETS cellules de plus grand
 * danger D(q) à moins de DANGER_RANGE m devant le ballon (receveur = coéquipier en jeu au plus petit T_i(q)).
 * Seuls les points devant le ballon et à l'intérieur du terrain sont retenus ; les cibles confondues (< 1 m) sont dédoublonnées.
 */
export function proposeThroughBalls(state: MatchState, passer: Player, params: SimParams, fields?: FieldSet): Proposal[] {
  const team = passer.team;
  const dir = attackDir(team);
  const origin = actionOrigin(state, passer);
  const out: Proposal[] = [];
  const speed = params.physics.throughArrivalSpeed;
  const receivers: Player[] = [];
  for (const k of state.players) {
    if (k.team !== team || k.id === passer.id || k.role === 'GK') continue;
    if (isOffsidePosition(state, k.pos, team)) continue;
    receivers.push(k);
  }
  const push = (k: Player, q: Vec2): void => {
    if (!isInsidePitch(q, -PITCH_MARGIN)) return;
    if (dir * (q.x - origin.x) <= 0) return;
    for (const o of out) if (o.receiverId === k.id && dist(o.successPoint, q) < TARGET_MERGE) return;
    out.push({
      kind: 'through',
      action: { type: 'pass', targetId: k.id, targetPoint: q, kind: 'through', speed },
      receiverId: k.id,
      successPoint: q,
      arrivalSpeed: speed,
    });
  };
  for (const k of receivers) {
    const run = Math.hypot(k.vel.x, k.vel.y) >= RUN_SPEED_MIN ? normalize(k.vel) : { x: dir, y: 0 };
    let u = normalize({ x: 0.5 * run.x + 0.5 * dir, y: 0.5 * run.y });
    if (dir * u.x <= 1e-6) u = { x: dir, y: 0 };
    for (const lambda of params.decision.throughDistances) push(k, { x: k.pos.x + lambda * u.x, y: k.pos.y + lambda * u.y });
  }
  // Cibles « espace » : points de plus grand danger devant le ballon, servis au coéquipier qui y arrive le premier.
  const danger = fields ? (team === 'A' ? fields.dangerA : fields.dangerB) : undefined;
  if (danger && receivers.length > 0) {
    const best: { value: number; x: number; y: number }[] = [];
    for (const d of DANGER_DISTANCES) {
      for (const a of DANGER_ANGLES) {
        const x = origin.x + dir * d * Math.cos(a), y = origin.y + d * Math.sin(a);
        if (!isInsidePitch({ x, y }, -PITCH_MARGIN)) continue;
        const value = danger.sample({ x, y });
        if (best.length < DANGER_TARGETS) { best.push({ value, x, y }); best.sort((a, b) => b.value - a.value); }
        else if (value > best[best.length - 1].value) { best[best.length - 1] = { value, x, y }; best.sort((a, b) => b.value - a.value); }
      }
    }
    for (const cell of best) {
      const q = { x: cell.x, y: cell.y };
      let receiver: Player | null = null;
      let tBest = Infinity;
      for (const k of receivers) {
        const t = timeToArrive(k.pos, k.vel, q, k.maxSpeed, k.maxAccel, params.models);
        if (t < tBest) { tBest = t; receiver = k; }
      }
      if (receiver) push(receiver, q);
    }
  }
  return out;
}

/**
 * Dribbles (§6.1) : `dribbleDirections` directions uniformément réparties (la première vers le but adverse)
 * × `dribbleDistances` ; les cibles qui sortiraient du terrain sont écartées.
 * `distances` permet de restreindre le jeu (profondeur 2).
 */
export function proposeDribbles(state: MatchState, carrier: Player, params: SimParams, distances: readonly number[] = params.decision.dribbleDistances): Proposal[] {
  const dir = attackDir(carrier.team);
  const origin = actionOrigin(state, carrier);
  const n = Math.max(1, Math.floor(params.decision.dribbleDirections));
  const base = dir > 0 ? 0 : Math.PI;
  const out: Proposal[] = [];
  for (let i = 0; i < n; i++) {
    const theta = base + (2 * Math.PI * i) / n;
    const u = { x: Math.cos(theta), y: Math.sin(theta) };
    if (Math.abs(u.x) < 1e-12) u.x = 0;
    if (Math.abs(u.y) < 1e-12) u.y = 0;
    for (const d of distances) {
      const q = { x: origin.x + u.x * d, y: origin.y + u.y * d };
      if (!isInsidePitch(q, -PITCH_MARGIN)) continue;
      out.push({ kind: 'dribble', action: { type: 'dribble', direction: u, distance: d }, receiverId: -1, successPoint: q });
    }
  }
  return out;
}

/**
 * Tir (§6.1, §5.4) : si d_G < shotMaxDistance, trois points de visée y ∈ {−2,9 ; 0 ; 2,9} sur la ligne de but ;
 * xG ne dépendant pas de la visée, on retient le point non couvert par le gardien le plus éloigné de lui.
 * Retourne null si le tir n'est pas envisageable (trop loin ou derrière la ligne de but).
 */
export function proposeShot(state: MatchState, shooter: Player, params: SimParams): Proposal | null {
  const team = shooter.team;
  const dir = attackDir(team);
  const origin = actionOrigin(state, shooter);
  const dG = distToGoal(origin, dir);
  if (dG >= params.decision.shotMaxDistance) return null;
  if (dir * origin.x >= PITCH.halfLength) return null;
  const keeper = keeperOf(state, otherTeam(team));
  const tFlight = dG / params.physics.shotSpeed;
  const gx = dir * PITCH.halfLength;
  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  for (const y of SHOT_AIMS) {
    const aim = { x: gx, y };
    const covered = keeper ? isAimCovered(origin, aim, keeper.pos, team, tFlight, params, keeper) : false;
    const away = keeper ? Math.abs(y - keeper.pos.y) : Math.abs(y) < 1e-9 ? 1 : 0;
    const score = (covered ? 0 : 10) + away;
    if (score > bestScore) { bestScore = score; best = aim; }
  }
  if (!best) return null;
  return { kind: 'shot', action: { type: 'shoot', targetPoint: best, power: 1 }, receiverId: -1, successPoint: best };
}

/** Conservation du ballon (§5.5). */
export function proposeHold(state: MatchState, carrier: Player): Proposal {
  const origin = actionOrigin(state, carrier);
  return { kind: 'hold', action: { type: 'hold' }, receiverId: -1, successPoint: { x: origin.x, y: origin.y } };
}

/**
 * Dégagement (§6.1) : seulement dans le tiers défensif (x < −17,5 m, repère équipe) et sous pression
 * (Π(b) > 1,5) ; ballon long vers l'aile la moins pressée, 40 m devant.
 */
export function proposeClear(state: MatchState, carrier: Player, params: SimParams): Proposal | null {
  const team = carrier.team;
  const dir = attackDir(team);
  const origin = actionOrigin(state, carrier);
  if (dir * origin.x >= CLEAR_MAX_X) return null;
  if (pressureAt(state, origin, team, params) <= CLEAR_MIN_PRESSURE) return null;
  const x = Math.max(-PITCH.halfLength + 2, Math.min(PITCH.halfLength - 2, origin.x + dir * CLEAR_RANGE));
  let best: Vec2 | null = null;
  let bestPressure = Infinity;
  for (const y of [-CLEAR_WING_Y, CLEAR_WING_Y]) {
    const q = { x, y };
    const pi = pressureAt(state, q, team, params);
    if (pi < bestPressure) { bestPressure = pi; best = q; }
  }
  if (!best) return null;
  return { kind: 'clear', action: { type: 'clear', targetPoint: best }, receiverId: -1, successPoint: best };
}

/**
 * Une passe au sol de `origin` vers `target` (vitesse d'arrivée `arrivalSpeed`) court encore s₀²/2μ − d au-delà de la
 * cible si le receveur la manque : vrai si cette course résiduelle franchit la propre ligne de but de `team` entre les
 * poteaux (± `decision.ownGoalMargin`). Un tel candidat (but contre son camp en cas d'échec) n'est jamais proposé.
 */
export function rollsIntoOwnGoal(origin: Vec2, target: Vec2, arrivalSpeed: number, team: TeamId, params: SimParams): boolean {
  const d = dist(origin, target);
  if (d < 1e-6) return false;
  const range = ballRange(launchSpeed(d, arrivalSpeed, params.physics), params.physics);
  if (!Number.isFinite(range)) return true;
  const ux = (target.x - origin.x) / d, uy = (target.y - origin.y) / d;
  const goalX = -attackDir(team) * PITCH.halfLength;
  if (Math.abs(ux) < 1e-9) return false;
  const t = (goalX - origin.x) / ux; // distance de course jusqu'à la ligne de but
  if (t < 0 || t > range) return false;
  const yCross = origin.y + uy * t;
  return Math.abs(yCross) <= PITCH.goalHalfWidth + (params.decision.ownGoalMargin ?? 0);
}
