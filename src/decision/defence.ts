/**
 * Décision défensive coordonnée : génération des tâches (presser, marquer, couvrir, zone, se replier),
 * matrice de coûts, affectation optimale (algorithme hongrois) avec hystérésis, gardien.
 */
import type { Decision, TeamId } from '../core/types';
import type { DecisionInput } from './policy';

export function decideDefence(input: DecisionInput, team: TeamId, previous: Map<number, Decision>): Map<number, Decision> {
  throw new Error('non implémenté');
}
