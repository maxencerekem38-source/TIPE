/**
 * Champs spatiaux : contrôle du terrain (softmin des temps d'arrivée), menace, pression.
 * Calculés une fois par cycle de décision et partagés par les 22 décisions (docs/CONCEPTION.md §4).
 *
 * Implémentation : boucles plates sur des Float32Array, aucune allocation dans les boucles internes ;
 * les surfaces de menace (purement géométriques) sont mises en cache par jeu de paramètres.
 */
import type { Vec2 } from '../core/vec2';
import { sigmoid } from '../core/vec2';
import { PITCH, goalAngle, distToGoal } from '../core/pitch';
import { ScalarField } from '../core/grid';
import type { FieldSet, MatchState, Player, SimParams, TeamId } from '../core/types';
import { attackDir, otherTeam } from '../core/types';
import { runTime, timeToArrive } from './motion';

// ---------------------------------------------------------------------------
// Constantes de repli (les valeurs par défaut sont dans params.ts ; ces repli servent si un
// jeu de paramètres antérieur ne contient pas les champs optionnels)
// ---------------------------------------------------------------------------
const DEFAULT_PRESSURE_CLOSING = 0.5;
const DEFAULT_THREAT_KEEPER_COVERAGE = 0.57;
/** Au-delà de 4 r_p, exp(−r²/2r_p²) < 4·10⁻⁴ : contribution négligée (accélère le calcul de la pression). */
const PRESSURE_CUTOFF_RADII = 4;
/** Poids du softmin ignorés au-delà de e^{−12} (accélère le contrôle, erreur relative < 10⁻⁴). */
const EXP_CUTOFF = 12;
const BOX_X = PITCH.halfLength - PITCH.penaltyAreaLength; // 36 m
const BOX_Y = PITCH.penaltyAreaHalfWidth; // 20,16 m

/** Le gardien ne participe au contrôle du terrain que dans sa propre surface (§4.2) : −1/+1 = côté de sa surface, 0 = partout. */
const controlBoxSide = (p: Player): number => (p.role === 'GK' ? -attackDir(p.team) : 0);
const inOwnBox = (side: number, x: number, y: number): boolean => side === 0 || (side * x >= BOX_X && Math.abs(y) <= BOX_Y);

// ---------------------------------------------------------------------------
// xG géométrique et menace analytique (§4.3)
// ---------------------------------------------------------------------------
/**
 * xG géométrique (angle + distance uniquement, sans gardien explicite) — brique de la menace.
 *   xG_loc(q) = σ(base_shot + coef_gk·c_nominal + 3,0·ω(q) − 0,08·d_G(q))   (= σ(−1,96 + 3ω − 0,08 d_G) par défaut)
 * ω = angle sous lequel on voit les poteaux (rad), d_G = distance au centre du but attaqué.
 * Valeurs de contrôle : point de penalty ≈ 0,29 ; 18 m axial ≈ 0,10 ; 30 m ≈ 0,03 ; propre camp ≈ 0.
 */
export function geometricXG(q: Vec2, team: TeamId, params: SimParams): number {
  const dir = attackDir(team);
  const m = params.models;
  const cgk = m.threatKeeperCoverage ?? DEFAULT_THREAT_KEEPER_COVERAGE;
  const z = m.shot.base + m.shot.keeperCoverage * cgk + m.shot.angle * goalAngle(q, dir) + m.shot.distance * distToGoal(q, dir);
  return sigmoid(z);
}

/**
 * Menace analytique xT (substitut de l'expected threat, §4.3) :
 *   xT(q) = xG_loc(q) + (1 − xG_loc(q))·κ·exp(−d_G/ρ_x)·exp(−y²/2ρ_y²).
 * Valeurs de contrôle : propre surface ≈ 0,005 ; rond central ≈ 0,03 ; entrée de surface axiale ≈ 0,22.
 */
export function threatAt(q: Vec2, team: TeamId, params: SimParams): number {
  const m = params.models;
  const dir = attackDir(team);
  const xg = geometricXG(q, team, params);
  const dG = distToGoal(q, dir);
  const carry = m.threatKappa * Math.exp(-dG / m.threatRhoX) * Math.exp(-(q.y * q.y) / (2 * m.threatRhoY * m.threatRhoY));
  return xg + (1 - xg) * carry;
}

