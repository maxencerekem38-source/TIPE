/**
 * Évaluation à un coup d'un candidat du porteur (docs/CONCEPTION.md §5.6, §6.2, §6.5, §13.3) :
 *
 *   EV₁(a) = P_a · V⁺(a) − (1 − P_a) · λ_risk · L(q_a⁻) − C(a)
 *   V⁺(a) = Θ(q_a⁺) + w_prog · Δx/L + w_sup · sup(q_a⁺) + w_lb · n_lb(a)     (tir : V⁺ = 1, P = xG)
 *   C(a)  = w_time · T_a + w_off · 1[risque de hors-jeu]
 *
 * Θ(q⁺) = xT(q⁺) · PC_att(q⁺) est lue sur l'état ANTICIPÉ (joueurs avancés de T_a à vitesse constante,
 * receveur au point d'arrivée) ; L(q⁻) = xT adverse au point de perte (point faible de la ligne pour une passe,
 * ballon pour un dribble / une conservation, gardien pour un tir).
 *
 * Décomposition additive EXACTE (Σ contributions = score) :
 *   threat      P · xT(q⁺) · ½                (menace de la zone à contrôle neutre)
 *   control     P · xT(q⁺) · (PC − ½)         (gain / perte de contrôle de la zone)
 *   progression P · w_prog · Δx / L
 *   support     P · w_sup · sup
 *   lines       P · w_lb · n_lb
 *   risk        −(1 − P) · λ · L(q⁻)
 *   time        −w_time · T_a
 *   offside     −w_off · 1[risque]
 *   tactic      bonus tactiques additifs (profondeur / lob : +0,5·directness·P·V⁺ ; tir : 0,05·(shotEagerness − 0,5) ;
 *               conservation : holdBias − 0,02·tempo)
 * (les composantes « lookahead » et « hysteresis » sont ajoutées par onball.ts).
 *
 * Modulation tactique (§13.3) : λ ← λ·(1,6 − 1,2·riskTolerance) ; w_prog, w_lb ← ·progressionBias
 * (× (1 + 1,5·counterAttackBias) en transition offensive) ; w_time ← ·(0,5 + tempo).
 */
import type { Vec2 } from '../core/vec2';
import { dist } from '../core/vec2';
import { PITCH } from '../core/pitch';
import type { AttackDir } from '../core/pitch';
import type { Candidate, FieldSet, GamePhase, MatchState, Player, ScoreComponent, SimParams, TacticParams, TeamId } from '../core/types';
import { attackDir, otherTeam } from '../core/types';
import { pitchControlAt, pressureAt, threatAt } from '../models/fields';
import { analyseInterception, lineBreaks, passingLaneQuality, type InterceptionAnalysis } from '../models/interception';
import { dribbleProbability, holdProbability, passProbability, shotProbability, throughBallProbability, type ProbabilityResult } from '../models/probability';
import { offsideLine, smoothSuperiority } from '../models/structure';
import { sigmoid } from '../core/vec2';
import { keeperOf, type Proposal, type ProposalKind } from './candidates';
import { fmtFr, fmtPct, playerNumber } from './explain';

// ---------------------------------------------------------------------------
// Constantes de modulation (§13.3) — formules de la spécification, non optimisables
// ---------------------------------------------------------------------------
/** λ_risk ← λ_risk · (RISK_BASE − RISK_SLOPE · riskTolerance). */
const RISK_BASE = 1.6;
const RISK_SLOPE = 1.2;
/** Bonus multiplicatif (1 + DIRECTNESS_GAIN · directness) sur la récompense des passes en profondeur / lobées. */
const DIRECTNESS_GAIN = 0.5;
/** w_time ← w_time · (TEMPO_BASE + tempo). */
const TEMPO_BASE = 0.5;
/** Pénalité (but) de conservation par unité de tempo (« un tempo élevé pénalise la conservation »). */
const TEMPO_HOLD_PENALTY = 0.02;
/** Bonus additif SHOT_EAGERNESS_GAIN · (shotEagerness − 0,5) sur le tir. */
const SHOT_EAGERNESS_GAIN = 0.05;
/** w_prog ← w_prog · (1 + COUNTER_GAIN · counterAttackBias) en transition offensive. */
const COUNTER_GAIN = 1.5;
/** Élagage géométrique (§4.6) : ligne « fermée » si un adversaire est à moins de LANE_BLOCK_DISTANCE m du segment et W > LANE_BLOCK_PHI. */
export const LANE_BLOCK_DISTANCE = 1.0;
export const LANE_BLOCK_PHI = 0.8;
/** Distance (m) au-delà de laquelle une ligne fermée est jouée en lob. */
export const LOB_MIN_DISTANCE = 25;
/** Marge (m) à la ligne de hors-jeu en deçà de laquelle une passe porte un « risque de hors-jeu » (§6.2). */
const OFFSIDE_RISK_MARGIN = 1.0;
/** Longueur maximale (caractères) d'une phrase d'explication. */
const REASON_MAX = 140;

