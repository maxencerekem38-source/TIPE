/**
 * Décision du porteur de balle (docs/CONCEPTION.md §6) : génération des candidats (passes, passes en
 * profondeur, dribbles, tir, conservation, dégagement), évaluation par espérance de valeur avec risque
 * (evaluate.ts), anticipation à deux coups (expectimax profondeur 2 sur les K meilleurs candidats avec une
 * réponse adverse pessimiste), hystérésis, sélection (argmax, départage ε, réponse quantale) et explication.
 *
 * Score final d'un candidat développé (§6.3) :
 *   Q(a) = P_a · [V⁺(a) − δ_a + γ · G(a)] − (1 − P_a) · λ · L(q_a⁻) − C(a)
 *        = EV₁(a) − P_a · δ_a + P_a · γ · G(a)          (composantes « response » et « lookahead »)
 *   δ_a  = Θ(q⁺) − Θ_press(q⁺) ≥ 0 : dégradation de la menace par la réponse adverse « press » ;
 *   G(a) = max(0, max_{a'} EV₁(a' | s⁺_a) − Θ_press(q⁺)) : gain incrémental de la meilleure suite, au-delà de la
 *          menace déjà comptée en q⁺ (la conservation garantit G ≳ 0 : aucun double comptage, et un candidat non
 *          développé — Q = EV₁ ≤ Q développé — ne peut pas dépasser un candidat développé par simple omission).
 *          Une suite « tir » est comparée aussi au tir immédiat, sinon « dribbler puis tirer » serait crédité de tout xG'.
 * s⁺_a est l'état anticipé après succès : joueurs avancés de T_a, ballon au point d'arrivée, receveur porteur,
 * et les deux adversaires les plus proches du receveur courant vers lui (modèle de mouvement §4.1 : réaction puis
 * accélération bornée) — réponse « press », pessimiste et bornée physiquement.
 *
 * Engagement (§6.5) : un dribble ou une conservation choisis portent `committedUntil` (durée de l'action) ; le
 * moteur (loop.ts) ne re-décide pas un dribble engagé tant que le porteur garde le ballon et n'a pas atteint sa cible.
 *
 * Aucune allocation profonde : l'état anticipé est une copie superficielle des joueurs (positions dupliquées).
 */
import type { Vec2 } from '../core/vec2';
import type { Action, Candidate, Decision, DecisionContext, MatchState, Player, SimParams } from '../core/types';
import type { DecisionInput } from './policy';
import { proposeClear, proposeDribbles, proposeHold, proposeLob, proposePass, proposeShot, proposeThroughBalls, type Proposal } from './candidates';
import { buildReason, createEvalContext, evaluateProposal, modulatedWeights, shallowPlayers, LANE_BLOCK_PHI, LOB_MIN_DISTANCE, type EvalContext, type Evaluation, type OnBallWeights } from './evaluate';
import { explainDecision } from './explain';
import { localSuperiority } from '../models/structure';
import { pitchControlAt, pressureAt, threatAt } from '../models/fields';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
/** Nombre maximal de passes en profondeur conservées (§6.1). */
const MAX_THROUGH = 8;
/** Nombre d'échantillons d'interception du jeu réduit (profondeur 2, §6.3). */
const REDUCED_SAMPLES = 6;
/** Nombre d'adversaires qui courent vers le receveur dans la réponse pessimiste (§6.3, « press »). */
const PRESS_DEFENDERS = 2;
/** Distance (m) à laquelle les presseurs s'arrêtent du receveur (rayon de duel). */
const PRESS_STANDOFF = 1.2;
/** Seuil de contribution en deçà duquel une composante de lookahead n'est pas listée. */
const EPS = 1e-12;

export interface EvaluateOptions {
  /** Jeu réduit (profondeur 2) : passes à une seule vitesse, pas de profondeur ni de dégagement, dribbles courts. */
  reduced?: boolean;
  /** Conserver les échantillons d'interception (rendu) — vrai pour la décision finale. */
  detailed?: boolean;
  /** Poids déjà modulés (sinon calculés à partir de input.tactic et de la phase). */
  weights?: OnBallWeights;
}

const playerById = (state: MatchState, id: number): Player | undefined =>
  state.players[id]?.id === id ? state.players[id] : state.players.find((p) => p.id === id);

/** Ordre de tri : score décroissant, puis probabilité décroissante, puis durée croissante (§6.5). */
export function compareCandidates(a: Candidate, b: Candidate): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.probability !== a.probability) return b.probability - a.probability;
  return (a.duration ?? 0) - (b.duration ?? 0);
}

