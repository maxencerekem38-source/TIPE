/**
 * Coordonnateur : un cycle de décision complet pour les 22 joueurs.
 * Calcule les champs, détermine les phases, appelle les politiques (porteur, sans ballon, défense).
 */
import type { Decision, MatchState, SimParams, TeamId } from '../core/types';
import type { PolicySet } from './policy';
import type { Rng } from '../core/rng';

/** La politique complète (algorithme principal). */
export declare const FULL_POLICY: PolicySet;

export function decideAll(state: MatchState, params: SimParams, policies: Record<TeamId, PolicySet>, previous: Map<number, Decision>, rng: Rng): Map<number, Decision> {
  throw new Error('non implémenté');
}
