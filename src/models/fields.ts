/**
 * Champs spatiaux : contrôle du terrain (softmin des temps d'arrivée), menace, pression.
 * Calculés une fois par cycle de décision et partagés par les 22 décisions.
 */
import type { Vec2 } from '../core/vec2';
import type { FieldSet, MatchState, SimParams, TeamId } from '../core/types';

/** Calcule l'ensemble des champs sur la grille (cellules de `params.fieldCellSize` m). */
export function computeFields(state: MatchState, params: SimParams): FieldSet {
  throw new Error('non implémenté');
}

/** Probabilité que `team` contrôle le point q (calcul exact, hors grille). */
export function pitchControlAt(state: MatchState, q: Vec2, team: TeamId, params: SimParams): number {
  throw new Error('non implémenté');
}

/** Pression exercée par les adversaires de `team` au point q (0..~3). */
export function pressureAt(state: MatchState, q: Vec2, team: TeamId, params: SimParams): number {
  throw new Error('non implémenté');
}

/** Menace (valeur d'une position, ~ probabilité de marquer à terme) pour `team` au point q (analytique). */
export function threatAt(q: Vec2, team: TeamId, params: SimParams): number {
  throw new Error('non implémenté');
}

/** xG géométrique (angle + distance uniquement, sans gardien) — brique de la menace. */
export function geometricXG(q: Vec2, team: TeamId, params: SimParams): number {
  throw new Error('non implémenté');
}
