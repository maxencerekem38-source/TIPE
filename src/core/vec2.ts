/**
 * Géométrie 2D élémentaire.
 * Toutes les fonctions sont pures et ne mutent jamais leurs arguments.
 * Unités : mètres, secondes, radians.
 */
export interface Vec2 {
  x: number;
  y: number;
}

export const v = (x: number, y: number): Vec2 => ({ x, y });
export const ZERO: Readonly<Vec2> = Object.freeze({ x: 0, y: 0 });

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const len2 = (a: Vec2): number => a.x * a.x + a.y * a.y;
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const dist2 = (a: Vec2, b: Vec2): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
export const neg = (a: Vec2): Vec2 => ({ x: -a.x, y: -a.y });
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const equals = (a: Vec2, b: Vec2, eps = 1e-9): boolean => Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;

/** Vecteur unitaire (retourne (0,0) si la norme est nulle). */
export const normalize = (a: Vec2): Vec2 => {
  const l = len(a);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
};

/** Tronque la norme du vecteur à `max`. */
export const clampLen = (a: Vec2, max: number): Vec2 => {
  const l = len(a);
  return l > max && l > 1e-12 ? { x: (a.x / l) * max, y: (a.y / l) * max } : a;
};

/** Vecteur unitaire d'angle theta (radians). */
export const fromAngle = (theta: number, r = 1): Vec2 => ({ x: Math.cos(theta) * r, y: Math.sin(theta) * r });
export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x);

/** Angle non orienté entre deux vecteurs, dans [0, pi]. */
export const angleBetween = (a: Vec2, b: Vec2): number => {
  const la = len(a), lb = len(b);
  if (la < 1e-12 || lb < 1e-12) return 0;
  const c = Math.min(1, Math.max(-1, dot(a, b) / (la * lb)));
  return Math.acos(c);
};

export const rotate = (a: Vec2, theta: number): Vec2 => {
  const c = Math.cos(theta), s = Math.sin(theta);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
};

/**
 * Projection du point p sur le segment [a,b].
 * Retourne le paramètre t ∈ [0,1], le point projeté et la distance p-projeté.
 */
export const projectOnSegment = (p: Vec2, a: Vec2, b: Vec2): { t: number; point: Vec2; distance: number } => {
  const ab = sub(b, a);
  const l2 = len2(ab);
  let t = l2 < 1e-12 ? 0 : dot(sub(p, a), ab) / l2;
  t = Math.max(0, Math.min(1, t));
  const point = add(a, scale(ab, t));
  return { t, point, distance: dist(p, point) };
};

/** Distance d'un point à un segment. */
export const distToSegment = (p: Vec2, a: Vec2, b: Vec2): number => projectOnSegment(p, a, b).distance;

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
/** Sigmoïde paramétrée : centre c, pente k. */
export const logistic = (x: number, c: number, k: number): number => 1 / (1 + Math.exp(-k * (x - c)));
export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
