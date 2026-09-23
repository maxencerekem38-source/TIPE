/**
 * Règles : buts, sorties de balle, remises en jeu simplifiées, changement de possession,
 * phases de jeu (attaque / défense / transitions), statistiques d'événements.
 */
import type { MatchConfig, MatchState, MatchEvent } from '../core/types';
import type { Rng } from '../core/rng';

/** Applique les règles après un pas de physique (mutation en place). */
export function applyRules(state: MatchState, config: MatchConfig, rng: Rng): void {
  throw new Error('non implémenté');
}

/** Ajoute un événement au journal (borné) et met à jour les statistiques. */
export function pushEvent(state: MatchState, event: MatchEvent): void {
  throw new Error('non implémenté');
}

/** Met à jour les phases de jeu des deux équipes en fonction de la possession et du temps. */
export function updatePhases(state: MatchState, config: MatchConfig): void {
  throw new Error('non implémenté');
}
