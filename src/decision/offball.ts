/**
 * Déplacement des attaquants sans ballon : optimisation d'une utilité (valeur recevable, espace,
 * exposition collective, structure, séparation, hors-jeu, appels) sur des positions candidates.
 */
import type { Decision } from '../core/types';
import type { DecisionInput } from './policy';

export function decideOffBall(input: DecisionInput, playerId: number, previous: Decision | null): Decision {
  throw new Error('non implémenté');
}
