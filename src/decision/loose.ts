/**
 * Ballon libre et briques communes de la couche décision.
 *
 *  - Ballon libre (§3.3, §13.2) : point d'arrêt prédit du ballon roulant, temps d'interception d'un joueur
 *    (le premier instant où il peut être sur la trajectoire avant ou en même temps que le ballon),
 *    classement des « chasseurs » d'une équipe, point de réception d'une passe en cours.
 *  - Fabrique de candidats de déplacement, de contexte de décision et de décisions complètes, partagée par
 *    offball.ts, defence.ts, keeper.ts et coordinator.ts (aucune duplication des formats de sortie).
 *
 * Fonctions pures : l'état n'est jamais modifié ici.
 */
import type { Vec2 } from '../core/vec2';
import { dist } from '../core/vec2';
import { clampToPitch } from '../core/pitch';
import type {
  Action, Ball, Candidate, Decision, DecisionContext, MatchState, MoveIntent, PhysicsParams, Player, ScoreComponent, SimParams, TeamId,
} from '../core/types';
import { timeToArrive } from '../models/motion';
import { controlFor, pressureOn } from '../models/fields';
import { localSuperiority } from '../models/structure';
import { slotPosition } from '../engine/match';
import { fmtFr, fmtPoint, INTENT_LABELS } from './explain';
import type { DecisionInput } from './policy';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
/** Marge (m) à l'intérieur du terrain pour toute cible de déplacement. */
export const TARGET_MARGIN = 1;
/** Vitesse (m/s) en dessous de laquelle le ballon est considéré arrêté (§3.2). */
const BALL_STOP_SPEED = 0.1;
/** Nombre d'échantillons temporels sur la trajectoire du ballon pour le temps d'interception. */
const BALL_SAMPLES = 8;
/** Pression normalisée : Π/2 borné à 1 (Π ∈ [0, ~4]). */
const PRESSURE_SCALE = 0.5;
/** Rayon (m) dans lequel un coéquipier compte comme « disponible » (contexte). */
const AVAILABLE_RADIUS = 30;
/** Itérations de bissection pour affiner l'instant de rencontre avec le ballon (précision ≈ stop.time / (8·2⁶)). */
const BISECTION_STEPS = 6;
/** Vitesse par défaut (m/s) de la référence de ballon des postes (offBall.slotFollowRate absent). */
const DEFAULT_SLOT_FOLLOW_RATE = 6;
/** Point de rencontre (course au ballon, réception) conservé d'un cycle à l'autre s'il bouge de moins de cette distance (m). */
export const MEETING_KEEP_RADIUS = 3;

// ---------------------------------------------------------------------------
// Ballon libre
// ---------------------------------------------------------------------------
/** Point d'arrêt prédit du ballon roulant (décélération μ) et instant d'arrêt (s) : portée s₀²/2μ (§3.2). */
export function ballStopPoint(ball: Ball, physics: PhysicsParams): { point: Vec2; time: number } {
  const s = Math.hypot(ball.vel.x, ball.vel.y);
  if (s < BALL_STOP_SPEED) return { point: { x: ball.pos.x, y: ball.pos.y }, time: 0 };
  const mu = Math.max(1e-6, physics.ballFriction);
  const range = (s * s) / (2 * mu);
  return {
    point: clampToPitch({ x: ball.pos.x + (ball.vel.x / s) * range, y: ball.pos.y + (ball.vel.y / s) * range }, 0.5),
    time: s / mu,
  };
}

/** Position du ballon roulant après `t` secondes (bornée à son point d'arrêt). */
export function ballPositionAt(ball: Ball, t: number, physics: PhysicsParams): Vec2 {
  const s = Math.hypot(ball.vel.x, ball.vel.y);
  if (s < BALL_STOP_SPEED || t <= 0) return { x: ball.pos.x, y: ball.pos.y };
  const mu = Math.max(1e-6, physics.ballFriction);
  const tt = Math.min(t, s / mu);
  const d = s * tt - 0.5 * mu * tt * tt;
  return clampToPitch({ x: ball.pos.x + (ball.vel.x / s) * d, y: ball.pos.y + (ball.vel.y / s) * d }, 0.5);
}

/**
 * Temps d'interception d'un ballon libre par un joueur : premier instant t où il peut être sur la trajectoire
 * avant ou quand le ballon y passe (T_j(b(t)) ≤ t), sinon attente du ballon à son point d'arrêt
 * (max(T_j(point d'arrêt), t_arrêt), toujours faisable). La trajectoire est échantillonnée, puis l'instant de
 * rencontre est affiné par bissection entre le dernier échantillon infaisable et le premier faisable
 * (g(t) = T_j(b(t)) − t est continue). Un point que le ballon a déjà dépassé n'est jamais un point de rencontre.
 * Retourne aussi le point de rencontre.
 */
