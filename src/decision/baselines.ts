/**
 * Politiques de référence (docs/CONCEPTION.md §11.3) :
 *  - random (B0) : choix uniforme parmi les candidats du porteur (rng injecté) ;
 *  - greedy_progress (B1) : plus grande progression vers le but parmi les candidats à P ≥ 0,3 ;
 *  - greedy_safe (B1′) : candidat de plus grande probabilité de réussite ;
 *  - no_lookahead (B2) : γ = 0 ; no_risk (B4) : λ_risk = 0 ; no_tactic (B7) : paramètres tactiques équilibrés ;
 *  - nearest_man (B6) : affectation défensive gloutonne (au lieu de l'algorithme hongrois).
 * Chaque baseline réutilise FULL_POLICY pour les autres rôles. Les candidats restent triés par le score de
 * l'évaluation COMPLÈTE, de sorte que le regret (meilleur score − score de l'action choisie) est mesurable.
 */
import type { Candidate, Decision, SimParams, TacticConfig, TeamId } from '../core/types';
import { attackDir } from '../core/types';
import type { Rng } from '../core/rng';
import { BALANCED_PARAMS } from '../tactics/styles';
import { fmtFr } from './explain';
import { FULL_POLICY } from './coordinator';
import { decideDefence } from './defence';
import { decideOnBall } from './onball';
import type { DecisionInput, PolicySet } from './policy';

/** Probabilité minimale d'un candidat pour la baseline gloutonne « progression ». */
export const GREEDY_MIN_PROBABILITY = 0.3;

/** Point d'arrivée d'un candidat (succès) : successPoint, sinon cible de l'action, sinon le ballon. */
export function candidateEndPoint(c: Candidate, ballX: number, ballY: number): { x: number; y: number } {
  if (c.successPoint) return c.successPoint;
  const a = c.action;
  switch (a.type) {
    case 'pass': case 'clear': case 'shoot': return a.targetPoint;
    case 'dribble': return { x: ballX + a.direction.x * a.distance, y: ballY + a.direction.y * a.distance };
    case 'move': return a.target;
    default: return { x: ballX, y: ballY };
  }
}

/** Choix uniforme parmi les candidats (B0). */
export const pickRandom = (candidates: readonly Candidate[], rng: Rng): Candidate => candidates[Math.floor(rng.next() * candidates.length)];

/** Plus grande progression Δx vers le but parmi les candidats à P ≥ minP (B1) ; repli sur le plus sûr si aucun. */
export function pickGreedyProgress(candidates: readonly Candidate[], dir: 1 | -1, ballX: number, ballY: number, minP = GREEDY_MIN_PROBABILITY): Candidate {
  let best: Candidate | null = null, bestDx = -Infinity;
  for (const c of candidates) {
    if (c.probability < minP) continue;
    const end = candidateEndPoint(c, ballX, ballY);
    const dx = dir * (end.x - ballX);
    if (dx > bestDx) { bestDx = dx; best = c; }
  }
  return best ?? pickGreedySafe(candidates);
}

/** Candidat de plus grande probabilité (B1′) ; à égalité, le meilleur score. */
export function pickGreedySafe(candidates: readonly Candidate[]): Candidate {
  let best = candidates[0];
  for (const c of candidates) if (c.probability > best.probability || (c.probability === best.probability && c.score > best.score)) best = c;
  return best;
}

/** Remplace l'action choisie d'une décision complète en conservant la liste triée des candidats (regret mesurable). */
export function withChosen(decision: Decision, chosen: Candidate, name: string): Decision {
  const best = decision.candidates[0];
  const regret = best ? best.score - chosen.score : 0;
  return {
    ...decision,
    chosen,
    keptByHysteresis: undefined,
    committedUntil: undefined,
    game: undefined,
    explanation: `Baseline « ${name} » : ${chosen.reason}\nRegret par rapport à l’algorithme complet : ${fmtFr(regret, 3)} (meilleur score ${fmtFr(best ? best.score : chosen.score, 3)}).`,
  };
}

const withParams = (input: DecisionInput, patch: (p: SimParams) => SimParams): DecisionInput => ({ ...input, params: patch(input.params) });
const withDecision = (input: DecisionInput, patch: Partial<SimParams['decision']>): DecisionInput =>
  withParams(input, (p) => ({ ...p, decision: { ...p.decision, ...patch } }));
const neutralTactic = (t: TacticConfig): TacticConfig => ({ ...t, params: { ...BALANCED_PARAMS } });
/**
 * Tactique neutralisée pour `team` : `input.tactic` ET `state.tactics[team]` (lus par slotPosition / isRunner : largeur,
 * compacité, hauteur de ligne), sur une copie superficielle de l'état — l'ablation B7 porte ainsi sur toute la géométrie.
 */
const withNeutralTactic = (input: DecisionInput, team: TeamId): DecisionInput => {
  const tactic = neutralTactic(input.tactic);
  return { ...input, tactic, state: { ...input.state, tactics: { ...input.state.tactics, [team]: tactic } } };
};
const teamOf = (input: DecisionInput, playerId: number): TeamId => input.state.players.find((p) => p.id === playerId)?.team ?? 'A';

/** Politique du porteur qui remplace le choix final par `pick` (les candidats restent ceux de l'évaluation complète). */
function selectionPolicy(name: string, pick: (candidates: Candidate[], input: DecisionInput) => Candidate): PolicySet['onBall'] {
  return (input, playerId, previous) => {
    const full = decideOnBall(input, playerId, previous);
    if (full.candidates.length <= 1) return full;
    return withChosen(full, pick(full.candidates, input), name);
  };
}

export const BASELINES: Record<string, PolicySet> = {
  random: {
    ...FULL_POLICY,
    name: 'random',
    onBall: selectionPolicy('aléatoire', (cands, input) => pickRandom(cands, input.rng)),
  },
  greedy_progress: {
    ...FULL_POLICY,
    name: 'greedy_progress',
    onBall: selectionPolicy('glouton (progression)', (cands, input) => {
      const owner = input.state.ball.ownerId;
      const p = owner !== null ? input.state.players.find((q) => q.id === owner) : undefined;
      const dir = p ? attackDir(p.team) : 1;
      return pickGreedyProgress(cands, dir, input.state.ball.pos.x, input.state.ball.pos.y);
    }),
  },
  greedy_safe: {
    ...FULL_POLICY,
    name: 'greedy_safe',
    onBall: selectionPolicy('glouton (sécurité)', (cands) => pickGreedySafe(cands)),
  },
  no_lookahead: {
    ...FULL_POLICY,
    name: 'no_lookahead',
    onBall: (input, id, prev) => decideOnBall(withDecision(input, { gamma: 0, topK: 0 }), id, prev),
  },
  no_risk: {
    ...FULL_POLICY,
    name: 'no_risk',
    onBall: (input, id, prev) => decideOnBall(withDecision(input, { lambdaRisk: 0 }), id, prev),
  },
  no_tactic: {
    name: 'no_tactic',
    onBall: (input, id, prev) => FULL_POLICY.onBall(withNeutralTactic(input, teamOf(input, id)), id, prev),
    offBall: (input, id, prev) => FULL_POLICY.offBall(withNeutralTactic(input, teamOf(input, id)), id, prev),
    defence: (input, team, prev) => FULL_POLICY.defence(withNeutralTactic(input, team), team, prev),
  },
  nearest_man: {
    ...FULL_POLICY,
    name: 'nearest_man',
    defence: (input, team, prev) => decideDefence(input, team, prev, { greedy: true }),
  },
};