/** Menace vue par l'adversaire de `team` au point q : xT^def(q) = xT_autre(q). */
export const threatAgainstAt = (q: Vec2, team: TeamId, params: SimParams): number => threatAt(q, otherTeam(team), params);

// Cache des surfaces de menace (elles ne dépendent que de la géométrie et des paramètres).
let threatCacheKey = '';
let threatCacheA: ScalarField | null = null;
let threatCacheB: ScalarField | null = null;

function threatKey(params: SimParams): string {
  const m = params.models;
  return `${params.fieldCellSize}|${m.threatKappa}|${m.threatRhoX}|${m.threatRhoY}|${m.shot.base}|${m.shot.angle}|${m.shot.distance}|${m.shot.keeperCoverage}|${m.threatKeeperCoverage ?? DEFAULT_THREAT_KEEPER_COVERAGE}`;
}

/** Surfaces de menace (copies fraîches : le cache interne n'est jamais exposé). */
export function threatFields(params: SimParams): { threatA: ScalarField; threatB: ScalarField } {
  const key = threatKey(params);
  if (key !== threatCacheKey || !threatCacheA || !threatCacheB) {
    threatCacheA = new ScalarField(params.fieldCellSize).fill((x, y) => threatAt({ x, y }, 'A', params));
    threatCacheB = new ScalarField(params.fieldCellSize).fill((x, y) => threatAt({ x, y }, 'B', params));
    threatCacheKey = key;
  }
  return { threatA: threatCacheA.clone(), threatB: threatCacheB.clone() };
}

// ---------------------------------------------------------------------------
// Pression (§4.4)
// ---------------------------------------------------------------------------
/**
 * Contribution d'un joueur `p` (qui exerce la pression) au point q, `dirPressed` = direction d'attaque
 * de l'équipe qui subit la pression :
 *   exp(−r²/2r_p²) · (1 + α_p·cosθ) · (1 + α_v·max(0, c)),
 * cosθ = composante de (p − q)/r selon la direction d'attaque de l'équipe pressée (un défenseur
 * placé côté but pèse 1 + α_p, un défenseur dans le dos 1 − α_p), c = v·(q − p)^ / v_max (fermeture).
 * (Le signe de θ est choisi pour que « côté but pèse plus », conformément à l'intention du §4.4.)
 */
function pressureContribution(p: Player, qx: number, qy: number, dirPressed: number, invTwoR2: number, alphaP: number, alphaV: number, invVmax: number): number {
  const dx = p.pos.x - qx, dy = p.pos.y - qy;
  const r2 = dx * dx + dy * dy;
  const g = Math.exp(-r2 * invTwoR2);
  if (r2 < 1e-6) return g;
  const r = Math.sqrt(r2);
  const cosTheta = (dirPressed * dx) / r;
  const closing = -(p.vel.x * dx + p.vel.y * dy) / r * invVmax;
  return g * (1 + alphaP * cosTheta) * (1 + alphaV * (closing > 0 ? closing : 0));
}

/** Pression exercée par les adversaires de `team` au point q (Π ∈ [0, ~4], version ponctuelle exacte). */
export function pressureAt(state: MatchState, q: Vec2, team: TeamId, params: SimParams): number {
  const m = params.models;
  const invTwoR2 = 1 / (2 * m.pressureRadius * m.pressureRadius);
  const alphaP = m.pressureDirectional;
  const alphaV = m.pressureClosing ?? DEFAULT_PRESSURE_CLOSING;
  const invVmax = 1 / params.physics.playerMaxSpeed;
  const dirPressed = attackDir(team);
  const cutoff2 = (PRESSURE_CUTOFF_RADII * m.pressureRadius) ** 2;
  let sum = 0;
  const players = state.players;
  for (let k = 0; k < players.length; k++) {
    const p = players[k];
    if (p.team === team) continue;
    const dx = p.pos.x - q.x, dy = p.pos.y - q.y;
    if (dx * dx + dy * dy > cutoff2) continue;
    sum += pressureContribution(p, q.x, q.y, dirPressed, invTwoR2, alphaP, alphaV, invVmax);
  }
  return sum;
}

