/**
 * Génération des explications en français à partir de la décomposition additive des scores.
 */
import type { Candidate, Decision, MatchState } from '../core/types';

/** Libellé court d'une action (« Passe → n°7 », « Dribble ↗ », « Tir », ...). */
export function actionLabel(candidate: Candidate, state: MatchState): string {
  throw new Error('non implémenté');
}

/** Explication multi-lignes de la décision (action, cible, score, raison, alternatives, pourquoi pas). */
export function explainDecision(decision: Decision, state: MatchState): string {
  throw new Error('non implémenté');
}
