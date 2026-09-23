/**
 * Constantes géométriques du terrain (dimensions FIFA standard).
 * Repère : origine au centre du terrain, axe x le long de la longueur,
 * axe y le long de la largeur. L'équipe A attaque vers +x, l'équipe B vers -x.
 */
import type { Vec2 } from './vec2';

export const PITCH = {
  length: 105, // m (axe x)
  width: 68, // m (axe y)
  halfLength: 52.5,
  halfWidth: 34,
  goalWidth: 7.32,
  goalHalfWidth: 3.66,
  goalDepth: 2.44,
  goalHeight: 2.44,
  penaltyAreaLength: 16.5,
  penaltyAreaHalfWidth: 20.16,
  goalAreaLength: 5.5,
  goalAreaHalfWidth: 9.16,
  penaltySpotDistance: 11,
  centreCircleRadius: 9.15,
  cornerArcRadius: 1,
} as const;

/** Direction d'attaque (+1 vers +x, -1 vers -x). */
export type AttackDir = 1 | -1;

/** Centre du but attaqué par une équipe qui attaque dans la direction `dir`. */
export const goalCentre = (dir: AttackDir): Vec2 => ({ x: dir * PITCH.halfLength, y: 0 });
/** Centre du but défendu par une équipe qui attaque dans la direction `dir`. */
export const ownGoalCentre = (dir: AttackDir): Vec2 => ({ x: -dir * PITCH.halfLength, y: 0 });
export const goalPosts = (dir: AttackDir): [Vec2, Vec2] => [
  { x: dir * PITCH.halfLength, y: -PITCH.goalHalfWidth },
  { x: dir * PITCH.halfLength, y: PITCH.goalHalfWidth },
];

export const isInsidePitch = (p: Vec2, margin = 0): boolean =>
  Math.abs(p.x) <= PITCH.halfLength + margin && Math.abs(p.y) <= PITCH.halfWidth + margin;

export const clampToPitch = (p: Vec2, margin = 0): Vec2 => ({
  x: Math.max(-PITCH.halfLength + margin, Math.min(PITCH.halfLength - margin, p.x)),
  y: Math.max(-PITCH.halfWidth + margin, Math.min(PITCH.halfWidth - margin, p.y)),
});

/** Le point est-il dans la surface de réparation du but situé du côté `side` (+1 : x>0, -1 : x<0) ? */
export const isInPenaltyArea = (p: Vec2, side: AttackDir): boolean =>
  side * p.x >= PITCH.halfLength - PITCH.penaltyAreaLength && Math.abs(p.y) <= PITCH.penaltyAreaHalfWidth;

export const isInGoalArea = (p: Vec2, side: AttackDir): boolean =>
  side * p.x >= PITCH.halfLength - PITCH.goalAreaLength && Math.abs(p.y) <= PITCH.goalAreaHalfWidth;

/**
 * Angle sous lequel le but (attaqué dans la direction dir) est vu depuis p, en radians.
 * C'est l'angle entre les deux poteaux vus depuis p (« angle de tir »).
 */
export const goalAngle = (p: Vec2, dir: AttackDir): number => {
  const [p1, p2] = goalPosts(dir);
  const a1 = Math.atan2(p1.y - p.y, p1.x - p.x);
  const a2 = Math.atan2(p2.y - p.y, p2.x - p.x);
  let d = Math.abs(a1 - a2);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
};

/** Distance au centre du but attaqué. */
export const distToGoal = (p: Vec2, dir: AttackDir): number => Math.hypot(dir * PITCH.halfLength - p.x, p.y);

/**
 * Coordonnées « relatives à l'équipe » : x' = dir·x, y' = dir·y,
 * de sorte que toute équipe attaque vers +x' dans son propre repère.
 */
export const toTeamFrame = (p: Vec2, dir: AttackDir): Vec2 => ({ x: dir * p.x, y: dir * p.y });
export const fromTeamFrame = (p: Vec2, dir: AttackDir): Vec2 => ({ x: dir * p.x, y: dir * p.y });
