/**
 * Décision du porteur de balle (docs/CONCEPTION.md §6) : génération des candidats (passes, passes en
 * profondeur, dribbles, tir, conservation, dégagement), évaluation par espérance de valeur avec risque
 * (evaluate.ts), anticipation à deux coups (expectimax profondeur 2 sur les K meilleurs candidats avec une
 * réponse adverse pessimiste), hystérésis, sélection (argmax, départage ε, réponse quantale) et explication.
 *
 * Score final d'un candidat développé (§6.3, minimax sur l'ensemble de réponses R = {hold, press, cover, drop}) :
 *   Q(a) = EV₁(a) + P_a · min_{r ∈ R} [Θ_r(q⁺) + γ · G(a, r)] − P_a · Θ_hold(q⁺)
 *        = EV₁(a) − P_a · δ_a + P_a · γ · G(a, r*)          (composantes « response » et « lookahead »)
 *   r*   = argmin_r [Θ_r(q⁺) + γ · G(a, r)], mémorisé dans candidate.response = { kind: r*, delta: δ_a } ;
 *   δ_a  = Θ_hold(q⁺) − Θ_r*(q⁺) : dégradation de la menace par la réponse adverse (≥ 0 pour hold et press ;
 *          cover et drop peuvent éloigner un défenseur de q⁺ et dégrader la suite plutôt que la menace) ;
 *   G(a, r) = max(0, max_{a'} EV₁(a' | s⁺_{a,r}) − Θ_r(q⁺)) : gain incrémental de la meilleure suite sur l'état ajusté
 *          par r (jeu réduit), au-delà de la menace déjà comptée en q⁺ (la conservation garantit G ≳ 0 : aucun double
 *          comptage, et un candidat non développé — Q = EV₁ — ne peut dépasser un candidat développé que si la
 *          meilleure réponse dégrade réellement ce dernier). Une suite « tir » est comparée aussi au tir immédiat,
 *          sinon « dribbler puis tirer » serait crédité de tout xG'.
 * s⁺_{a,r} est l'état anticipé après succès (responses.ts) : joueurs avancés de T_a, ballon au point d'arrivée, receveur
 * porteur, puis 2–3 défenseurs re-ciblés selon r avec le modèle de mouvement §4.1 (réaction puis accélération bornée).
 * Le nombre de réponses évaluées est params.decision.responseCount (4 ; minimum 2 = hold + press).
 *
 * Jeu 2×2 (§6.4, game2x2.ts) : lorsque les deux meilleurs candidats après profondeur 2 sont de classes différentes
 * parmi {tir, passe, dribble} et à moins de ε_game l'un de l'autre, M[k][l] = Q(a_k | r_l) avec r ∈ {press, cover}
 * (un tir, exécuté avant tout re-ciblage, garde sa valeur sous les deux réponses) ; point-selle ⇒ action pure, sinon
 * stratégie mixte tirée au RNG à graine et engagée pour sa durée (Decision.game, committedUntil).
 *
 * Hystérésis (§6.5) : l'intention courante (passe, dribble, tir, dégagement — pas la conservation) reçoit +h et est
 * conservée SANS nouveau tirage tant qu'aucun candidat ne la bat de plus de h ; sinon sélection (argmax, départage ε par
 * P puis T, ou réponse quantale). Un re-tirage à chaque cycle parmi les candidats à ε du meilleur produisait des
 * dribbles en zigzag (0,6–0,7 changement d'intention par seconde).
 * Engagement (§6.5) : un dribble ou une conservation choisis portent `committedUntil` (durée de l'action) ; le
 * moteur (loop.ts) ne re-décide pas un dribble engagé tant que le porteur garde le ballon et n'a pas atteint sa cible.
 *
 * Aucune allocation profonde : l'état anticipé est une copie superficielle des joueurs (positions dupliquées).
 */
