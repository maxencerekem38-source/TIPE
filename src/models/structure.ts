/**
 * Mesures structurelles : supériorité numérique locale, compacité, hors-jeu, disponibilité.
 */
import type { Vec2 } from '../core/vec2';
import type { MatchState, SimParams, TeamId } from '../core/types';

/** #attaquants − #défenseurs pouvant atteindre q en moins de tStar secondes. */
export function localSuperiority(state: MatchState, q: Vec2, team: TeamId, params: SimParams, tStar?: number): number {
  throw new Error('non implémenté');
}

/** Compacité d'une équipe : aire de l'enveloppe convexe des 10 joueurs de champ (m²) et étendue en x. */
export function compactness(state: MatchState, team: TeamId): { hullArea: number; spanX: number; spanY: number } {
  throw new Error('non implémenté');
}

/** Position x (repère terrain) de la ligne de hors-jeu que doit respecter `attackingTeam` (avant-dernier défenseur ou ballon). */
export function offsideLine(state: MatchState, attackingTeam: TeamId): number {
  throw new Error('non implémenté');
}

/** Le point q est-il en position de hors-jeu pour un attaquant de `attackingTeam` au moment de la passe ? */
export function isOffsidePosition(state: MatchState, q: Vec2, attackingTeam: TeamId): boolean {
  throw new Error('non implémenté');
}

/** Aire de la cellule de Voronoï du joueur (m²), bornée au terrain — « espace propre ». */
export function voronoiArea(state: MatchState, playerId: number): number {
  throw new Error('non implémenté');
}
