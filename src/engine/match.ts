/**
 * Création et réinitialisation d'un match : joueurs, formations, coup d'envoi.
 */
import type { MatchConfig, MatchState, TeamId, Player } from '../core/types';
import type { Vec2 } from '../core/vec2';
import type { Rng } from '../core/rng';

/** Construit l'état initial (coup d'envoi pour l'équipe A) à partir de la configuration. */
export function createMatch(config: MatchConfig, rng: Rng): MatchState {
  throw new Error('non implémenté');
}

/** Replace les 22 joueurs et le ballon pour un coup d'envoi de `team` (score et temps conservés). */
export function setupKickoff(state: MatchState, team: TeamId, config: MatchConfig): void {
  throw new Error('non implémenté');
}

/** Position de référence (repère terrain) du poste d'un joueur, ajustée au ballon et à la tactique. */
export function slotPosition(state: MatchState, player: Player, ballPos?: Vec2): Vec2 {
  throw new Error('non implémenté');
}

/** Copie profonde de l'état (utilisée par la recherche en avant et les scénarios). */
export function cloneState(state: MatchState): MatchState {
  throw new Error('non implémenté');
}

/** Donne le ballon à un joueur et place les autres selon leurs postes (utilisé par les scénarios). */
export function giveBall(state: MatchState, playerId: number): void {
  throw new Error('non implémenté');
}
