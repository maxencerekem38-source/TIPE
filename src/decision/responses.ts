/**
 * Réponses défensives de la profondeur 2 (docs/CONCEPTION.md §6.3) :
 *   R = { hold (tenir la forme), press (les 2 adversaires les plus proches de q⁺ y courent),
 *         cover (l'adversaire le plus proche de la meilleure ligne de passe issue de q⁺ se place sur son point faible),
 *         drop (la ligne défensive recule de 5 m vers son but) }.
 *
 * Chaque réponse est un re-ciblage de 2–3 défenseurs exécuté pendant la durée T_a de l'action avec le modèle de
 * mouvement §4.1 : le défenseur poursuit sa course pendant le temps de réaction τ_r puis accélère (a_max, v_max)
 * vers sa cible ; il ne parcourt que la distance couvrable en T_a, la pessimisation est donc bornée physiquement.
 *
 * L'état de base s⁺_hold (joueurs avancés de T_a à vitesse constante, ballon et nouveau porteur en q⁺) est partagé ;
 * une réponse ne duplique que les joueurs qu'elle déplace (copie superficielle du tableau, pas d'allocation profonde).
 */
import type { Vec2 } from '../core/vec2';
import { PITCH } from '../core/pitch';
import type { Candidate, DefensiveResponse, MatchState, Player, SimParams, TeamId } from '../core/types';
import { attackDir } from '../core/types';
import { pitchControlAt, threatAt } from '../models/fields';
import { shallowPlayers } from './evaluate';

/** Ensemble ordonné des réponses (§6.3) ; `hold` est toujours première (elle fournit la ligne de passe de `cover`). */
export const RESPONSES: readonly DefensiveResponse[] = ['hold', 'press', 'cover', 'drop'];
/** Nombre minimal de réponses évaluées (hold + press). */
export const MIN_RESPONSES = 2;
/** Nombre d'adversaires qui courent vers le point d'arrivée dans la réponse « press ». */
export const PRESS_DEFENDERS = 2;
/** Distance (m) à laquelle un presseur s'arrête du receveur (rayon de duel). */
export const PRESS_STANDOFF = 1.2;
/** Recul (m) de la ligne défensive dans la réponse « drop » (§6.3). */
export const DROP_DISTANCE = 5;
/** Libellés français des réponses (explications). */
export const RESPONSE_LABELS: Record<DefensiveResponse, string> = {
  hold: 'tenir la forme',
  press: 'presser le receveur',
  cover: 'couvrir la ligne de passe',
  drop: 'reculer la ligne',
};

/** Meilleure ligne de passe issue de q⁺ (suite du nouveau porteur) et son point faible (§4.6). */
export interface OnwardLane {
  from: Vec2;
  to: Vec2;
  weakPoint: Vec2;
}

/** Distance (m) parcourue en `t` s par un joueur parti de l'arrêt après réaction τ (§4.1). */
export function runDistance(t: number, vmax: number, amax: number, tau: number): number {
  const s = Math.max(0, t - tau);
  const tAcc = vmax / amax;
  return s <= tAcc ? 0.5 * amax * s * s : (vmax * vmax) / (2 * amax) + vmax * (s - tAcc);
}

/**
 * Déplace (en place) le défenseur `d` vers `target` de la distance qu'il peut couvrir en `T` s (réaction τ puis
 * accélération bornée), sans s'approcher à moins de `standoff` m de la cible ; sa vitesse devient celle de sa course.
 */
export function displaceToward(d: Player, target: Vec2, T: number, tau: number, standoff = 0): void {
  const dx = target.x - d.pos.x, dy = target.y - d.pos.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return;
  const covered = Math.min(runDistance(T, d.maxSpeed, d.maxAccel, tau), Math.max(0, dist - standoff));
  const ux = dx / dist, uy = dy / dist;
  d.pos.x = d.pos.x + ux * covered;
  d.pos.y = d.pos.y + uy * covered;
  const speed = covered > 0 ? Math.min(d.maxSpeed, d.maxAccel * Math.max(0, T - tau)) : 0;
  d.vel.x = ux * speed;
  d.vel.y = uy * speed;
}

/** Identifiant du porteur après succès : le receveur pour une passe, le porteur lui-même sinon (null : pas de suite). */
export function nextOwnerId(c: Candidate, playerId: number): number | null {
  const a = c.action;
  if (a.type === 'pass') return a.targetId;
  if (a.type === 'dribble' || a.type === 'hold') return playerId;
  return null;
}

/**
 * État de base s⁺_hold après le succès du candidat : joueurs avancés de T_a à vitesse constante (bornés au terrain),
 * nouveau porteur `ownerId` au point d'arrivée q⁺ (vitesse de conduite pour un dribble), ballon en q⁺.
 */