// ---------------------------------------------------------------------------
// Génération + évaluation à un coup
// ---------------------------------------------------------------------------
/**
 * Génère et évalue tous les candidats du porteur `playerId` (triés par score décroissant), sans lookahead.
 * Passes : la vitesse d'arrivée par défaut est évaluée d'abord ; si la ligne est fermée (§4.6) les autres
 * vitesses sont élaguées et, au-delà de 25 m, la variante lobée est tentée ; sinon la meilleure des trois
 * vitesses est retenue (une passe par coéquipier dans la liste finale).
 */
export function evaluateCandidates(input: DecisionInput, playerId: number, options: EvaluateOptions = {}): Candidate[] {
  const { state, fields, params } = input;
  const me = playerById(state, playerId);
  if (!me) return [];
  const weights = options.weights ?? modulatedWeights(params, input.tactic.params, state.phase[me.team]);
  const reduced = options.reduced ?? false;
  const ctx = createEvalContext(state, fields, params, weights, me, options.detailed ?? false, !reduced);
  const out: Candidate[] = [];

  // --- Passes au pied (une par coéquipier) ---
  const defaultSpeed = params.physics.passArrivalSpeed;
  const speeds: number[] = reduced ? [defaultSpeed] : [defaultSpeed, ...params.decision.passArrivalSpeeds.filter((s) => s !== defaultSpeed)];
  for (const r of state.players) {
    if (r.team !== me.team || r.id === me.id) continue;
    if (isReceiverOffside(ctx, r)) continue;
    const first = evaluateProposal(ctx, proposePass(state, me, r, speeds[0], params));
    if (!first) continue;
    let best: Evaluation = first;
    if (first.blocked) {
      if (first.distance > LOB_MIN_DISTANCE) {
        const lob = evaluateProposal(ctx, proposeLob(proposalOf(first, speeds[0]), first.logit));
        if (lob && lob.candidate.score > best.candidate.score) best = lob;
      }
    } else {
      for (let i = 1; i < speeds.length; i++) {
        const e = evaluateProposal(ctx, proposePass(state, me, r, speeds[i], params));
        if (e && e.candidate.score > best.candidate.score) best = e;
      }
    }
    out.push(best.candidate);
  }

  if (!reduced) {
    // --- Passes en profondeur (§6.1) : cibles receveur + cellules de danger, élagage W > 0,8, les 8 meilleures par EV₁ ---
    // (déviation documentée : la spécification garde les 8 plus petits W ; EV₁ intègre déjà (1 − P_int) et la valeur.)
    const through: Candidate[] = [];
    for (const prop of proposeThroughBalls(state, me, params, fields)) {
      const e = evaluateProposal(ctx, prop);
      if (!e || e.candidate.probability <= 0 || e.weakPhi > LANE_BLOCK_PHI) continue;
      through.push(e.candidate);
    }
    through.sort(compareCandidates);
    for (let i = 0; i < Math.min(MAX_THROUGH, through.length); i++) out.push(through[i]);
  }

  // --- Dribbles ---
  const dribbleDistances = reduced ? params.decision.dribbleDistances.slice(0, 1) : params.decision.dribbleDistances;
  for (const prop of proposeDribbles(state, me, params, dribbleDistances)) {
    const e = evaluateProposal(ctx, prop);
    if (e) out.push(e.candidate);
  }

  // --- Tir (plancher xG_min : un tir désespéré n'est pas une option), conservation, dégagement ---
  const shot = proposeShot(state, me, params);
  if (shot) { const e = evaluateProposal(ctx, shot); if (e && e.candidate.probability >= weights.shotMinXg) out.push(e.candidate); }
  const hold = evaluateProposal(ctx, proposeHold(state, me));
  if (hold) out.push(hold.candidate);
  if (!reduced) {
    const clear = proposeClear(state, me, params);
    if (clear) { const e = evaluateProposal(ctx, clear); if (e) out.push(e.candidate); }
  }

  out.sort(compareCandidates);
  return out;
}

/** Receveur en position de hors-jeu au lancement (§3.4) : la passe n'est pas légale, on ne la propose pas. */
function isReceiverOffside(ctx: EvalContext, r: Player): boolean {
  const xr = ctx.dir * r.pos.x;
  return xr > 0 && xr > ctx.offsideX + 0.5;
}