export function timeToBall(player: Player, ball: Ball, params: SimParams): { time: number; point: Vec2 } {
  const stop = ballStopPoint(ball, params.physics);
  const m = params.models;
  const arrive = (q: Vec2): number => timeToArrive(player.pos, player.vel, q, player.maxSpeed, player.maxAccel, m);
  if (stop.time <= 0) return { time: arrive(stop.point), point: stop.point };
  // Point d'arrêt : on peut toujours l'attendre (repli).
  let best = Math.max(arrive(stop.point), stop.time);
  let bestPoint = stop.point;
  let lo = 0; // dernier instant échantillonné infaisable (T > t) — à t = 0 le ballon est en mouvement, donc infaisable.
  for (let s = 1; s < BALL_SAMPLES; s++) {
    const ts = (stop.time * s) / BALL_SAMPLES;
    const p = ballPositionAt(ball, ts, params.physics);
    if (arrive(p) <= ts) {
      let hi = ts, hiP = p;
      for (let k = 0; k < BISECTION_STEPS; k++) {
        const mid = 0.5 * (lo + hi);
        const q = ballPositionAt(ball, mid, params.physics);
        if (arrive(q) <= mid) { hi = mid; hiP = q; } else lo = mid;
      }
      if (hi < best) { best = hi; bestPoint = hiP; }
      break;
    }
    lo = ts;
  }
  return { time: best, point: bestPoint };
}

export interface Chaser { id: number; time: number; point: Vec2 }

/** Joueurs de champ de `team` classés par temps d'interception croissant du ballon libre. */
export function rankChasers(state: MatchState, params: SimParams, team: TeamId, includeKeeper = false): Chaser[] {
  const out: Chaser[] = [];
  for (const p of state.players) {
    if (p.team !== team) continue;
    if (p.role === 'GK' && !includeKeeper) continue;
    const r = timeToBall(p, state.ball, params);
    out.push({ id: p.id, time: r.time, point: r.point });
  }
  out.sort((a, b) => a.time - b.time || a.id - b.id);
  return out;
}

/** Point où le receveur désigné d'une passe en cours rejoint le ballon (point de rencontre, sinon point visé). */
export function receiveTarget(state: MatchState, params: SimParams, receiver: Player): Vec2 {
  const flight = state.ball.flight;
  const meet = timeToBall(receiver, state.ball, params);
  if (!flight) return meet.point;
  // Ballon aérien : on attend le point visé (pas d'interception en vol).
  if (flight.kind === 'lob' || flight.kind === 'clearance') return clampToPitch(flight.targetPoint, 0.5);
  return meet.point;
}

/**
 * Point de rencontre stable : si la décision précédente avait la même intention (course au ballon, réception) et une
 * cible à moins de MEETING_KEEP_RADIUS m du nouveau point, l'ancienne cible est conservée (pas de cible qui « tremble »
 * d'un cycle à l'autre le long de la trajectoire).
 */
export function stableMeetingPoint(previous: Decision | null | undefined, intent: MoveIntent, point: Vec2): Vec2 {
  const a = previous?.chosen.action;
  if (a && a.type === 'move' && a.intent === intent && dist(a.target, point) < MEETING_KEEP_RADIUS) return a.target;
  return point;
}

// ---------------------------------------------------------------------------
// Postes instanciés lissés (§7.2, lissage) : référence de ballon filtrée par le coordonnateur
// ---------------------------------------------------------------------------
/**
 * Met à jour la référence de ballon des postes (`state.slotBallRef`) : elle suit le ballon à `offBall.slotFollowRate`
 * m/s au plus (bloc qui coulisse à vitesse finie), et se recale instantanément sur le ballon à la première
 * décision, pendant un gel de remise en jeu ou si le temps recule (nouvel état).
 */
export function updateSlotBallRef(state: MatchState, params: SimParams): void {
  const rate = params.offBall.slotFollowRate ?? DEFAULT_SLOT_FOLLOW_RATE;
  const ball = state.ball.pos;
  const ref = state.slotBallRef;
  const frozen = !!state.restart && state.time < state.restart.resumeAt - 1e-9;
  if (!ref || rate <= 0 || frozen || state.time < ref.time) {
    state.slotBallRef = { time: state.time, pos: { x: ball.x, y: ball.y } };
    return;
  }
  const maxStep = rate * (state.time - ref.time);
  const dx = ball.x - ref.pos.x, dy = ball.y - ref.pos.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= maxStep) { ref.pos.x = ball.x; ref.pos.y = ball.y; } else { ref.pos.x += (dx / d) * maxStep; ref.pos.y += (dy / d) * maxStep; }
  ref.time = state.time;
}

/** Référence de ballon des postes instanciés : ballon filtré si le coordonnateur l'a posée, sinon ballon courant. */
export const slotBallRef = (state: MatchState): Vec2 => state.slotBallRef?.pos ?? state.ball.pos;