export function predictHoldState(state: MatchState, c: Candidate, playerId: number, ownerId: number, params: SimParams): MatchState {
  const T = c.duration ?? 0;
  const q = c.successPoint!;
  const players = shallowPlayers(state.players);
  const me = state.players[playerId]?.id === playerId ? state.players[playerId] : state.players.find((p) => p.id === playerId)!;
  for (const p of players) {
    p.pos.x = Math.max(-PITCH.halfLength, Math.min(PITCH.halfLength, p.pos.x + p.vel.x * T));
    p.pos.y = Math.max(-PITCH.halfWidth, Math.min(PITCH.halfWidth, p.pos.y + p.vel.y * T));
    if (p.id === ownerId) {
      p.pos.x = q.x; p.pos.y = q.y;
      if (c.action.type === 'dribble') {
        const v = params.physics.dribbleSpeedFactor * p.maxSpeed;
        p.vel.x = c.action.direction.x * v; p.vel.y = c.action.direction.y * v;
      }
      // Receveur d'une passe : sa possession continue repart de zéro dans la suite (sinon la date de sa dernière prise
      // de balle, éventuellement ancienne, lui vaudrait la pression du temps de possession, §6.2) ; un dribble ou une
      // conservation prolongent celle du porteur.
      if (c.action.type === 'pass') p.lastControlTime = state.time;
    }
  }
  return {
    ...state,
    players,
    ball: { ...state.ball, pos: { x: q.x, y: q.y }, vel: { x: 0, y: 0 }, z: 0, vz: 0, ownerId, lastTouchId: ownerId, flight: null },
    possession: me.team,
  };
}

/** Distance d'un point au segment [a, b]. */
function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const vx = b.x - a.x, vy = b.y - a.y;
  const l2 = vx * vx + vy * vy;
  let t = l2 > 1e-12 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

/**
 * Applique la réponse `kind` à l'état de base `base` (s⁺_hold) : nouvel état dont seuls les défenseurs déplacés sont
 * copiés. `q` est le point d'arrivée, `team` l'équipe attaquante, `T` la durée de l'action, `lane` la meilleure ligne
 * de passe issue de q⁺ (nécessaire à `cover`). Retourne null lorsque la réponse est identique à `hold` (cover sans
 * ligne de passe, drop sans ligne défensive) : l'appelant réutilise alors la valeur de `hold`.
 */
export function applyResponse(kind: DefensiveResponse, base: MatchState, q: Vec2, team: TeamId, T: number, params: SimParams, lane: OnwardLane | null): MatchState | null {
  if (kind === 'hold') return base;
  const tau = params.models.reactionTime;
  const players = base.players.slice();
  const clone = (k: number): Player => {
    const p = players[k];
    const c: Player = { ...p, pos: { x: p.pos.x, y: p.pos.y }, vel: { x: p.vel.x, y: p.vel.y } };
    players[k] = c;
    return c;
  };
  let moved = 0;
  switch (kind) {
    case 'press': {
      // Les PRESS_DEFENDERS adversaires les plus proches de q⁺ y courent pendant T.
      const idx: number[] = [];
      for (let k = 0; k < players.length; k++) if (players[k].team !== team) idx.push(k);
      idx.sort((a, b) => {
        const pa = players[a].pos, pb = players[b].pos;
        return (pa.x - q.x) ** 2 + (pa.y - q.y) ** 2 - ((pb.x - q.x) ** 2 + (pb.y - q.y) ** 2);
      });
      for (let i = 0; i < Math.min(PRESS_DEFENDERS, idx.length); i++) {
        displaceToward(clone(idx[i]), q, T, tau, PRESS_STANDOFF);
        moved++;
      }
      break;
    }
    case 'cover': {
      // L'adversaire le plus proche de la meilleure ligne de passe issue de q⁺ se place sur son point faible.
      if (!lane) return null;
      let best = -1, bestD = Infinity;
      for (let k = 0; k < players.length; k++) {
        const p = players[k];
        if (p.team === team) continue;
        const d = segmentDistance(p.pos, lane.from, lane.to);
        if (d < bestD) { bestD = d; best = k; }
      }
      if (best < 0) return null;
      displaceToward(clone(best), lane.weakPoint, T, tau);
      moved++;
      break;
    }
    case 'drop': {
      // La ligne défensive (défenseurs de champ) recule de DROP_DISTANCE m vers son propre but (= but visé par `team`).
      const dir = attackDir(team);
      for (let k = 0; k < players.length; k++) {
        const p = players[k];
        if (p.team === team || p.role !== 'DF') continue;
        const target = { x: Math.max(-PITCH.halfLength, Math.min(PITCH.halfLength, p.pos.x + dir * DROP_DISTANCE)), y: p.pos.y };
        displaceToward(clone(k), target, T, tau);
        moved++;
      }
      break;
    }
  }
  if (moved === 0) return null;
  return { ...base, players };
}

/** Θ_r(q⁺) = xT(q⁺) · PC_att(q⁺) sur l'état ajusté par la réponse (contrôle exact, §4.2). */
export function responseThreat(next: MatchState, q: Vec2, team: TeamId, params: SimParams): number {
  return threatAt(q, team, params) * pitchControlAt(next, q, team, params);
}

/** Meilleure ligne de passe au sol d'une suite (jeu réduit) : point d'arrivée et point faible du meilleur candidat « passe ». */
export function bestOnwardLane(continuation: readonly Candidate[], from: Vec2): OnwardLane | null {
  for (const c of continuation) {
    if (c.action.type !== 'pass' || !c.successPoint) continue;
    return { from: { x: from.x, y: from.y }, to: c.successPoint, weakPoint: c.failurePoint ?? c.successPoint };
  }
  return null;
}