/** Reconstruit la proposition d'une passe évaluée (pour en dériver la variante lobée). */
function proposalOf(e: Evaluation, speed: number): Proposal {
  const a = e.candidate.action as Extract<Action, { type: 'pass' }>;
  return { kind: 'pass', action: a, receiverId: a.targetId, successPoint: e.candidate.successPoint!, arrivalSpeed: speed };
}

// ---------------------------------------------------------------------------
// Profondeur 2 : état anticipé après succès + réponse pessimiste + meilleure suite
// ---------------------------------------------------------------------------
/** Distance parcourue en `t` s par un joueur parti de l'arrêt après réaction τ (§4.1). */
function runDistance(t: number, vmax: number, amax: number, tau: number): number {
  const s = Math.max(0, t - tau);
  const tAcc = vmax / amax;
  return s <= tAcc ? 0.5 * amax * s * s : (vmax * vmax) / (2 * amax) + vmax * (s - tAcc);
}

/** Identifiant du porteur après succès : le receveur pour une passe, le porteur lui-même sinon (null : pas de suite). */
function nextOwnerId(c: Candidate, playerId: number): number | null {
  const a = c.action;
  if (a.type === 'pass') return a.targetId;
  if (a.type === 'dribble' || a.type === 'hold') return playerId;
  return null;
}

/**
 * Construit l'état anticipé s⁺ après le succès du candidat : joueurs avancés de T_a, receveur au point d'arrivée
 * (porteur du ballon), et les PRESS_DEFENDERS adversaires les plus proches courant vers lui (réponse « press »).
 * Retourne aussi la menace sous press Θ_press(q⁺) et la dégradation δ = Θ(q⁺) − Θ_press(q⁺) due à la réponse.
 */
export function predictSuccessState(state: MatchState, c: Candidate, playerId: number, ownerId: number, params: SimParams): { next: MatchState; delta: number; thetaPress: number } {
  const T = c.duration ?? 0;
  const q = c.successPoint!;
  const players = shallowPlayers(state.players);
  const me = playerById(state, playerId)!;
  const team = me.team;
  for (const p of players) {
    p.pos.x = Math.max(-52.5, Math.min(52.5, p.pos.x + p.vel.x * T));
    p.pos.y = Math.max(-34, Math.min(34, p.pos.y + p.vel.y * T));
    if (p.id === ownerId) {
      p.pos.x = q.x; p.pos.y = q.y;
      if (c.action.type === 'dribble') {
        const v = params.physics.dribbleSpeedFactor * p.maxSpeed;
        p.vel.x = c.action.direction.x * v; p.vel.y = c.action.direction.y * v;
      }
    }
  }
  const next: MatchState = {
    ...state,
    players,
    ball: { ...state.ball, pos: { x: q.x, y: q.y }, vel: { x: 0, y: 0 }, z: 0, vz: 0, ownerId, lastTouchId: ownerId, flight: null },
    possession: team,
  };
  const xT = threatAt(q, team, params);
  const before = xT * pitchControlAt(next, q, team, params);
  // Réponse pessimiste : les deux adversaires les plus proches de q⁺ courent vers lui pendant T.
  const opp = players.filter((p) => p.team !== team).sort((a, b) => (a.pos.x - q.x) ** 2 + (a.pos.y - q.y) ** 2 - ((b.pos.x - q.x) ** 2 + (b.pos.y - q.y) ** 2));
  const tau = params.models.reactionTime;
  for (let i = 0; i < Math.min(PRESS_DEFENDERS, opp.length); i++) {
    const d = opp[i];
    const dx = q.x - d.pos.x, dy = q.y - d.pos.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) continue;
    const covered = runDistance(T, d.maxSpeed, d.maxAccel, tau);
    const remaining = Math.max(PRESS_STANDOFF, dist - covered);
    const ux = dx / dist, uy = dy / dist;
    d.pos.x = q.x - ux * remaining; d.pos.y = q.y - uy * remaining;
    const speed = Math.min(d.maxSpeed, d.maxAccel * Math.max(0, T - tau));
    d.vel.x = ux * speed; d.vel.y = uy * speed;
  }
  const after = xT * pitchControlAt(next, q, team, params);
  return { next, delta: before - after, thetaPress: after };
}

