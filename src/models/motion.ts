/**
 * Modèle cinématique : temps d'arrivée d'un joueur en un point, trajet du ballon au sol.
 * Réf. : Fernandez & Bornn (2018), Spearman (2017). Voir docs/CONCEPTION.md §3–4.
 *
 * Toutes les fonctions sont pures, en forme fermée, sans allocation (appelées ~40 000 fois par cycle).
 */
import type { Vec2 } from '../core/vec2';
import type { ModelParams, PhysicsParams } from '../core/types';

/**
 * Temps de course (s) d'un joueur parti de l'arrêt pour parcourir la distance `d` :
 * accélération constante `maxAccel` jusqu'à `maxSpeed`, puis vitesse constante.
 *   d_acc = v²/(2a) ;  t = √(2d/a) si d ≤ d_acc, sinon v/a + (d − d_acc)/v.
 * Continue en d_acc, croissante et concave en d.
 */
export function runTime(d: number, maxSpeed: number, maxAccel: number): number {
  if (d <= 0) return 0;
  const dAcc = (maxSpeed * maxSpeed) / (2 * maxAccel);
  return d <= dAcc ? Math.sqrt((2 * d) / maxAccel) : maxSpeed / maxAccel + (d - dAcc) / maxSpeed;
}

/**
 * Temps (s) pour qu'un joueur en `pos` avec vitesse `vel` atteigne `q` (§4.1) :
 * pendant le temps de réaction τ_r le joueur poursuit son mouvement (p' = p + τ_r·v),
 * puis court en ligne droite de p' vers q avec accélération constante jusqu'à v_max.
 *   T(q) = τ_r + runTime(‖q − p'‖).
 * Propriétés testées : T(p') = τ_r, croissante en la distance, continue en d_acc.
 */
export function timeToArrive(pos: Vec2, vel: Vec2, q: Vec2, maxSpeed: number, maxAccel: number, models: ModelParams): number {
  const tau = models.reactionTime;
  const dx = q.x - (pos.x + tau * vel.x);
  const dy = q.y - (pos.y + tau * vel.y);
  return tau + runTime(Math.sqrt(dx * dx + dy * dy), maxSpeed, maxAccel);
}

/**
 * Vitesse initiale nécessaire pour qu'un ballon roulant (décélération μ) parcoure `distance`
 * et arrive à `arrivalSpeed` : s₀ = min(s₀ᵐᵃˣ, √(2μd + s_arr²)) (§3.2).
 */
export function launchSpeed(distance: number, arrivalSpeed: number, physics: PhysicsParams): number {
  const d = Math.max(0, distance);
  const s0 = Math.sqrt(2 * physics.ballFriction * d + arrivalSpeed * arrivalSpeed);
  return Math.min(physics.passSpeedMax, s0);
}

/**
 * Temps de trajet d'un ballon roulant lancé à `initialSpeed` pour parcourir `distance` :
 *   T_b = (s₀ − √(s₀² − 2μd)) / μ, ou Infinity si le ballon s'arrête avant (s₀² < 2μd).
 */
export function ballTravelTime(distance: number, initialSpeed: number, physics: PhysicsParams): number {
  if (distance <= 0) return 0;
  if (initialSpeed <= 0) return Infinity;
  const mu = physics.ballFriction;
  if (mu <= 1e-9) return distance / initialSpeed;
  const disc = initialSpeed * initialSpeed - 2 * mu * distance;
  if (disc < 0) return Infinity;
  return (initialSpeed - Math.sqrt(disc)) / mu;
}

/** Distance parcourue par un ballon roulant lancé à `initialSpeed` après `t` secondes (bornée à la portée s₀²/2μ). */
export function ballDistanceAt(initialSpeed: number, t: number, physics: PhysicsParams): number {
  if (t <= 0 || initialSpeed <= 0) return 0;
  const mu = physics.ballFriction;
  const tt = mu > 1e-9 ? Math.min(t, initialSpeed / mu) : t;
  return initialSpeed * tt - 0.5 * mu * tt * tt;
}

/** Vitesse du ballon roulant après `t` secondes : max(0, s₀ − μt). */
export function ballSpeedAt(initialSpeed: number, t: number, physics: PhysicsParams): number {
  return Math.max(0, initialSpeed - physics.ballFriction * Math.max(0, t));
}

/** Portée d'un ballon roulant lancé à `initialSpeed` : s₀²/(2μ) (Infinity sans frottement). */
export function ballRange(initialSpeed: number, physics: PhysicsParams): number {
  return physics.ballFriction > 1e-9 ? (initialSpeed * initialSpeed) / (2 * physics.ballFriction) : Infinity;
}
