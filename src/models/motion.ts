/**
 * Modèle cinématique : temps d'arrivée d'un joueur en un point, trajet du ballon au sol.
 * Réf. : Fernandez & Bornn (2018), Spearman (2017). Voir docs/CONCEPTION.md §3–4.
 *
 * Toutes les fonctions sont pures, en forme fermée, sans allocation (appelées ~40 000 fois par cycle).
 */
import type { Vec2 } from '../core/vec2';
import type { ModelParams, PhysicsParams } from '../core/types';

/** Accélération de la pesanteur (m/s²) — définition partagée moteur / modèles pour les ballons aériens. */
export const GRAVITY = 9.81;

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
 * Temps de course (s) pour parcourir `d` en partant à la vitesse `v0` (composante le long du trajet, 0 ≤ v0 ≤ maxSpeed) :
 * accélération constante jusqu'à `maxSpeed`, puis vitesse constante. Généralise `runTime` (v0 = 0) ; utilisé pour le
 * porteur qui dribble (§5.3) afin que dribbleur et défenseur soient traités par la même cinématique.
 *   d_acc = (v_max² − v0²)/(2a) ;  t = (−v0 + √(v0² + 2ad))/a si d ≤ d_acc, sinon (v_max − v0)/a + (d − d_acc)/v_max.
 */
export function runTimeFrom(d: number, v0: number, maxSpeed: number, maxAccel: number): number {
  if (d <= 0) return 0;
  const v = Math.max(0, Math.min(maxSpeed, v0));
  const dAcc = (maxSpeed * maxSpeed - v * v) / (2 * maxAccel);
  if (d <= dAcc) return (-v + Math.sqrt(v * v + 2 * maxAccel * d)) / maxAccel;
  return (maxSpeed - v) / maxAccel + (d - dAcc) / maxSpeed;
}

/**
 * Temps (s) que met un porteur (`pos`, `vel`, `maxSpeed`, `maxAccel`) à conduire le ballon jusqu'à `q` (§5.3) :
 * vitesse plafonnée à v_drib = dribbleSpeedFactor·v_max, départ à la vitesse courante projetée sur la direction du
 * dribble (sans temps de réaction : c'est le porteur qui décide). Même cinématique que `timeToArrive` pour les
 * adversaires, ce qui rend la « course » du dribble (min_j T_j(q) − T_drib) comparable terme à terme.
 */
export function dribbleTime(pos: Vec2, vel: Vec2, q: Vec2, maxSpeed: number, maxAccel: number, physics: PhysicsParams): number {
  const dx = q.x - pos.x, dy = q.y - pos.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= 1e-9) return 0;
  const vDrib = Math.max(0.5, physics.dribbleSpeedFactor * maxSpeed);
  const v0 = (vel.x * dx + vel.y * dy) / d;
  return runTimeFrom(d, v0, vDrib, maxAccel);
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

/** Cinématique d'un ballon aérien (lob, dégagement) : voir `lobFlight`. */
export interface LobFlight {
  /** Vitesse initiale (norme du vecteur vitesse au départ, m/s). */
  initialSpeed: number;
  /** Composante horizontale de la vitesse (m/s) : constante pendant le vol. */
  horizontalSpeed: number;
  /** Vitesse verticale initiale (m/s). */
  vz: number;
  /** Durée du vol jusqu'au premier contact au sol (s). */
  travelTime: number;
  /** Hauteur maximale g·T²/8 (m). */
  apex: number;
}

/**
 * Ballon aérien couvrant `distance` (§3.2, lob / dégagement) — **modèle unique moteur / décision** :
 * tir balistique à 45° de vitesse v₀ = min(passSpeedMax, √(g d)), composante horizontale hs = v₀/√2,
 * durée T = d/hs, vitesse verticale vz = g·T/2 (portée exactement d), apogée g·T²/8 (= d/4 tant que v₀ n'est pas bornée).
 * Identique à `lobKinematics` de src/engine/helpers.ts : la décision et le moteur prévoient la même trajectoire.
 */
export function lobFlight(distance: number, physics: PhysicsParams): LobFlight {
  const d = Math.max(0.1, distance);
  const s0 = Math.min(physics.passSpeedMax, Math.sqrt(GRAVITY * d));
  const hs = s0 / Math.SQRT2;
  const T = d / hs;
  const vz = (GRAVITY * T) / 2;
  return { initialSpeed: Math.hypot(hs, vz), horizontalSpeed: hs, vz, travelTime: T, apex: (GRAVITY * T * T) / 8 };
}

/** Hauteur (m) du ballon aérien à la fraction f ∈ [0, 1] de son vol : parabole z(f) = 4·apex·f·(1 − f). */
export const lobHeightAt = (apex: number, f: number): number => 4 * apex * f * (1 - f);
