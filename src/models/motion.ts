/**
 * Modèle cinématique : temps d'arrivée d'un joueur en un point, trajet du ballon au sol.
 * Réf. : Fernandez & Bornn (2018), Spearman (2017). Voir docs/CONCEPTION.md §3–4.
 */
import type { Vec2 } from '../core/vec2';
import type { ModelParams, PhysicsParams } from '../core/types';

/**
 * Temps (s) pour qu'un joueur en `pos` avec vitesse `vel` atteigne `q` :
 * réaction τ_r, puis accélération constante jusqu'à v_max (forme fermée).
 */
export function timeToArrive(pos: Vec2, vel: Vec2, q: Vec2, maxSpeed: number, maxAccel: number, models: ModelParams): number {
  throw new Error('non implémenté');
}

/** Vitesse initiale nécessaire pour qu'un ballon roulant parcoure `distance` et arrive à `arrivalSpeed`. */
export function launchSpeed(distance: number, arrivalSpeed: number, physics: PhysicsParams): number {
  throw new Error('non implémenté');
}

/** Temps de trajet d'un ballon roulant lancé à `initialSpeed` pour parcourir `distance` (Infinity si inatteignable). */
export function ballTravelTime(distance: number, initialSpeed: number, physics: PhysicsParams): number {
  throw new Error('non implémenté');
}

/** Distance parcourue par un ballon roulant lancé à `initialSpeed` après `t` secondes (bornée à la distance d'arrêt). */
export function ballDistanceAt(initialSpeed: number, t: number, physics: PhysicsParams): number {
  throw new Error('non implémenté');
}
