/**
 * Jeu 2×2 à somme nulle (docs/CONCEPTION.md §6.4) : dilemme entre deux actions de classes différentes
 * ({tir, passe, dribble}) face à deux réponses défensives. Le joueur ligne (porteur) maximise, la défense minimise.
 *
 *   M[k][l] = Q(a_k | r_l)
 *   Point-selle : max_k min_l M[k][l] = min_l max_k M[k][l] ⇒ action pure minimax.
 *   Sinon (équilibre de Nash en stratégie mixte) :
 *     π₁ = (M₂₂ − M₂₁) / (M₁₁ − M₁₂ − M₂₁ + M₂₂), borné à [0, 1],
 *     v  = (M₁₁·M₂₂ − M₁₂·M₂₁) / (même dénominateur).
 *
 * Fonctions pures, sans dépendance au moteur : testables directement (matching pennies, point-selle, dominance).
 */
import type { Action } from '../core/types';

export type GameMatrix = [[number, number], [number, number]];

export interface GameSolution {
  /** Point-selle : l'action pure `pi1 ∈ {0, 1}` est jouée. */
  pure: boolean;
  /** Probabilité de jouer la première action (1 ou 0 en stratégie pure). */
  pi1: number;
  /** Valeur du jeu (pour le joueur ligne). */
  value: number;
}

/** Tolérance de l'égalité maximin = minimax (point-selle). */
const SADDLE_EPS = 1e-12;

/** Résout le jeu 2×2 à somme nulle de matrice `m` (joueur ligne maximisant). */
export function solve2x2(m: GameMatrix): GameSolution {
  const [[a, b], [c, d]] = m;
  const rowMin = [Math.min(a, b), Math.min(c, d)];
  const colMax = [Math.max(a, c), Math.max(b, d)];
  const maximin = Math.max(rowMin[0], rowMin[1]);
  const minimax = Math.min(colMax[0], colMax[1]);
  if (Math.abs(maximin - minimax) <= SADDLE_EPS) {
    // Point-selle : la ligne qui réalise le maximin (la première en cas d'égalité).
    return { pure: true, pi1: rowMin[0] >= rowMin[1] ? 1 : 0, value: maximin };
  }
  const den = a - b - c + d;
  if (Math.abs(den) <= SADDLE_EPS) return { pure: true, pi1: rowMin[0] >= rowMin[1] ? 1 : 0, value: maximin };
  const pi1 = Math.max(0, Math.min(1, (d - c) / den));
  const value = (a * d - b * c) / den;
  return { pure: false, pi1, value };
}

/** Classe d'action du dilemme (§6.4) : tir, passe (au pied, lobée ou en profondeur), dribble ; null sinon. */
export type GameClass = 'shoot' | 'pass' | 'dribble';
export function gameClass(a: Action): GameClass | null {
  switch (a.type) {
    case 'shoot': return 'shoot';
    case 'pass': return 'pass';
    case 'dribble': return 'dribble';
    default: return null;
  }
}

/** Tire l'action jouée (0 = première, 1 = seconde) : pure ⇒ déterministe ; mixte ⇒ tirage u < π₁ avec le RNG à graine. */
export function drawAction(sol: GameSolution, rng: { next(): number }): 0 | 1 {
  if (sol.pure) return sol.pi1 >= 0.5 ? 0 : 1;
  return rng.next() < sol.pi1 ? 0 : 1;
}
