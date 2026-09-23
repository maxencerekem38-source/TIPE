/**
 * Boucle de simulation : décision (période params.decisionPeriod) → exécution → physique → règles → phases.
 * La fonction de décision est injectable (`options.decide`) : par défaut `decideAll` de src/decision/coordinator
 * avec `FULL_POLICY` pour les deux équipes ; les tests fournissent une décision factice.
 */
import type { MatchConfig, MatchState, Decision, SimParams, TacticConfig, TeamId, Action } from '../core/types';
import { Rng } from '../core/rng';
import type { PolicySet } from '../decision/policy';
import * as coordinator from '../decision/coordinator';
import { createMatch } from './match';
import { executeAction } from './actions';
import { stepPhysics } from './physics';
import { applyRules, updatePhases } from './rules';
import { isFrozen, playerById } from './helpers';

/** Signature de la fonction de décision d'un cycle (identique à `decideAll`). */
export type DecideFn = (
  state: MatchState,
  params: SimParams,
  policies: Record<TeamId, PolicySet>,
  previous: Map<number, Decision>,
  rng: Rng,
) => Map<number, Decision>;

export interface StepOptions {
  /** Politiques de décision par équipe (par défaut : l'algorithme complet). */
  policies?: Record<'A' | 'B', PolicySet>;
  /** Appelé après chaque cycle de décision avec les décisions prises. */
  onDecisions?: (decisions: Map<number, Decision>, state: MatchState) => void;
  /** Fonction de décision (par défaut `decideAll`) — injectable pour les tests et les baselines. */
  decide?: DecideFn;
}

export type SimulationOptions = StepOptions;

export interface Simulation {
  state: MatchState;
  config: MatchConfig;
  rng: Rng;
  /** Avance d'un pas de physique (et lance un cycle de décision si nécessaire). */
  step(options?: StepOptions): void;
  /** Avance de `seconds` secondes. */
  advance(seconds: number, options?: StepOptions): void;
  /** Dernières décisions par joueur. */
  decisions: Map<number, Decision>;
}

/** Simulation du moteur : `Simulation` enrichie des aides de pilotage (remise à zéro, tactiques, fin de match). */
export interface EngineSimulation extends Simulation {
  /** Instant du prochain cycle de décision (s). */
  nextDecisionTime: number;
  /** Le match a atteint `config.durationSec`. */
  readonly finished: boolean;
  /** Remet le match à zéro (même graine ⇒ même match). `state` et `rng` sont remplacés. */
  reset(): void;
  /** Change la tactique d'une équipe en cours de match. */
  setTactics(team: TeamId, tactic: TacticConfig): void;
}

/** Politique de substitution lorsque `FULL_POLICY` n'est pas encore disponible (une `decide` factice l'ignore). */
const UNAVAILABLE_POLICY: PolicySet = {
  name: 'indisponible',
  onBall: () => { throw new Error('non implémenté : politique de décision indisponible'); },
  offBall: () => { throw new Error('non implémenté : politique de décision indisponible'); },
  defence: () => { throw new Error('non implémenté : politique de décision indisponible'); },
};

function defaultPolicies(): Record<TeamId, PolicySet> {
  const full = (coordinator as { FULL_POLICY?: PolicySet }).FULL_POLICY ?? UNAVAILABLE_POLICY;
  return { A: full, B: full };
}

export function createSimulation(config: MatchConfig, options: SimulationOptions = {}): EngineSimulation {
  const cfg: MatchConfig = { ...config, tactics: { A: config.tactics.A, B: config.tactics.B } };
  const initialRng = new Rng(cfg.seed);
  const sim: EngineSimulation = {
    state: createMatch(cfg, initialRng),
    config: cfg,
    rng: initialRng,
    decisions: new Map(),
    nextDecisionTime: 0,
    get finished(): boolean {
      return sim.state.time >= cfg.durationSec - 1e-9;
    },
    step(stepOptions?: StepOptions): void {
      stepOnce(sim, stepOptions ? { ...options, ...stepOptions } : options);
    },
    advance(seconds: number, stepOptions?: StepOptions): void {
      const n = Math.round(seconds / cfg.params.physics.dt);
      const merged = stepOptions ? { ...options, ...stepOptions } : options;
      for (let i = 0; i < n; i++) stepOnce(sim, merged);
    },
    reset(): void {
      sim.rng = new Rng(cfg.seed);
      sim.state = createMatch(cfg, sim.rng);
      sim.decisions = new Map();
      sim.nextDecisionTime = 0;
    },
    setTactics(team: TeamId, tactic: TacticConfig): void {
      cfg.tactics[team] = tactic;
      sim.state.tactics[team] = tactic;
    },
  };
  return sim;
}

