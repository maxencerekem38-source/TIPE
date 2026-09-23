/**
 * Intégration physique : déplacement des joueurs vers leur cible, ballon roulant / aérien,
 * prise de balle, duels de contrôle. Pas de règles ici (voir rules.ts).
 */
import type { MatchState, SimParams } from '../core/types';
import type { Rng } from '../core/rng';

/** Avance l'état d'un pas dt (mutation en place). */
export function stepPhysics(state: MatchState, params: SimParams, rng: Rng, dt: number): void {
  throw new Error('non implémenté');
}