import type { Vec2 } from '../core/vec2';
import type { Action, Candidate, Decision, DecisionContext, DefensiveResponse, Game2x2, MatchState, Player, SimParams } from '../core/types';
import type { DecisionInput } from './policy';
import { actionOrigin, planPassVariants, proposeClear, proposeDribbles, proposeHold, proposeLob, proposePass, proposeShot, proposeThroughBalls, rollsIntoOwnGoal, type Proposal } from './candidates';
import { buildReason, createEvalContext, evaluateProposal, modulatedWeights, LANE_BLOCK_PHI, type EvalContext, type Evaluation, type OnBallWeights } from './evaluate';
import { explainDecision, shortLabel } from './explain';
import { drawAction, gameClass, solve2x2, type GameMatrix } from './game2x2';
import { applyResponse, bestOnwardLane, MIN_RESPONSES, nextOwnerId, predictHoldState, RESPONSES, RESPONSE_LABELS, responseThreat, type OnwardLane } from './responses';
import { localSuperiority } from '../models/structure';
import { pressureAt } from '../models/fields';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
/** Nombre maximal de passes en profondeur conservées (§6.1). */
const MAX_THROUGH = 8;
/** Nombre d'échantillons d'interception du jeu réduit (profondeur 2, §6.3). */
const REDUCED_SAMPLES = 6;
/** Seuil de contribution en deçà duquel une composante de lookahead n'est pas listée. */
const EPS = 1e-12;
/** Réponses du jeu 2×2 (§6.4) : tir/passe et passe/dribble ⇒ {press, cover}. */
const GAME_RESPONSES: [DefensiveResponse, DefensiveResponse] = ['press', 'cover'];
/** Replis des paramètres optionnels (append-only dans SimParams). */
const DEFAULT_RESPONSE_COUNT = 4;
const DEFAULT_RESPONSE_REEVALUATE = 4;
const DEFAULT_GAME_COMMIT_MIN = 1.0;