/**
 * Développe un candidat en profondeur 2 (§6.3) :
 *  1. réponse pessimiste « press » : le premier terme devient Θ_press(q⁺) = Θ(q⁺) − δ, chargé avec le poids P
 *     (composante « response », affichée telle quelle par l'explication) ;
 *  2. meilleure suite du nouveau porteur sur s⁺ (jeu réduit, 6 échantillons) et gain incrémental
 *     G = max(0, max EV₁' − Θ_press(q⁺)) (une suite « tir » est aussi comparée au tir immédiat `shotNowEV`) ;
 *     Q = EV₁ − P·δ + P·γ·G, V⁺ ← V⁺ − δ + γ·G.
 */
function expandLookahead(input: DecisionInput, c: Candidate, playerId: number, reducedParams: SimParams, weights: OnBallWeights, shotNowEV: number): void {
  const ownerId = nextOwnerId(c, playerId);
  if (ownerId === null || !c.successPoint) return;
  const gamma = weights.gamma;
  if (gamma <= 0) return;
  const { next, delta, thetaPress } = predictSuccessState(input.state, c, playerId, ownerId, input.params);
  const pressed = Math.max(0, delta);
  if (pressed > EPS) {
    c.components.push({ key: 'response', label: 'Réponse adverse (press du receveur)', value: -pressed, unit: 'but', weight: c.probability, contribution: -c.probability * pressed });
    c.score -= c.probability * pressed;
    c.valueIfSuccess -= pressed;
  }
  c.response = { kind: 'press', delta: pressed };
  const continuation = evaluateCandidates({ ...input, state: next, params: reducedParams }, ownerId, { reduced: true, weights });
  const best = continuation.length > 0 ? continuation[0] : null;
  const maxEV = best ? best.score : 0;
  const baseline = best && best.action.type === 'shoot' ? Math.max(thetaPress, shotNowEV) : thetaPress;
  const gain = Math.max(0, maxEV - baseline);
  const contribution = c.probability * gamma * gain;
  c.components.push({ key: 'lookahead', label: 'Meilleure suite (profondeur 2)', value: gain, unit: 'but', weight: c.probability * gamma, contribution });
  c.score += contribution;
  c.valueIfSuccess += gamma * gain;
}

// ---------------------------------------------------------------------------
// Hystérésis et sélection
// ---------------------------------------------------------------------------
/** Même intention : même type et même cible (§6.5). */
export function sameAction(a: Action, b: Action): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'pass': {
      const bb = b as Extract<Action, { type: 'pass' }>;
      return a.targetId === bb.targetId && a.kind === bb.kind;
    }
    case 'dribble': {
      const bb = b as Extract<Action, { type: 'dribble' }>;
      return a.direction.x * bb.direction.x + a.direction.y * bb.direction.y > 0.98 && Math.abs(a.distance - bb.distance) < 0.5;
    }
    case 'shoot':
    case 'hold':
    case 'clear':
      return true;
    case 'move':
      return false;
  }
}

/**
 * Sélection (§6.5) parmi les candidats à moins de `epsilon` du meilleur (`cands` est trié par score décroissant) :
 *  – température nulle : départage déterministe de l'égalité à ε près ⇒ plus grand P_a, puis plus petit T_a ;
 *  – température > 0 : réponse quantale (McKelvey & Palfrey), softmax de température `temperature` sur la fenêtre ε.
 * Un seul candidat éligible ⇒ argmax.
 */
export function selectCandidate(cands: readonly Candidate[], epsilon: number, temperature: number, rng: { next(): number }): Candidate {
  const best = cands[0].score;
  let n = 1;
  while (n < cands.length && cands[n].score >= best - epsilon) n++;
  if (n <= 1) return cands[0];
  if (temperature <= 0) {
    let pick = cands[0];
    for (let i = 1; i < n; i++) {
      const c = cands[i];
      if (c.probability > pick.probability + 1e-12 || (Math.abs(c.probability - pick.probability) <= 1e-12 && (c.duration ?? 0) < (pick.duration ?? 0))) pick = c;
    }
    return pick;
  }
  let total = 0;
  const w = new Array<number>(n);
  for (let i = 0; i < n; i++) { w[i] = Math.exp((cands[i].score - best) / temperature); total += w[i]; }
  let u = rng.next() * total;
  for (let i = 0; i < n; i++) { u -= w[i]; if (u <= 0) return cands[i]; }
  return cands[n - 1];
}