/** Poste instancié d'un joueur calculé sur la référence de ballon lissée (offball, défense, coordonnateur). */
export const teamSlot = (state: MatchState, player: Player): Vec2 => slotPosition(state, player, slotBallRef(state));

// ---------------------------------------------------------------------------
// Fabrique de composantes, candidats, contexte et décisions
// ---------------------------------------------------------------------------
/** Composante nommée : contribution = poids × valeur (décomposition additive exacte). */
export const component = (key: string, label: string, value: number, weight: number, unit?: string): ScoreComponent => ({
  key, label, value, unit, weight, contribution: weight * value,
});

/** Somme des contributions (invariant : score = Σ contributions). */
export const sumContributions = (components: readonly ScoreComponent[]): number => {
  let s = 0;
  for (const c of components) s += c.contribution;
  return s;
};

/** Candidat de déplacement (cible bornée au terrain). */
export function moveCandidate(
  target: Vec2,
  intent: MoveIntent,
  speed: number,
  components: ScoreComponent[],
  reason: string,
  extra: Partial<Omit<Candidate, 'action' | 'components' | 'reason' | 'score'>> & { markId?: number } = {},
): Candidate {
  const { markId, ...rest } = extra;
  const action: Action = markId !== undefined
    ? { type: 'move', target: clampToPitch(target, TARGET_MARGIN), intent, speed, markId }
    : { type: 'move', target: clampToPitch(target, TARGET_MARGIN), intent, speed };
  return {
    action,
    score: sumContributions(components),
    probability: rest.probability ?? 1,
    valueIfSuccess: rest.valueIfSuccess ?? 0,
    valueIfFailure: rest.valueIfFailure ?? 0,
    components,
    reason,
    ...rest,
  };
}

/** Candidat « conservation » (le joueur garde le ballon). */
export function holdCandidate(reason: string, components: ScoreComponent[] = []): Candidate {
  return { action: { type: 'hold' }, score: sumContributions(components), probability: 1, valueIfSuccess: 0, valueIfFailure: 0, components, reason };
}

/** Contexte de décision d'un joueur : phase, tactique, pression subie, coéquipiers disponibles, supériorité locale au ballon (`superiority` si déjà calculée). */
export function decisionContext(input: DecisionInput, player: Player, superiority?: number): DecisionContext {
  const { state, fields, params, tactic } = input;
  const team = player.team;
  let available = 0;
  for (const p of state.players) {
    if (p.team !== team || p.id === player.id || p.role === 'GK') continue;
    if (dist(p.pos, player.pos) <= AVAILABLE_RADIUS && controlFor(fields, p.pos, team) > 0.5) available++;
  }
  return {
    phase: state.phase[team],
    style: tactic.style,
    formation: tactic.formation,
    pressure: Math.min(1, PRESSURE_SCALE * pressureOn(fields, player.pos, team)),
    availableTeammates: available,
    localSuperiority: superiority ?? localSuperiority(state, state.ball.pos, team, params),
  };
}

/** Assemble une décision : candidats triés par score décroissant (le choisi est garanti présent), temps de calcul mesuré depuis `t0`. */
export function makeDecision(
  playerId: number,
  time: number,
  chosen: Candidate,
  candidates: Candidate[],
  context: DecisionContext,
  explanation: string,
  t0: number,
  extra: Partial<Pick<Decision, 'keptByHysteresis' | 'committedUntil' | 'game'>> = {},
): Decision {
  if (!candidates.includes(chosen)) candidates.push(chosen);
  candidates.sort((a, b) => b.score - a.score);
  return { playerId, time, chosen, candidates, context, explanation, computeMs: performance.now() - t0, ...extra };
}

/** Décision de déplacement élémentaire à un seul candidat (course au ballon, réception, gel de remise en jeu...). */
export function simpleMoveDecision(input: DecisionInput, player: Player, target: Vec2, intent: MoveIntent, speed: number, reason: string, t0 = performance.now()): Decision {
  const c = moveCandidate(target, intent, speed, [component('intent', INTENT_LABELS[intent], 1, 0)], reason);
  const explanation = `Intention : ${INTENT_LABELS[intent]} — cible ${fmtPoint(c.action.type === 'move' ? c.action.target : target)}, à ${fmtFr(dist(player.pos, target), 1)} m.\n${reason}`;
  return makeDecision(player.id, input.state.time, c, [c], decisionContext(input, player), explanation, t0);
}

/** Décision « conserver le ballon » (remetteur pendant un gel, gardien sans option). */
export function simpleHoldDecision(input: DecisionInput, player: Player, reason: string, t0 = performance.now()): Decision {
  const c = holdCandidate(reason);
  return makeDecision(player.id, input.state.time, c, [c], decisionContext(input, player), `Action : conservation du ballon.\n${reason}`, t0);
}