/** Un dribble engagé est abandonné lorsque le porteur est à moins de cette distance (m) de sa cible. */
const COMMIT_ARRIVAL = 1.5;

/**
 * Décision engagée du porteur (§6.4–6.5, `committedUntil`) : un dribble en cours n'est pas re-décidé tant que sa
 * durée n'est pas écoulée, que le porteur a toujours le ballon et n'a pas atteint sa cible, hors gel de jeu.
 * Les passes, tirs et dégagements libèrent le ballon et n'ont pas besoin d'engagement.
 */
function committedDecision(sim: EngineSimulation): Decision | null {
  const state = sim.state;
  const ownerId = state.ball.ownerId;
  if (ownerId === null || isFrozen(state)) return null;
  const prev = sim.decisions.get(ownerId);
  if (!prev || prev.playerId !== ownerId || prev.committedUntil === undefined || prev.committedUntil <= state.time) return null;
  if (prev.chosen.action.type !== 'dribble') return null;
  const player = playerById(state, ownerId);
  if (!player || !player.target) return null;
  if (Math.hypot(player.target.x - player.pos.x, player.target.y - player.pos.y) <= COMMIT_ARRIVAL) return null;
  return prev;
}

/** Politiques dont la décision du porteur est remplacée par sa décision engagée (aucun calcul pour lui). */
function withCommitment(policies: Record<TeamId, PolicySet>, committed: Decision): Record<TeamId, PolicySet> {
  const out = { ...policies };
  for (const team of ['A', 'B'] as const) {
    const base = policies[team];
    out[team] = { ...base, onBall: (input, playerId, previous) => (playerId === committed.playerId ? committed : base.onBall(input, playerId, previous)) };
  }
  return out;
}

/** Un pas de simulation (§13.2). */
function stepOnce(sim: EngineSimulation, options: StepOptions): void {
  const state = sim.state;
  const cfg = sim.config;
  const params = cfg.params;
  const dt = params.physics.dt;

  // 1. Cycle de décision (pas pendant le gel d'un coup d'envoi : les joueurs rejoignent leurs postes)
  const kickoffFreeze = state.restart !== null && state.restart.kind === 'kickoff' && isFrozen(state);
  if (state.time >= sim.nextDecisionTime - 1e-9 && !kickoffFreeze) {
    const decide = options.decide ?? coordinator.decideAll;
    const committed = committedDecision(sim);
    let policies = options.policies ?? defaultPolicies();
    if (committed) policies = withCommitment(policies, committed);
    const decisions = decide(state, params, policies, sim.decisions, sim.rng);
    if (committed) decisions.set(committed.playerId, committed); // même si `decide` ignore les politiques
    for (const [id, decision] of decisions) {
      if (decision === committed) continue; // engagée : cible de course inchangée, pas de nouvelle comptabilité
      applyDecision(state, id, decision, params, sim.rng);
    }
    sim.decisions = decisions;
    sim.nextDecisionTime = state.time + params.decisionPeriod;
    options.onDecisions?.(decisions, state);
  }

  // 2–4. Physique, règles, phases
  stepPhysics(state, params, sim.rng, dt);
  applyRules(state, cfg, sim.rng);
  updatePhases(state, cfg);
  state.time += dt;
  state.tick++;
}

/** Exécute une décision et tient la comptabilité (décisions, latence, regret, xG, probabilité attendue). */
function applyDecision(state: MatchState, playerId: number, decision: Decision, params: SimParams, rng: Rng): void {
  const player = playerById(state, playerId);
  if (!player) return;
  player.decision = decision;
  player.lastDecisionTime = state.time;
  const chosen = decision.chosen;
  let action: Action = chosen.action;
  if (action.type === 'shoot' && action.xg === undefined) action = { ...action, xg: chosen.probability };
  const executed = executeAction(state, playerId, action, params, rng);
  const s = state.stats[player.team];
  s.decisions++;
  s.decisionMs += Number.isFinite(decision.computeMs) ? decision.computeMs : 0;
  // Regret (§11.1) : uniquement la décision du porteur (scores en buts) ; les tâches défensives sont des coûts en
  // secondes et l'affectation collective s'écarte volontairement de l'optimum individuel.
  if (action.type !== 'move') {
    s.onBallDecisions = (s.onBallDecisions ?? 0) + 1;
    if (decision.candidates.length > 0) s.regret += Math.max(0, decision.candidates[0].score - chosen.score);
  }
  if (executed && action.type === 'pass') {
    const fl = state.ball.flight;
    if (fl && fl.kickerId === playerId) fl.expectedP = chosen.probability;
  }
}