// ---------------------------------------------------------------------------
// Décision complète
// ---------------------------------------------------------------------------
/** Décision complète du porteur (avec lookahead et hystérésis). */
export function decideOnBall(input: DecisionInput, playerId: number, previous: Decision | null): Decision {
  const t0 = performance.now();
  const { state, fields, params, tactic, rng } = input;
  const me = playerById(state, playerId);
  if (!me) throw new Error(`joueur inconnu : ${playerId}`);
  const team = me.team;
  const phase = state.phase[team];
  const weights = modulatedWeights(params, tactic.params, phase);
  const cands = evaluateCandidates(input, playerId, { detailed: true, weights });
  const origin = state.ball.ownerId === me.id ? state.ball.pos : me.pos;

  // Conservation de secours : la liste ne peut pas être vide (le porteur peut toujours garder le ballon).
  if (cands.length === 0) cands.push(fallbackHold(origin));

  // --- Profondeur 2 sur les K meilleurs ---
  const K = Math.max(0, Math.floor(params.decision.topK));
  if (K > 0 && weights.gamma > 0) {
    const reducedParams: SimParams = { ...params, models: { ...params.models, interceptSamples: Math.min(REDUCED_SAMPLES, params.models.interceptSamples) } };
    const shotNowEV = cands.find((c) => c.action.type === 'shoot')?.score ?? -Infinity;
    const expanded = cands.slice(0, Math.min(K, cands.length));
    for (const c of expanded) expandLookahead(input, c, playerId, reducedParams, weights, shotNowEV);
  }

  // --- Hystérésis ---
  let kept: Candidate | null = null;
  if (previous && previous.playerId === playerId && weights.hysteresis > 0) {
    const prevAction = previous.chosen.action;
    const match = cands.find((c) => sameAction(c.action, prevAction));
    if (match) {
      match.components.push({ key: 'hysteresis', label: 'Hystérésis (intention courante)', value: 1, weight: weights.hysteresis, contribution: weights.hysteresis });
      match.score += weights.hysteresis;
      kept = match;
    }
  }

  // Les décompositions modifiées reçoivent une nouvelle phrase.
  const pressureBall = pressureAt(state, origin, team, params);
  for (const c of cands) if (c.components.some((k) => k.key === 'lookahead' || k.key === 'response' || k.key === 'hysteresis')) c.reason = buildReason(c, state, pressureBall);

  cands.sort(compareCandidates);
  const chosen = selectCandidate(cands, params.decision.epsilonTie, params.decision.softmaxTemperature, rng);

  let keptByHysteresis = false;
  if (kept && chosen === kept) {
    for (const c of cands) if (c !== kept && c.score > kept.score - weights.hysteresis + EPS) { keptByHysteresis = true; break; }
  }

  const context = buildContext(input, me, cands, origin, pressureBall);
  const computeMs = performance.now() - t0;
  const decision: Decision = {
    playerId,
    time: state.time,
    chosen,
    candidates: cands,
    context,
    explanation: '',
    computeMs,
  };
  if (keptByHysteresis) decision.keptByHysteresis = true;
  // Engagement (§6.5) : seules les actions qui gardent le ballon (dribble, conservation) durent ; une passe, un tir
  // ou un dégagement sont exécutés immédiatement et libèrent le ballon.
  const a = chosen.action;
  if ((a.type === 'dribble' || a.type === 'hold') && chosen.duration !== undefined && chosen.duration > 0) {
    decision.committedUntil = state.time + chosen.duration;
  }
  decision.explanation = explainDecision(decision, state);
  decision.computeMs = performance.now() - t0;
  return decision;
}

/** Candidat de conservation minimal (état dégénéré, aucun modèle évaluable). */
function fallbackHold(origin: Vec2): Candidate {
  return {
    action: { type: 'hold' }, score: 0, probability: 1, valueIfSuccess: 0, valueIfFailure: 0, components: [],
    reason: 'aucune autre option évaluable', duration: 0, successPoint: { x: origin.x, y: origin.y }, failurePoint: { x: origin.x, y: origin.y },
  };
}

/** Contexte de la décision : phase, style, formation, pression, coéquipiers disponibles, supériorité locale. */
function buildContext(input: DecisionInput, me: Player, cands: readonly Candidate[], origin: Vec2, pi: number): DecisionContext {
  const { state, params, tactic } = input;
  const team = me.team;
  let available = 0;
  for (const c of cands) if (c.action.type === 'pass' && c.action.kind === 'ground' && c.probability >= 0.5) available++;
  return {
    phase: state.phase[team],
    style: tactic.style,
    formation: tactic.formation,
    pressure: Math.max(0, Math.min(1, pi / 2)),
    availableTeammates: available,
    localSuperiority: localSuperiority(state, origin, team, params),
  };
}
