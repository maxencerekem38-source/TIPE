/**
 * Mesures structurelles : supériorité numérique locale, compacité, hors-jeu, espace propre
 * (docs/CONCEPTION.md §4.5, §4.7, §3.4).
 */
import type { Vec2 } from '../core/vec2';
import { PITCH } from '../core/pitch';
import type { MatchState, Player, SimParams, TeamId } from '../core/types';
import { attackDir, otherTeam } from '../core/types';
import { timeToArrive } from './motion';

const DEFAULT_T_STAR = 2.5;
/** Tolérance (m) sur la ligne de hors-jeu : un attaquant à moins de 0,5 m au-delà de la ligne n'est pas sifflé. */
export const OFFSIDE_TOLERANCE = 0.5;

/**
 * Supériorité locale N⁺(q) = #{i ∈ att : T_i(q) < t★} − #{j ∈ def : T_j(q) < t★} (§4.7), t★ = 2,5 s par défaut
 * (`tStar` sinon params.models.superiorityHorizon). Tous les joueurs sont comptés (gardiens inclus).
 */
export function localSuperiority(state: MatchState, q: Vec2, team: TeamId, params: SimParams, tStar?: number): number {
  const horizon = tStar ?? params.models.superiorityHorizon ?? DEFAULT_T_STAR;
  let n = 0;
  for (const p of state.players) {
    const t = timeToArrive(p.pos, p.vel, q, p.maxSpeed, p.maxAccel, params.models);
    if (t < horizon) n += p.team === team ? 1 : -1;
  }
  return n;
}

/** Version lisse sup(q) = clamp(N⁺, −3, 3)/3 ∈ [−1, 1] (§4.7). */
export function smoothSuperiority(state: MatchState, q: Vec2, team: TeamId, params: SimParams, tStar?: number): number {
  const n = localSuperiority(state, q, team, params, tStar);
  return Math.max(-3, Math.min(3, n)) / 3;
}

/**
 * Enveloppe convexe (chaîne monotone d'Andrew, O(n log n)), sommets dans l'ordre trigonométrique,
 * sans le dernier point répété. Retourne les points tels quels si n < 3.
 */
export function convexHull(points: readonly Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o: Vec2, a: Vec2, b: Vec2): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Aire d'un polygone simple (formule du lacet), 0 si moins de 3 sommets. */
export function polygonArea(poly: readonly Vec2[]): number {
  if (poly.length < 3) return 0;
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  return Math.abs(s) / 2;
}

/** Joueurs de champ d'une équipe (sans le gardien). */
const outfield = (state: MatchState, team: TeamId): Player[] => state.players.filter((p) => p.team === team && p.role !== 'GK');

/**
 * Compacité d'une équipe (§4.7) : aire de l'enveloppe convexe des joueurs de champ (m²),
 * étendue en x (spanX = max x − min x) et largeur (spanY = max y − min y), repère terrain.
 */
export function compactness(state: MatchState, team: TeamId): { hullArea: number; spanX: number; spanY: number } {
  const players = outfield(state, team);
  if (players.length === 0) return { hullArea: 0, spanX: 0, spanY: 0 };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of players) {
    if (p.pos.x < minX) minX = p.pos.x;
    if (p.pos.x > maxX) maxX = p.pos.x;
    if (p.pos.y < minY) minY = p.pos.y;
    if (p.pos.y > maxY) maxY = p.pos.y;
  }
  const hull = convexHull(players.map((p) => p.pos));
  return { hullArea: polygonArea(hull), spanX: maxX - minX, spanY: maxY - minY };
}

/**
 * Ligne de hors-jeu (repère terrain) que doit respecter `attackingTeam` (§3.4) : abscisse de
 * l'avant-dernier défenseur (gardien inclus, au sens de la distance à sa ligne de but), ou celle du
 * ballon si elle est plus avancée. Direction d'attaque prise en compte : pour A c'est un max, pour B un min.
 */