// ---------------------------------------------------------------------------
// Poids modulés
// ---------------------------------------------------------------------------
export interface OnBallWeights {
  lambda: number;
  wProgress: number;
  wSupport: number;
  wLineBreaks: number;
  wTime: number;
  wOffside: number;
  gamma: number;
  hysteresis: number;
  /** Facteur multiplicatif − 1 appliqué à la récompense des passes en profondeur / lobées. */
  directnessBonus: number;
  /** Bonus additif (but) du tir. */
  shotBonus: number;
  /** Bonus additif (but) de la conservation (holdBias − pénalité de tempo). */
  holdBonus: number;
}

/** Poids de l'évaluation après modulation tactique (§13.3). Tous les modulateurs à leur valeur neutre ⇒ défauts. */
export function modulatedWeights(params: SimParams, tactic: TacticParams, phase: GamePhase): OnBallWeights {
  const d = params.decision;
  const counter = phase === 'transition_attack' ? 1 + COUNTER_GAIN * tactic.counterAttackBias : 1;
  return {
    lambda: d.lambdaRisk * Math.max(0, RISK_BASE - RISK_SLOPE * tactic.riskTolerance),
    wProgress: d.wProgress * tactic.progressionBias * counter,
    wSupport: d.wSupport,
    wLineBreaks: d.wLineBreaks * tactic.progressionBias,
    wTime: d.wTime * (TEMPO_BASE + tactic.tempo),
    wOffside: d.wOffside,
    gamma: d.gamma,
    hysteresis: d.hysteresis,
    directnessBonus: DIRECTNESS_GAIN * tactic.directness,
    shotBonus: SHOT_EAGERNESS_GAIN * (tactic.shotEagerness - 0.5),
    holdBonus: d.holdBias - TEMPO_HOLD_PENALTY * tactic.tempo,
  };
}

// ---------------------------------------------------------------------------
// Contexte d'évaluation (partagé par tous les candidats d'une décision)
// ---------------------------------------------------------------------------
export interface EvalContext {
  state: MatchState;
  fields: FieldSet;
  params: SimParams;
  weights: OnBallWeights;
  me: Player;
  team: TeamId;
  dir: AttackDir;
  /** Point de départ de l'action (ballon). */
  origin: Vec2;
  /** Pression Π(b) sur le porteur. */
  pressureBall: number;
  /** Ligne de hors-jeu (repère équipe). */
  offsideX: number;
  /** État anticipé partagé : copies superficielles des joueurs, positions réécrites pour chaque candidat. */
  pred: MatchState;
  /** Détail complet (échantillons d'interception) — désactivé pour le jeu réduit de la profondeur 2. */
  detailed: boolean;
}

/** Copie superficielle des joueurs (positions et vitesses dupliquées) pour l'état anticipé. */
export function shallowPlayers(players: readonly Player[]): Player[] {
  const out: Player[] = new Array(players.length);
  for (let k = 0; k < players.length; k++) {
    const p = players[k];
    out[k] = { ...p, pos: { x: p.pos.x, y: p.pos.y }, vel: { x: p.vel.x, y: p.vel.y }, decision: null };
  }
  return out;
}

export function createEvalContext(state: MatchState, fields: FieldSet, params: SimParams, weights: OnBallWeights, me: Player, detailed: boolean): EvalContext {
  const team = me.team;
  const dir = attackDir(team);
  const origin = state.ball.ownerId === me.id ? state.ball.pos : me.pos;
  const pred: MatchState = { ...state, players: shallowPlayers(state.players) };
  return {
    state, fields, params, weights, me, team, dir, origin,
    pressureBall: pressureAt(state, origin, team, params),
    offsideX: dir * offsideLine(state, team),
    pred, detailed,
  };
}

/**
 * Avance tous les joueurs de l'état anticipé de `t` secondes à vitesse constante (bornés au terrain),
 * puis place `actorId` (porteur ou receveur) au point d'arrivée `q`.
 */
