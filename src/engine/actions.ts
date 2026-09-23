/**
 * Exécution des actions décidées : frappe du ballon (avec bruit d'exécution), dribble, conservation,
 * mise à jour des cibles de déplacement. Émet les événements correspondants.
 */
import type { Action, MatchState, SimParams } from '../core/types';
import type { Rng } from '../core/rng';

/** Applique l'action du joueur à l'état (mutation en place). Retourne true si l'action a été déclenchée. */
export function executeAction(state: MatchState, playerId: number, action: Action, params: SimParams, rng: Rng): boolean {
  throw new Error('non implémenté');
}