export function offsideLine(state: MatchState, attackingTeam: TeamId): number {
  const dir = attackDir(attackingTeam);
  const def = otherTeam(attackingTeam);
  const xs: number[] = [];
  for (const p of state.players) if (p.team === def) xs.push(dir * p.pos.x);
  xs.sort((a, b) => b - a); // décroissant dans le repère de l'attaquant : xs[0] = dernier défenseur
  const secondLast = xs.length >= 2 ? xs[1] : xs.length === 1 ? xs[0] : -PITCH.halfLength;
  const ballX = dir * state.ball.pos.x;
  return dir * Math.max(secondLast, ballX);
}

/**
 * Le point q est-il en position de hors-jeu pour un attaquant de `attackingTeam` au moment de la passe ?
 * Oui si q est dans la moitié adverse ET au-delà de la ligne de hors-jeu de plus de OFFSIDE_TOLERANCE.
 */
export function isOffsidePosition(state: MatchState, q: Vec2, attackingTeam: TeamId): boolean {
  const dir = attackDir(attackingTeam);
  const xq = dir * q.x;
  if (xq <= 0) return false;
  const line = dir * offsideLine(state, attackingTeam);
  return xq > line + OFFSIDE_TOLERANCE;
}

/**
 * Aire de la cellule de Voronoï (euclidienne) du joueur (m²), bornée au terrain — « espace propre ».
 * Approximation par échantillonnage : centres de cellules de `cellSize` m, chaque cellule pondérée par
 * son aire réellement incluse dans le terrain (la somme sur les 22 joueurs vaut exactement L·W).
 * `radius` (optionnel) restreint le comptage aux cellules à moins de `radius` m du joueur (espace §4.5).
 */
export function voronoiArea(state: MatchState, playerId: number, cellSize = 2, radius?: number): number {
  const players = state.players;
  const me = players.find((p) => p.id === playerId);
  if (!me) return 0;
  const nx = Math.ceil(PITCH.length / cellSize), ny = Math.ceil(PITCH.width / cellSize);
  const r2 = radius !== undefined ? radius * radius : Infinity;
  let area = 0;
  for (let j = 0; j < ny; j++) {
    const y0 = -PITCH.halfWidth + j * cellSize;
    const h = Math.min(cellSize, PITCH.halfWidth - y0);
    const y = y0 + h / 2;
    for (let i = 0; i < nx; i++) {
      const x0 = -PITCH.halfLength + i * cellSize;
      const w = Math.min(cellSize, PITCH.halfLength - x0);
      const x = x0 + w / 2;
      const mdx = x - me.pos.x, mdy = y - me.pos.y;
      const myD2 = mdx * mdx + mdy * mdy;
      if (myD2 >= r2) continue;
      let nearest = true;
      for (let k = 0; k < players.length; k++) {
        const p = players[k];
        if (p.id === playerId) continue;
        const dx = x - p.pos.x, dy = y - p.pos.y;
        if (dx * dx + dy * dy < myD2) { nearest = false; break; }
      }
      if (nearest) area += w * h;
    }
  }
  return area;
}

/** Supériorité globale (§4.7) : Σ_{q ∈ tiers offensif} PC_att(q) Δ² (m²), lue sur le champ de contrôle. */
export function globalSuperiority(state: MatchState, team: TeamId): number {
  const f = state.fields?.controlA;
  if (!f) return 0;
  const dir = attackDir(team);
  const cs = f.cellSize;
  let s = 0;
  for (let j = 0; j < f.rows; j++)
    for (let i = 0; i < f.cols; i++) {
      const x = f.xOf(i);
      if (dir * x < PITCH.halfLength / 3 || dir * x > PITCH.halfLength) continue;
      const c = f.data[j * f.cols + i];
      s += (team === 'A' ? c : 1 - c) * cs * cs;
    }
  return s;
}