export function advancePrediction(ctx: EvalContext, t: number, actorId: number, q: Vec2): void {
  const src = ctx.state.players;
  const dst = ctx.pred.players;
  for (let k = 0; k < src.length; k++) {
    const p = src[k];
    const o = dst[k];
    let x = p.pos.x + p.vel.x * t, y = p.pos.y + p.vel.y * t;
    if (x < -PITCH.halfLength) x = -PITCH.halfLength; else if (x > PITCH.halfLength) x = PITCH.halfLength;
    if (y < -PITCH.halfWidth) y = -PITCH.halfWidth; else if (y > PITCH.halfWidth) y = PITCH.halfWidth;
    o.pos.x = x; o.pos.y = y;
    o.vel.x = p.vel.x; o.vel.y = p.vel.y;
    if (p.id === actorId) { o.pos.x = q.x; o.pos.y = q.y; }
  }
}

// ---------------------------------------------------------------------------
// Évaluation d'une proposition
// ---------------------------------------------------------------------------
const comp = (key: string, label: string, value: number, weight: number, contribution: number, unit?: string): ScoreComponent => ({
  key, label, value, unit, weight, contribution,
});

/** Somme des contributions du logit d'un résultat de probabilité (hors log-facteurs multiplicatifs). */
function logitOf(pr: ProbabilityResult): number {
  let z = 0;
  for (const f of pr.features) if (f.key !== 'interception' && f.key !== 'receiverFirst' && f.key !== 'offside') z += f.contribution;
  return z;
}

export interface Evaluation {
  candidate: Candidate;
  kind: ProposalKind;
  /** Ligne de passe fermée (élagage géométrique §4.6) — passes au sol seulement. */
  blocked: boolean;
  /** Distance de l'action (m). */
  distance: number;
}

/**
 * Évalue une proposition : probabilité (modèles §5), valeur anticipée, risque, coût, décomposition, menaces.
 * Retourne null si l'action est physiquement impossible (ballon hors de portée).
 */
