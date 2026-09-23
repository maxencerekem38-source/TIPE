/**
 * Décision du porteur de balle : génération des candidats (passes, passes en profondeur, dribbles,
 * tir, conservation, dégagement), évaluation par espérance de valeur avec risque, lookahead
 * (expectimax profondeur 2 avec réponse adverse), hystérésis, explication.
 */
import type { Candidate, Decision } from '../core/types';
import type { DecisionInput } from './policy';

/** Génère et évalue tous les candidats (triés par score décroissant), sans lookahead. */
export function evaluateCandidates(input: DecisionInput, playerId: number): Candidate[] {
  throw new Error('non implémenté');
}

/** Décision complète du porteur (avec lookahead et hystérésis). */
export function decideOnBall(input: DecisionInput, playerId: number, previous: Decision | null): Decision {
  throw new Error('non implémenté');
}