/** Pression exercée par l'équipe `by` (sur ses adversaires) au point q. */
export const pressureByAt = (state: MatchState, q: Vec2, by: TeamId, params: SimParams): number => pressureAt(state, q, otherTeam(by), params);

// ---------------------------------------------------------------------------
// Contrôle du terrain (§4.2)
// ---------------------------------------------------------------------------
/**
 * Probabilité que `team` contrôle le point q (calcul exact, hors grille) :
 *   PC_A(q) = Σ_{i∈A} e^{−T_i/β} / Σ_{i∈A∪B} e^{−T_i/β}.
 * Les exponentielles sont centrées sur min T (stabilité numérique quand β → 0 : limite Voronoï).
 * Le gardien ne participe que dans sa propre surface.
 */
export function pitchControlAt(state: MatchState, q: Vec2, team: TeamId, params: SimParams): number {
  const m = params.models;
  const players = state.players;
  const n = players.length;
  let minT = Infinity;
  for (let k = 0; k < n; k++) {
    const p = players[k];
    if (!inOwnBox(controlBoxSide(p), q.x, q.y)) continue;
    const t = timeToArrive(p.pos, p.vel, q, p.maxSpeed, p.maxAccel, m);
    if (t < minT) minT = t;
  }
  if (minT === Infinity) return 0.5;
  const invBeta = 1 / Math.max(1e-6, m.controlBeta);
  let sumTeam = 0, sumAll = 0;
  for (let k = 0; k < n; k++) {
    const p = players[k];
    if (!inOwnBox(controlBoxSide(p), q.x, q.y)) continue;
    const t = timeToArrive(p.pos, p.vel, q, p.maxSpeed, p.maxAccel, m);
    const w = Math.exp(-(t - minT) * invBeta);
    sumAll += w;
    if (p.team === team) sumTeam += w;
  }
  return sumTeam / sumAll;
}