export function evaluateProposal(ctx: EvalContext, prop: Proposal): Evaluation | null {
  const { state, fields, params, weights: w, me, team, dir, origin } = ctx;
  const L = PITCH.length;
  let P: number;
  let duration: number;
  let inter: InterceptionAnalysis | undefined;
  let failurePoint: Vec2;
  let receiver: Player | null = null;
  let blocked = false;
  const distance = dist(origin, prop.successPoint);

  switch (prop.kind) {
    case 'pass':
    case 'lob': {
      const pr = passProbability(state, fields, me.id, prop.receiverId, prop.successPoint, params, prop.arrivalSpeed);
      inter = pr.interception!;
      if (prop.kind === 'lob') {
        const lob = analyseInterception(state, origin, prop.successPoint, 'lob', team, params);
        P = (1 - lob.pIntercept) * sigmoid(logitOf(pr));
        inter = lob;
      } else {
        P = pr.p;
        blocked = inter.weakPhi > LANE_BLOCK_PHI && passingLaneQuality(state, origin, prop.successPoint, team) < LANE_BLOCK_DISTANCE;
      }
      duration = inter.travelTime;
      failurePoint = inter.weakSampleIndex >= 0 ? inter.samples[inter.weakSampleIndex].point : prop.successPoint;
      receiver = ctx.state.players[prop.receiverId]?.id === prop.receiverId ? ctx.state.players[prop.receiverId] : ctx.state.players.find((p) => p.id === prop.receiverId) ?? null;
      break;
    }
    case 'through': {
      const pr = throughBallProbability(state, fields, me.id, prop.receiverId, prop.successPoint, params);
      P = pr.p;
      inter = pr.interception!;
      duration = inter.travelTime;
      failurePoint = inter.weakSampleIndex >= 0 ? inter.samples[inter.weakSampleIndex].point : prop.successPoint;
      receiver = ctx.state.players[prop.receiverId]?.id === prop.receiverId ? ctx.state.players[prop.receiverId] : ctx.state.players.find((p) => p.id === prop.receiverId) ?? null;
      break;
    }
    case 'dribble': {
      const pr = dribbleProbability(state, fields, me.id, prop.successPoint, params);
      P = pr.p;
      duration = distance / Math.max(0.5, params.physics.dribbleSpeedFactor * me.maxSpeed);
      failurePoint = origin;
      break;
    }
    case 'shot': {
      const pr = shotProbability(state, fields, me.id, prop.successPoint, params);
      P = pr.p;
      duration = distance / params.physics.shotSpeed;
      const gk = keeperOf(state, otherTeam(team));
      failurePoint = gk ? gk.pos : { x: dir * (PITCH.halfLength - PITCH.goalAreaLength), y: 0 };
      break;
    }
    case 'hold': {
      const pr = holdProbability(state, fields, me.id, params);
      P = pr.p;
      duration = params.decision.holdDuration;
      failurePoint = origin;
      break;
    }
    case 'clear': {
      inter = analyseInterception(state, origin, prop.successPoint, 'clearance', team, params);
      P = 1 - inter.pIntercept;
      duration = inter.travelTime;
      failurePoint = inter.weakSampleIndex >= 0 ? inter.samples[inter.weakSampleIndex].point : prop.successPoint;
      break;
    }
  }
  if (!Number.isFinite(duration) || !Number.isFinite(P)) return null;
  P = Math.max(0, Math.min(1, P));

  const components: ScoreComponent[] = [];
  let valueIfSuccess: number;
  const successPoint = prop.successPoint;

  if (prop.kind === 'shot') {
    // Un but vaut 1 : V⁺ = 1, P = xG (§6.2).
    valueIfSuccess = 1;
    components.push(comp('threat', 'Valeur d’un but', 1, P, P, 'but'));
  } else {
    const actorId = receiver ? receiver.id : me.id;
    advancePrediction(ctx, duration, actorId, successPoint);
    const xT = threatAt(successPoint, team, params);
    const control = pitchControlAt(ctx.pred, successPoint, team, params);
    const sup = smoothSuperiority(ctx.pred, successPoint, team, params);
    const dx = dir * (successPoint.x - origin.x);
    const nlb = prop.kind === 'hold' ? 0 : lineBreaks(state, origin, successPoint, team);
    valueIfSuccess = xT * control + w.wProgress * (dx / L) + w.wSupport * sup + w.wLineBreaks * nlb;
    components.push(comp('threat', 'Menace de la zone d’arrivée', xT, 0.5 * P, 0.5 * P * xT, 'but'));
    components.push(comp('control', 'Contrôle de la zone d’arrivée (− ½)', control - 0.5, P * xT, P * xT * (control - 0.5)));
    components.push(comp('progression', 'Progression vers le but', dx, (P * w.wProgress) / L, (P * w.wProgress * dx) / L, 'm'));
    components.push(comp('support', 'Supériorité numérique locale', sup, P * w.wSupport, P * w.wSupport * sup));
    if (prop.kind !== 'hold') components.push(comp('lines', 'Lignes défensives franchies', nlb, P * w.wLineBreaks, P * w.wLineBreaks * nlb));
  }

  // Risque : perte au point q⁻, valorisée par la menace adverse.
  const loss = threatAt(failurePoint, otherTeam(team), params);
  components.push(comp('risk', 'Risque en cas de perte', loss, -(1 - P) * w.lambda, -(1 - P) * w.lambda * loss, 'but'));
  // Coûts.
  components.push(comp('time', 'Durée de l’action', duration, -w.wTime, -w.wTime * duration, 's'));
  let offsideRisk = 0;
  if (receiver && (prop.kind === 'pass' || prop.kind === 'lob' || prop.kind === 'through')) {
    const xr = dir * receiver.pos.x;
    if (xr > 0 && xr > ctx.offsideX - OFFSIDE_RISK_MARGIN) offsideRisk = 1;
  }
  if (offsideRisk) components.push(comp('offside', 'Risque de hors-jeu', 1, -w.wOffside, -w.wOffside));
  // Modulation tactique additive.
  let tactic = 0;
  if (prop.kind === 'through' || prop.kind === 'lob') tactic = w.directnessBonus * P * valueIfSuccess;
  else if (prop.kind === 'shot') tactic = w.shotBonus;
  else if (prop.kind === 'hold') tactic = w.holdBonus;
  if (tactic !== 0) components.push(comp('tactic', 'Modulation tactique', tactic, 1, tactic, 'but'));

  let score = 0;
  for (const c of components) score += c.contribution;

  const candidate: Candidate = {
    action: prop.kind === 'shot' ? { ...(prop.action as Extract<Candidate['action'], { type: 'shoot' }>), xg: P } : prop.action,
    score,
    probability: P,
    valueIfSuccess,
    valueIfFailure: -w.lambda * loss,
    components,
    reason: '',
    threats: inter ? inter.threats : undefined,
    duration,
    successPoint: { x: successPoint.x, y: successPoint.y },
    failurePoint: { x: failurePoint.x, y: failurePoint.y },
  };
  if (ctx.detailed && inter) candidate.samples = inter.samples.map((s) => ({ point: s.point, phi: s.phi, opponentId: s.opponentId }));
  candidate.reason = buildReason(candidate, state, ctx.pressureBall);
  return { candidate, kind: prop.kind, blocked, distance };
}

