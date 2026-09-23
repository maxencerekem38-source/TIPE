/**
 * Gardien de but : positionnement (bissectrice de l'angle de tir), sortie, relance.
 */
import type { Decision } from '../core/types';
import type { DecisionInput } from './policy';

export function decideKeeper(input: DecisionInput, playerId: number, previous: Decision | null): Decision {
  throw new Error('non implémenté');
}