/** Temps d'arrivée minimal des joueurs de `team` (ou de tous si `team` est omis) au point q. */
export function minArrivalTime(state: MatchState, q: Vec2, params: SimParams, team?: TeamId): number {
  let best = Infinity;
  const players = state.players;
  for (let k = 0; k < players.length; k++) {
    const p = players[k];
    if (team !== undefined && p.team !== team) continue;
    const t = timeToArrive(p.pos, p.vel, q, p.maxSpeed, p.maxAccel, params.models);
    if (t < best) best = t;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Calcul complet sur la grille
// ---------------------------------------------------------------------------
/**
 * Calcule l'ensemble des champs sur la grille (cellules de `params.fieldCellSize` m) :
 * controlA, threatA/B (cache), pressureByA/B, et les extras : arrivalTime[i], argminPlayer,
 * dangerA/B = xT·PC_att, exposureA/B = Σ D Δ²/(L·W).
 * Coût : 22 × |Γ| formes fermées + exponentielles (≈ 1 ms en Node sur la grille 2 m).
 */
export function computeFields(state: MatchState, params: SimParams): FieldSet {
  const cs = params.fieldCellSize;
  const m = params.models;
  const players = state.players;
  const P = players.length;

  const controlA = new ScalarField(cs);
  const cols = controlA.cols, rows = controlA.rows, n = cols * rows;
  const { threatA, threatB } = threatFields(params);
  const pressureByA = new ScalarField(cs);
  const pressureByB = new ScalarField(cs);
  const dangerA = new ScalarField(cs);
  const dangerB = new ScalarField(cs);
  const argminPlayer = new Int16Array(n).fill(-1);

  // Coordonnées des nœuds (précalculées une fois).
  const xs = new Float64Array(cols);
  const ys = new Float64Array(rows);
  for (let i = 0; i < cols; i++) xs[i] = controlA.xOf(i);
  for (let j = 0; j < rows; j++) ys[j] = controlA.yOf(j);

  // --- 1. Temps d'arrivée par joueur (§4.1), avec argmin (tous joueurs) et min éligible (contrôle) ---
  // Le gardien ne participe au contrôle que dans sa propre surface (§4.2) : minT ne compte que les
  // joueurs éligibles, argminPlayer compte tout le monde (espace disponible, §4.5).
  const arrivalTime: ScalarField[] = new Array(P);
  const minAll = new Float64Array(n).fill(Infinity);
  const minT = new Float64Array(n).fill(Infinity);
  const boxSide = new Int8Array(P);
  const tau = m.reactionTime;
  for (let k = 0; k < P; k++) {
    const p = players[k];
    const side = controlBoxSide(p);
    boxSide[k] = side;
    const id = p.id;
    const field = new ScalarField(cs);
    const data = field.data;
    const sx = p.pos.x + tau * p.vel.x, sy = p.pos.y + tau * p.vel.y;
    const vmax = p.maxSpeed, amax = p.maxAccel;
    const dAcc = (vmax * vmax) / (2 * amax);
    const tAcc = vmax / amax;
    const twoInvA = 2 / amax;
    const invV = 1 / vmax;
    for (let j = 0; j < rows; j++) {
      const dy = ys[j] - sy;
      const dy2 = dy * dy;
      const rowEligible = side === 0 || Math.abs(ys[j]) <= BOX_Y;
      let idx = j * cols;
      for (let i = 0; i < cols; i++, idx++) {
        const dx = xs[i] - sx;
        const d = Math.sqrt(dx * dx + dy2);
        const t = tau + (d <= dAcc ? Math.sqrt(d * twoInvA) : tAcc + (d - dAcc) * invV);
        data[idx] = t;
        if (t < minAll[idx]) { minAll[idx] = t; argminPlayer[idx] = id; }
        if (t < minT[idx] && rowEligible && (side === 0 || side * xs[i] >= BOX_X)) minT[idx] = t;
      }
    }
    arrivalTime[k] = field;
  }

  // --- 2. Contrôle : softmin centré sur le min (stable pour β → 0) ---
  // Les poids e^{−(T−T_min)/β} < e^{−12} sont ignorés (erreur relative < 22·e^{−12} ≈ 10⁻⁴).
  const sumA = new Float64Array(n);
  const sumB = new Float64Array(n);
  const invBeta = 1 / Math.max(1e-6, m.controlBeta);
  for (let k = 0; k < P; k++) {
    const data = arrivalTime[k].data;
    const side = boxSide[k];
    const acc = players[k].team === 'A' ? sumA : sumB;
    for (let j = 0; j < rows; j++) {
      if (side !== 0 && Math.abs(ys[j]) > BOX_Y) continue;
      let idx = j * cols;
      for (let i = 0; i < cols; i++, idx++) {
        if (side !== 0 && side * xs[i] < BOX_X) continue;
        const z = (data[idx] - minT[idx]) * invBeta;
        if (z < EXP_CUTOFF) acc[idx] += Math.exp(-z);
      }
    }
  }
  const ctl = controlA.data;
  for (let idx = 0; idx < n; idx++) {
    const tot = sumA[idx] + sumB[idx];
    ctl[idx] = tot > 0 ? sumA[idx] / tot : 0.5;
  }

  // --- 3. Pression (§4.4) : par joueur, sur la fenêtre de cellules à moins de 4 r_p ---
  const invTwoR2 = 1 / (2 * m.pressureRadius * m.pressureRadius);
  const alphaP = m.pressureDirectional;
  const alphaV = m.pressureClosing ?? DEFAULT_PRESSURE_CLOSING;
  const invVmax = 1 / params.physics.playerMaxSpeed;
  const cutoff = PRESSURE_CUTOFF_RADII * m.pressureRadius;
  for (let k = 0; k < P; k++) {
    const p = players[k];
    const out = p.team === 'A' ? pressureByA.data : pressureByB.data;
    const dirPressed = attackDir(otherTeam(p.team));
    const i0 = Math.max(0, Math.floor((p.pos.x - cutoff + PITCH.halfLength) / cs));
    const i1 = Math.min(cols - 1, Math.ceil((p.pos.x + cutoff + PITCH.halfLength) / cs));
    const j0 = Math.max(0, Math.floor((p.pos.y - cutoff + PITCH.halfWidth) / cs));
    const j1 = Math.min(rows - 1, Math.ceil((p.pos.y + cutoff + PITCH.halfWidth) / cs));
    for (let j = j0; j <= j1; j++) {
      const qy = ys[j];
      for (let i = i0; i <= i1; i++) {
        out[j * cols + i] += pressureContribution(p, xs[i], qy, dirPressed, invTwoR2, alphaP, alphaV, invVmax);
      }
    }
  }

  // --- 4. Danger et exposition (§4.3) ---
  const tA = threatA.data, tB = threatB.data, dA = dangerA.data, dB = dangerB.data;
  let expA = 0, expB = 0;
  for (let idx = 0; idx < n; idx++) {
    const c = ctl[idx];
    dA[idx] = tA[idx] * c;
    dB[idx] = tB[idx] * (1 - c);
    expA += dA[idx];
    expB += dB[idx];
  }
  const cellArea = (cs * cs) / (PITCH.length * PITCH.width);

  return {
    time: state.time,
    controlA,
    threatA,
    threatB,
    pressureByA,
    pressureByB,
    arrivalTime,
    argminPlayer,
    dangerA,
    dangerB,
    exposureA: expA * cellArea,
    exposureB: expB * cellArea,
  };
}

// ---------------------------------------------------------------------------
// Lectures utilitaires sur les champs
// ---------------------------------------------------------------------------
/** Contrôle du terrain par `team` au point q, lu sur la grille (bilinéaire). */
export const controlFor = (fields: FieldSet, q: Vec2, team: TeamId): number => {
  const c = fields.controlA.sample(q);
  return team === 'A' ? c : 1 - c;
};

/** Menace pour `team` au point q, lue sur la grille. */
export const threatFor = (fields: FieldSet, q: Vec2, team: TeamId): number => (team === 'A' ? fields.threatA : fields.threatB).sample(q);

/** Pression subie par `team` (exercée par ses adversaires) au point q, lue sur la grille. */
export const pressureOn = (fields: FieldSet, q: Vec2, team: TeamId): number => (team === 'A' ? fields.pressureByB : fields.pressureByA).sample(q);

/** Danger Θ(q) = xT(q)·PC_att(q) pour `team`, lu sur la grille. */
export const dangerFor = (fields: FieldSet, q: Vec2, team: TeamId): number => {
  const d = team === 'A' ? fields.dangerA : fields.dangerB;
  return d ? d.sample(q) : threatFor(fields, q, team) * controlFor(fields, q, team);
};

/**
 * Espace disponible du joueur (§4.5) : aire (m²) des cellules à moins de `radius` de `pos`
 * dont il est le joueur le plus rapide (grille des argmin). Retourne 0 si les champs ne l'ont pas.
 */
export function availableSpace(fields: FieldSet, playerId: number, pos: Vec2, radius = 8): number {
  const arg = fields.argminPlayer;
  if (!arg) return 0;
  const f = fields.controlA;
  const cs = f.cellSize;
  const r2 = radius * radius;
  const i0 = Math.max(0, Math.floor((pos.x - radius + PITCH.halfLength) / cs));
  const i1 = Math.min(f.cols - 1, Math.ceil((pos.x + radius + PITCH.halfLength) / cs));
  const j0 = Math.max(0, Math.floor((pos.y - radius + PITCH.halfWidth) / cs));
  const j1 = Math.min(f.rows - 1, Math.ceil((pos.y + radius + PITCH.halfWidth) / cs));
  let count = 0;
  for (let j = j0; j <= j1; j++) {
    const dy = f.yOf(j) - pos.y;
    for (let i = i0; i <= i1; i++) {
      const dx = f.xOf(i) - pos.x;
      if (dx * dx + dy * dy < r2 && arg[j * f.cols + i] === playerId) count++;
    }
  }
  return count * cs * cs;
}

/** Temps de course pur (sans réaction) — réexporté pour les couches qui n'ont besoin que de la forme fermée. */
export { runTime };