// ---------------------------------------------------------------------------
// Phrase d'explication (§6.6) : deux plus grandes contributions positives + la plus grande négative
// ---------------------------------------------------------------------------
function positivePhrase(c: ScoreComponent, cand: Candidate): string | null {
  const a = cand.action;
  switch (c.key) {
    case 'threat':
      return a.type === 'shoot' ? `chance de but (xG ${fmtPct(cand.probability)})` : `zone d’arrivée dangereuse (xT ${fmtFr(c.value, 2)})`;
    case 'control':
      return `espace disponible important (contrôle ${fmtPct(c.value + 0.5)})`;
    case 'progression':
      return `forte progression vers le but (+${fmtFr(c.value, 0)} m)`;
    case 'support':
      return 'supériorité numérique locale';
    case 'lines':
      return `franchit ${fmtFr(c.value, 0)} ligne${c.value >= 2 ? 's' : ''}`;
    case 'lookahead':
      return `bonne suite possible (${fmtFr(c.value, 2, true)})`;
    case 'tactic':
      return 'favorisée par la tactique';
    case 'hysteresis':
      return 'intention conservée';
    default:
      return null;
  }
}

function negativePhrase(c: ScoreComponent, cand: Candidate, state: MatchState): string | null {
  const a = cand.action;
  switch (c.key) {
    case 'risk': {
      if ((a.type === 'pass' || a.type === 'clear') && cand.threats && cand.threats.length > 0) {
        return `risque d’interception élevé (${playerNumber(state, cand.threats[0])})`;
      }
      return `perte dangereuse en cas d’échec (${fmtPct(1 - cand.probability)})`;
    }
    case 'control':
      return `zone d’arrivée contestée (contrôle ${fmtPct(c.value + 0.5)})`;
    case 'progression':
      return `recul de ${fmtFr(-c.value, 0)} m`;
    case 'support':
      return 'infériorité numérique locale';
    case 'time':
      return `action lente (${fmtFr(c.value, 1)} s)`;
    case 'offside':
      return 'receveur au bord du hors-jeu';
    case 'lookahead':
      return 'suite peu prometteuse';
    case 'tactic':
      return 'pénalisée par la tactique';
    default:
      return null;
  }
}

/** Phrase liée à la probabilité (placée en tête si l'action est sûre). */
function probabilityPhrase(cand: Candidate, pressureBall: number): string | null {
  const a = cand.action;
  if (cand.probability < 0.7) return null;
  if (a.type === 'pass') return `ligne de passe dégagée (${fmtPct(cand.probability)})`;
  if (a.type === 'dribble') return `dribble sûr (${fmtPct(cand.probability)})`;
  if (a.type === 'hold') return pressureBall < 0.5 ? 'faible pression défensive' : `conservation probable (${fmtPct(cand.probability)})`;
  return null;
}

/**
 * Construit la phrase de justification d'un candidat à partir de sa décomposition : les deux plus grandes
 * contributions positives et la plus grande négative (≤ 140 caractères, français).
 */
export function buildReason(cand: Candidate, state: MatchState, pressureBall = 0): string {
  const pos = cand.components.filter((c) => c.contribution > 1e-4).sort((a, b) => b.contribution - a.contribution);
  const neg = cand.components.filter((c) => c.contribution < -1e-4).sort((a, b) => a.contribution - b.contribution);
  const positives: string[] = [];
  const pp = probabilityPhrase(cand, pressureBall);
  if (pp) positives.push(pp);
  for (const c of pos) {
    if (positives.length >= 3) break;
    const s = positivePhrase(c, cand);
    if (s && !positives.includes(s)) positives.push(s);
  }
  let negative: string | null = null;
  for (const c of neg) { negative = negativePhrase(c, cand, state); if (negative) break; }
  let reason: string;
  if (positives.length === 0) reason = negative ?? 'aucune option satisfaisante';
  else reason = positives.join(' + ') + (negative ? `, mais ${negative}` : '');
  if (reason.length > REASON_MAX) reason = reason.slice(0, REASON_MAX - 1) + '…';
  return reason;
}