/** Valeur Q(a | r) d'un candidat développé sous chaque réponse évaluée (matrice du jeu 2×2). */
type ResponseValues = Partial<Record<DefensiveResponse, number>>;

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
 * Passes : la vitesse d'arrivée par défaut est évaluée d'abord ; les variantes (autres vitesses, passe appuyée, lob)
 * suivent le plan `planPassVariants` (candidates.ts, §6.1) : ligne fermée ⇒ vitesses élaguées et lob au-delà de 25 m ;
 * cible longue (> decision.longPassDistance) ⇒ passe appuyée ET lob toujours évalués. La liste finale garde la
 * meilleure passe au sol par coéquipier, plus la meilleure variante lobée lorsqu'elle a été évaluée (candidat distinct).
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
  // Une passe dont la course résiduelle franchirait sa propre ligne de but n'est pas proposée (rollsIntoOwnGoal).
  const safePass = (r: Player, speed: number): Proposal | null => {
    const prop = proposePass(state, me, r, speed, params);
    return rollsIntoOwnGoal(actionOrigin(state, me), prop.successPoint, speed, me.team, params) ? null : prop;
  };
  for (const r of state.players) {
    if (r.team !== me.team || r.id === me.id) continue;
    if (isReceiverOffside(ctx, r)) continue;
    const firstProp = safePass(r, speeds[0]);
    const first = firstProp ? evaluateProposal(ctx, firstProp) : null;
    if (!first) continue;
    let best: Evaluation = first;
    const plan = planPassVariants(first.distance, first.blocked, speeds, params, reduced);
    for (const speed of plan.speeds) {
      const prop = safePass(r, speed);
      const e = prop ? evaluateProposal(ctx, prop) : null;
      if (e && e.candidate.score > best.candidate.score) best = e;
    }
    out.push(best.candidate);
    if (plan.lob) {
      const lob = evaluateProposal(ctx, proposeLob(proposalOf(first, speeds[0]), first.logit));
      if (lob) out.push(lob.candidate);
    }
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

  // Meilleure passe disponible (toutes variantes) : porte de la pression du temps de possession sur dribble et conservation.
  for (const c of out) if (c.probability > ctx.bestPassP) ctx.bestPassP = c.probability;

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
// Profondeur 2 : état anticipé après succès + ensemble de réponses (minimax) + meilleure suite
// ---------------------------------------------------------------------------
/**
 * Développe un candidat en profondeur 2 (§6.3) sur les `responses` évaluées (hold en tête) :
 *  1. état de base s⁺_hold (responses.ts) et Θ_hold(q⁺) ; pour chaque réponse r : état ajusté s⁺_{a,r}, menace
 *     Θ_r(q⁺) (contrôle exact au point d'arrivée), meilleure suite du nouveau porteur (jeu réduit, 6 échantillons) et
 *     gain incrémental G(a, r) = max(0, max EV₁' − Θ_r(q⁺)) (une suite « tir » est aussi comparée au tir immédiat
 *     `shotNowEV`) ; la ligne de passe de `cover` est la meilleure passe de la suite sous `hold` ;
 *  2. r* = argmin_r [Θ_r + γ·G(a, r)] ; composantes « response » = −P·δ (δ = Θ_hold − Θ_r*) et « lookahead » = P·γ·G(a, r*) ;
 *     Q = EV₁ − P·δ + P·γ·G(a, r*), V⁺ ← V⁺ − δ + γ·G(a, r*).
 * Retourne Q(a | r) pour chaque réponse évaluée (matrice du jeu 2×2), null si le candidat n'a pas de suite.
 */
function expandLookahead(input: DecisionInput, c: Candidate, playerId: number, reducedParams: SimParams, weights: OnBallWeights, shotNowEV: number, responses: readonly DefensiveResponse[]): ResponseValues | null {
  const ownerId = nextOwnerId(c, playerId);
  if (ownerId === null || !c.successPoint) return null;
  const gamma = weights.gamma;
  if (gamma <= 0) return null;
  const { state, params } = input;
  const me = playerById(state, playerId)!;
  const team = me.team;
  const q = c.successPoint;
  const T = c.duration ?? 0;
  const P = c.probability;
  const ev1 = c.score;
  const base = predictHoldState(state, c, playerId, ownerId, params);
  const thetaHold = responseThreat(base, q, team, params);
  const values: ResponseValues = {};
  const m = Math.max(0, Math.floor(params.decision.responseReevaluate ?? DEFAULT_RESPONSE_REEVALUATE));
  let lane: OnwardLane | null = null;
  let holdTop: Candidate[] = [];
  let best: { kind: DefensiveResponse; value: number; theta: number; gain: number } | null = null;
  for (const r of responses) {
    let next: MatchState;
    let theta: number;
    if (r === 'hold') { next = base; theta = thetaHold; }
    else {
      const adjusted = applyResponse(r, base, q, team, T, params, lane);
      if (!adjusted) { values[r] = values.hold; continue; } // réponse sans effet ⇒ identique à hold
      next = adjusted;
      theta = responseThreat(next, q, team, params);
    }
    let top: { score: number; shot: boolean } | null;
    if (r === 'hold' || m === 0) {
      const continuation = evaluateCandidates({ ...input, state: next, params: reducedParams }, ownerId, { reduced: true, weights });
      if (r === 'hold') { lane = bestOnwardLane(continuation, q); holdTop = continuation.slice(0, m); }
      top = continuation.length > 0 ? { score: continuation[0].score, shot: continuation[0].action.type === 'shoot' } : null;
    } else {
      top = reevaluateContinuation(input, next, ownerId, holdTop, reducedParams, weights);
    }
    const maxEV = top ? top.score : 0;
    const baseline = top && top.shot ? Math.max(theta, shotNowEV) : theta;
    const gain = Math.max(0, maxEV - baseline);
    const value = theta + gamma * gain;
    values[r] = ev1 + P * (value - thetaHold);
    if (!best || value < best.value - EPS) best = { kind: r, value, theta, gain };
  }
  if (!best) return null;
  const delta = thetaHold - best.theta;
  if (Math.abs(delta) > EPS) {
    c.components.push({ key: 'response', label: `Réponse adverse (${RESPONSE_LABELS[best.kind]})`, value: -delta, unit: 'but', weight: P, contribution: -P * delta });
    c.score -= P * delta;
    c.valueIfSuccess -= delta;
  }
  c.response = { kind: best.kind, delta };
  const contribution = P * gamma * best.gain;
  c.components.push({ key: 'lookahead', label: 'Meilleure suite (profondeur 2)', value: best.gain, unit: 'but', weight: P * gamma, contribution });
  c.score += contribution;
  c.valueIfSuccess += gamma * best.gain;
  return values;
}

/**
 * Meilleure suite sous une réponse r ≠ hold, par ré-évaluation des `holdTop` meilleures suites trouvées sous `hold` sur
 * l'état ajusté `next` (les attaquants n'y bougent pas ; seuls 1–4 défenseurs sont re-ciblés, donc la meilleure suite
 * sous r est, à de rares exceptions près, parmi les meilleures sous hold — une suite hors de cette liste qui
 * s'améliorerait grâce au re-ciblage est ignorée : G(a, r) est alors sous-estimé, dans le sens pessimiste du minimax).
 * Coût : m évaluations au lieu des ≈ 20 du jeu réduit complet (mesure : scripts/bench.ts, voir params.ts).
 */
function reevaluateContinuation(input: DecisionInput, next: MatchState, ownerId: number, holdTop: readonly Candidate[], reducedParams: SimParams, weights: OnBallWeights): { score: number; shot: boolean } | null {
  const owner = playerById(next, ownerId);
  if (!owner || holdTop.length === 0) return null;
  const ctx = createEvalContext(next, input.fields, reducedParams, weights, owner, false, false);
  let best: { score: number; shot: boolean } | null = null;
  for (const c of holdTop) {
    let prop: Proposal | null = null;
    const a = c.action;
    switch (a.type) {
      case 'pass': {
        const receiver = playerById(next, a.targetId);
        if (!receiver) break;
        const ground = proposePass(next, owner, receiver, a.speed, reducedParams);
        prop = a.kind === 'lob' ? proposeLob(ground) : ground;
        break;
      }
      case 'dribble':
        prop = c.successPoint ? { kind: 'dribble', action: a, receiverId: -1, successPoint: c.successPoint } : null;
        break;
      case 'shoot':
        prop = proposeShot(next, owner, reducedParams);
        break;
      case 'hold':
        prop = proposeHold(next, owner);
        break;
      default:
        break;
    }
    if (!prop) continue;
    const e = evaluateProposal(ctx, prop);
    if (!e) continue;
    if (prop.kind === 'shot' && e.candidate.probability < weights.shotMinXg) continue;
    if (!best || e.candidate.score > best.score) best = { score: e.candidate.score, shot: prop.kind === 'shot' };
  }
  return best;
}

/** Réponses évaluées : les `responseCount` premières de R (hold, press, cover, drop), au moins hold + press. */
function activeResponses(params: SimParams): readonly DefensiveResponse[] {
  const n = Math.floor(params.decision.responseCount ?? DEFAULT_RESPONSE_COUNT);
  return RESPONSES.slice(0, Math.max(MIN_RESPONSES, Math.min(RESPONSES.length, n)));
}

// ---------------------------------------------------------------------------
// Jeu 2×2 (§6.4)
// ---------------------------------------------------------------------------
/**
 * Dilemme entre les deux meilleurs candidats (`a1`, `a2` triés) : classes différentes parmi {tir, passe, dribble} et
 * |Q₁ − Q₂| < ε_game. Matrice M[k][l] = Q(a_k | r_l), r ∈ {press, cover} : valeurs de la profondeur 2 pour une passe ou un
 * dribble ; un tir garde Q sous les deux réponses (il est exécuté avant tout re-ciblage). Retourne l'action tirée et le
 * jeu résolu, ou null si le dilemme ne se présente pas (ou si une valeur manque : candidat non développé).
 */
function playGame(a1: Candidate, a2: Candidate, values: Map<Candidate, ResponseValues>, input: DecisionInput, playerId: number): { chosen: Candidate; game: Game2x2 } | null {
  const k1 = gameClass(a1.action), k2 = gameClass(a2.action);
  if (!k1 || !k2 || k1 === k2) return null;
  if (Math.abs(a1.score - a2.score) >= input.params.decision.epsilonGame) return null;
  const row = (c: Candidate): [number, number] | null => {
    if (c.action.type === 'shoot') return [c.score, c.score];
    const v = values.get(c);
    if (!v) return null;
    // Une réponse non évaluée (responseCount < 4) vaut « hold » : la défense n'y re-cible personne.
    const m0 = v[GAME_RESPONSES[0]] ?? v.hold, m1 = v[GAME_RESPONSES[1]] ?? v.hold;
    if (m0 === undefined || m1 === undefined) return null;
    return [m0, m1];
  };
  const r1 = row(a1), r2 = row(a2);
  if (!r1 || !r2) return null;
  const matrix: GameMatrix = [r1, r2];
  const sol = solve2x2(matrix);
  const pick = drawAction(sol, input.rng);
  const state = input.state;
  const game: Game2x2 = {
    actions: [shortLabel(a1, state, playerId), shortLabel(a2, state, playerId)],
    responses: [GAME_RESPONSES[0], GAME_RESPONSES[1]],
    matrix,
    pure: sol.pure,
    pi1: sol.pi1,
    value: sol.value,
  };
  return { chosen: pick === 0 ? a1 : a2, game };
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

  // --- Profondeur 2 sur les K meilleurs : minimax sur les réponses évaluées (§6.3) ---
  const K = Math.max(0, Math.floor(params.decision.topK));
  const responseValues = new Map<Candidate, ResponseValues>();
  if (K > 0 && weights.gamma > 0) {
    const reducedParams: SimParams = { ...params, models: { ...params.models, interceptSamples: Math.min(REDUCED_SAMPLES, params.models.interceptSamples) } };
    const shotNowEV = cands.find((c) => c.action.type === 'shoot')?.score ?? -Infinity;
    const responses = activeResponses(params);
    const expanded = cands.slice(0, Math.min(K, cands.length));
    for (const c of expanded) {
      const v = expandLookahead(input, c, playerId, reducedParams, weights, shotNowEV, responses);
      if (v) responseValues.set(c, v);
    }
  }

  // --- Hystérésis (§6.5) : l'intention courante a_cur reçoit +h ; elle est conservée sauf si Q(a_new) > Q(a_cur) + h ---
  // (le meilleur candidat de même intention est retenu : la liste n'est plus triée après la profondeur 2).
  // Une conservation n'est pas une intention à protéger (attente de T_hold puis nouvelle décision) : sans cette
  // exclusion, un porteur sans option pourrait conserver indéfiniment, rien ne battant la conservation de plus de h.
  let kept: Candidate | null = null;
  if (previous && previous.playerId === playerId && weights.hysteresis > 0 && previous.chosen.action.type !== 'hold') {
    const prevAction = previous.chosen.action;
    for (const c of cands) if (sameAction(c.action, prevAction) && (!kept || c.score > kept.score)) kept = c;
    if (kept) {
      kept.components.push({ key: 'hysteresis', label: 'Hystérésis (intention courante)', value: 1, weight: weights.hysteresis, contribution: weights.hysteresis });
      kept.score += weights.hysteresis;
    }
  }

  // Les décompositions modifiées reçoivent une nouvelle phrase.
  const pressureBall = pressureAt(state, origin, team, params);
  for (const c of cands) if (c.components.some((k) => k.key === 'lookahead' || k.key === 'response' || k.key === 'hysteresis')) c.reason = buildReason(c, state, pressureBall);

  cands.sort(compareCandidates);
  // Sélection : une intention courante non battue (à h près) est conservée sans nouveau tirage — sinon la réponse
  // quantale re-tirerait chaque cycle parmi les candidats à ε du meilleur (zigzag de dribbles, §6.4 « pas de re-tirage »).
  // Sinon, dilemme (§6.4) entre les deux meilleurs candidats ⇒ jeu 2×2 ; à défaut, sélection §6.5.
  const useKept = kept !== null && kept.score >= cands[0].score - EPS;
  const played = !useKept && cands.length >= 2 ? playGame(cands[0], cands[1], responseValues, input, playerId) : null;
  const chosen = played ? played.chosen : useKept ? kept! : selectCandidate(cands, params.decision.epsilonTie, params.decision.softmaxTemperature, rng);

  let keptByHysteresis = false;
  if (kept && chosen === kept && useKept) {
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
  if (played) decision.game = played.game;
  // Engagement (§6.5) : seules les actions qui gardent le ballon (dribble, conservation) durent ; une passe, un tir
  // ou un dégagement sont exécutés immédiatement et libèrent le ballon. Une action tirée au jeu 2×2 (§6.4) est engagée
  // pour toute sa durée (au moins gameCommitMin s pour un dribble ou une conservation) : pas de re-tirage à chaque cycle.
  const a = chosen.action;
  const keepsBall = a.type === 'dribble' || a.type === 'hold';
  if (chosen.duration !== undefined && chosen.duration > 0) {
    if (played) decision.committedUntil = state.time + (keepsBall ? Math.max(chosen.duration, params.decision.gameCommitMin ?? DEFAULT_GAME_COMMIT_MIN) : chosen.duration);
    else if (keepsBall) decision.committedUntil = state.time + chosen.duration;
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
