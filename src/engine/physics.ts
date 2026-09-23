/**
 * Intégration physique : déplacement des joueurs vers leur cible (§3.1), ballon roulant / aérien (§3.2),
 * prises de balle et duels (§3.3). Pas de règles ici (voir rules.ts) : les issues physiques qui doivent être
 * journalisées (prise de balle, tacle, duel gagné) sont déposées dans une file par état, lue par applyRules.
 */
import type { BallFlight, MatchState, Player, SimParams, Ball, TeamId } from '../core/types';
import type { Vec2 } from '../core/vec2';
import { attackDir } from '../core/types';
import type { Rng } from '../core/rng';
import { PITCH, isInsidePitch } from '../core/pitch';
import { clamp, sigmoid } from '../core/vec2';
import { GRAVITY, isFrozen, playerById, pressureAt } from './helpers';

export { GRAVITY };
/** Les joueurs peuvent déborder du terrain de 2 m (touches, corners). */
const PLAYER_PITCH_MARGIN = 2;
/** Un joueur à moins de 0,3 m de sa cible est considéré arrivé (vitesse désirée nulle). */
const ARRIVAL_RADIUS = 0.3;
/** Le ballon est maintenu 0,5 m devant le porteur. */
const BALL_CARRY_OFFSET = 0.5;
/** Vitesse en dessous de laquelle le ballon roulant s'arrête (m/s). */
const BALL_STOP_SPEED = 0.1;
/** Vitesse verticale minimale pour rebondir ; en dessous, le ballon reste au sol (m/s). */
const BOUNCE_MIN_VZ = 1.0;
/** Conservation de la vitesse horizontale au rebond. */
const BOUNCE_HORIZONTAL = 0.8;
/** Fraction de a_max utilisée par le profil de freinage v ≤ √(2·k·a·d) (évite le dépassement de la cible). */
const BRAKE_FACTOR = 0.9;
/** Vitesse du ballon libéré par un tacle (m/s). */
const LOOSE_BALL_SPEED = 2;
/** Un joueur est « en mouvement vers le ballon » si sa vitesse dans cette direction dépasse ce seuil (m/s). */
const MOVING_TOWARD_SPEED = 0.5;

// ---------------------------------------------------------------------------
// File d'issues physiques (par état) lue par rules.ts
// ---------------------------------------------------------------------------
export type PhysicsEvent =
  | { kind: 'control'; playerId: number; flight: BallFlight | null; contested: boolean; lastTouchId: number | null }
  | { kind: 'tackle'; tacklerId: number; victimId: number; loose: boolean; probability: number }
  | { kind: 'duel_won'; carrierId: number; defenderId: number; probability: number };

const pending = new WeakMap<MatchState, PhysicsEvent[]>();

function emit(state: MatchState, event: PhysicsEvent): void {
  let list = pending.get(state);
  if (!list) { list = []; pending.set(state, list); }
  list.push(event);
}

/** Retire et retourne les issues physiques accumulées depuis le dernier appel pour cet état. */
export function takePhysicsEvents(state: MatchState): PhysicsEvent[] {
  const list = pending.get(state);
  if (!list) return [];
  pending.delete(state);
  return list;
}

// ---------------------------------------------------------------------------
// Pas de simulation
// ---------------------------------------------------------------------------

/** Avance l'état d'un pas dt (mutation en place). */
export function stepPhysics(state: MatchState, params: SimParams, rng: Rng, dt: number): void {
  const ph = params.physics;
  const ball = state.ball;
  const frozen = isFrozen(state);
  let owner = ball.ownerId !== null ? playerById(state, ball.ownerId) : undefined;
  if (ball.ownerId !== null && !owner) { ball.ownerId = null; owner = undefined; }

  // 1. Joueurs (le porteur d'une remise en jeu attend, ballon au pied)
  for (const p of state.players) movePlayer(p, p === owner, frozen && p === owner, ph, dt, state.time);
  separatePlayers(state.players, ph.playerSeparation);

  // 2. Ballon
  if (frozen) {
    ball.vel.x = 0;
    ball.vel.y = 0;
    return;
  }
  if (owner) {
    carryBall(ball, owner);
  } else {
    moveFreeBall(ball, ph, dt);
    ballControl(state, params, rng);
  }

  // 3. Duels autour du porteur
  if (ball.ownerId !== null) resolveDuels(state, params, rng);
}

/** Cinématique d'un joueur (§3.1) : vitesse désirée vers la cible, accélération bornée, vitesse plafonnée. */
function movePlayer(p: Player, isOwner: boolean, pinned: boolean, ph: SimParams['physics'], dt: number, time: number): void {
  if (pinned || (p.beatenUntil !== undefined && time < p.beatenUntil)) {
    p.vel.x = 0;
    p.vel.y = 0;
    return;
  }
  const cap = p.maxSpeed * (isOwner ? ph.dribbleSpeedFactor : 1);
  let dx = 0, dy = 0;
  if (p.target) {
    const ox = p.target.x - p.pos.x, oy = p.target.y - p.pos.y;
    const d = Math.hypot(ox, oy);
    if (d > ARRIVAL_RADIUS) {
      let s = Math.min(Math.max(0, p.targetSpeed), cap);
      s = Math.min(s, Math.sqrt(2 * BRAKE_FACTOR * p.maxAccel * d)); // profil de freinage
      s = Math.min(s, cap * Math.min(1, d / ph.slowDownDistance)); // ralentissement à l'approche (§3.1)
      dx = (ox / d) * s;
      dy = (oy / d) * s;
    }
  }
  let ax = dx - p.vel.x, ay = dy - p.vel.y;
  const an = Math.hypot(ax, ay);
  const aMax = p.maxAccel * dt;
  if (an > aMax) { ax *= aMax / an; ay *= aMax / an; }
  p.vel.x += ax;
  p.vel.y += ay;
  const sp = Math.hypot(p.vel.x, p.vel.y);
  if (sp > cap) { p.vel.x *= cap / sp; p.vel.y *= cap / sp; }
  p.pos.x += p.vel.x * dt;
  p.pos.y += p.vel.y * dt;
  const limX = PITCH.halfLength + PLAYER_PITCH_MARGIN, limY = PITCH.halfWidth + PLAYER_PITCH_MARGIN;
  if (p.pos.x > limX) { p.pos.x = limX; p.vel.x = 0; } else if (p.pos.x < -limX) { p.pos.x = -limX; p.vel.x = 0; }
  if (p.pos.y > limY) { p.pos.y = limY; p.vel.y = 0; } else if (p.pos.y < -limY) { p.pos.y = -limY; p.vel.y = 0; }
}

/** Séparation douce : deux joueurs ne sont jamais à moins de `minDist` l'un de l'autre. */
function separatePlayers(players: Player[], minDist: number): void {
  const min2 = minDist * minDist;
  for (let i = 0; i < players.length; i++) {
    const a = players[i];
    for (let j = i + 1; j < players.length; j++) {
      const b = players[j];
      let dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min2) continue;
      let d = Math.sqrt(d2);
      if (d < 1e-6) { dx = 1; dy = 0; d = 1; } // superposition exacte : séparation le long de x
      const push = (minDist - d) / 2;
      const ux = dx / d, uy = dy / d;
      a.pos.x -= ux * push; a.pos.y -= uy * push;
      b.pos.x += ux * push; b.pos.y += uy * push;
    }
  }
}

/** Ballon conduit : 0,5 m devant le porteur dans sa direction de course, vitesse du porteur. */
function carryBall(ball: Ball, owner: Player): void {
  const sp = Math.hypot(owner.vel.x, owner.vel.y);
  let hx: number, hy: number;
  if (sp > MOVING_TOWARD_SPEED) {
    hx = owner.vel.x / sp; hy = owner.vel.y / sp;
  } else if (owner.target && Math.hypot(owner.target.x - owner.pos.x, owner.target.y - owner.pos.y) > ARRIVAL_RADIUS) {
    const ox = owner.target.x - owner.pos.x, oy = owner.target.y - owner.pos.y;
    const d = Math.hypot(ox, oy);
    hx = ox / d; hy = oy / d;
  } else {
    hx = attackDir(owner.team); hy = 0;
  }
  let bx = owner.pos.x + BALL_CARRY_OFFSET * hx, by = owner.pos.y + BALL_CARRY_OFFSET * hy;
  if (!isInsidePitch({ x: bx, y: by }, -0.3)) {
    // près d'une ligne (remise en jeu), le ballon est gardé côté terrain
    const cx = -owner.pos.x, cy = -owner.pos.y;
    const cn = Math.hypot(cx, cy) || 1;
    bx = owner.pos.x + BALL_CARRY_OFFSET * (cx / cn);
    by = owner.pos.y + BALL_CARRY_OFFSET * (cy / cn);
  }
  ball.pos.x = bx;
  ball.pos.y = by;
  ball.vel.x = owner.vel.x;
  ball.vel.y = owner.vel.y;
  ball.z = 0;
  ball.vz = 0;
}

/**
 * Ballon libre : roulement avec décélération μ (§3.2) ou vol balistique avec rebond.
 * Premier contact au sol d'un lob / dégagement : la pelouse absorbe l'impact — vitesse horizontale bornée à
 * `lobLandingSpeed`, restitution verticale `lobBounce` — pour que le ballon soit contrôlable au point visé ;
 * les rebonds suivants (et ceux des tirs) gardent la règle générale (ballBounce, 80 % de vitesse horizontale).
 */
function moveFreeBall(ball: Ball, ph: SimParams['physics'], dt: number): void {
  if (ball.z > 0 || ball.vz !== 0) {
    const zPrev = ball.z, vzPrev = ball.vz;
    ball.pos.x += ball.vel.x * dt;
    ball.pos.y += ball.vel.y * dt;
    ball.z += ball.vz * dt;
    ball.vz -= GRAVITY * dt;
    if (ball.z <= 0) {
      // Contact au sol interpolé dans le pas (fraction f du pas avant le contact, z linéaire dans le pas) ; la vitesse
      // d'impact est celle de la trajectoire continue au contact (pas la vitesse de fin de pas, qui ferait rebondir
      // indéfiniment un ballon dont l'impact avoisine BOUNCE_MIN_VZ).
      const f = zPrev > 0 && vzPrev < 0 ? clamp(zPrev / (zPrev - ball.z), 0, 1) : 1;
      const impact = Math.max(0, -(vzPrev - GRAVITY * f * dt));
      ball.z = 0;
      const fl = ball.flight;
      const landing = fl !== null && !fl.landed && (fl.kind === 'lob' || fl.kind === 'clearance');
      if (landing) {
        // Atterrissage au point de la trajectoire continue, puis le reste du pas est parcouru à la vitesse amortie.
        fl.landed = true;
        const rest = (1 - f) * dt;
        ball.pos.x -= ball.vel.x * rest;
        ball.pos.y -= ball.vel.y * rest;
        const sp = Math.hypot(ball.vel.x, ball.vel.y);
        if (sp > ph.lobLandingSpeed) { const k = ph.lobLandingSpeed / sp; ball.vel.x *= k; ball.vel.y *= k; }
        ball.pos.x += ball.vel.x * rest;
        ball.pos.y += ball.vel.y * rest;
        ball.vz = impact > BOUNCE_MIN_VZ ? impact * ph.lobBounce : 0;
      } else if (impact > BOUNCE_MIN_VZ) {
        ball.vz = impact * ph.ballBounce;
        ball.vel.x *= BOUNCE_HORIZONTAL;
        ball.vel.y *= BOUNCE_HORIZONTAL;
      } else {
        ball.vz = 0;
      }
    }
    return;
  }
  const sp = Math.hypot(ball.vel.x, ball.vel.y);
  if (sp <= 0) return;
  const ns = sp - ph.ballFriction * dt;
  if (ns <= BALL_STOP_SPEED) {
    ball.vel.x = 0;
    ball.vel.y = 0;
    return;
  }
  const k = ns / sp;
  ball.vel.x *= k;
  ball.vel.y *= k;
  ball.pos.x += ball.vel.x * dt;
  ball.pos.y += ball.vel.y * dt;
}

/**
 * Prise de balle (§3.3) : tout joueur à moins de r_ctl (+ bonus si ballon lent) d'un ballon bas, avec une vitesse
 * relative < 12 m/s, qui n'est ni « passé » ni le frappeur dans le délai d'immunité. Plusieurs candidats des deux
 * équipes le même tick ⇒ tirage pondéré (mouvement vers le ballon, attribut, distance).
 * La vitesse relative ignore la composante de la vitesse du joueur dirigée vers le ballon : un receveur qui court
 * au-devant d'une passe l'amortit (le ballon seul compte), alors qu'un ballon qui le croise ou le dépasse est jugé
 * sur la vitesse relative complète (les tirs à 25 m/s restent incontrôlables).
 */
function ballControl(state: MatchState, params: SimParams, rng: Rng): void {
  const ph = params.physics;
  const ball = state.ball;
  if (ball.z >= ph.controlMaxHeight) return;
  const sp = Math.hypot(ball.vel.x, ball.vel.y);
  const radius = ph.controlRadius + (sp < ph.controlSlowSpeed ? ph.controlSlowBonus : 0);
  const r2 = radius * radius;
  const maxRel2 = ph.controlMaxRelSpeed * ph.controlMaxRelSpeed;
  const time = state.time;
  const fl = ball.flight;
  let candidates: Player[] | null = null;
  let single: Player | undefined;
  for (const p of state.players) {
    if (p.beatenUntil !== undefined && time < p.beatenUntil) continue;
    if (time - p.lastKickTime < ph.kickerImmunity) continue;
    if (fl && fl.kickerId === p.id && time - fl.startTime < ph.kickerImmunity) continue;
    const dx = ball.pos.x - p.pos.x, dy = ball.pos.y - p.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) continue;
    // Vitesse du joueur privée de sa composante vers le ballon (un joueur qui va au ballon l'absorbe)
    let pvx = p.vel.x, pvy = p.vel.y;
    if (d2 > 1e-9) {
      const toward = (pvx * dx + pvy * dy) / d2;
      if (toward > 0) { pvx -= toward * dx; pvy -= toward * dy; }
    }
    const rvx = ball.vel.x - pvx, rvy = ball.vel.y - pvy;
    if (rvx * rvx + rvy * rvy >= maxRel2) continue;
    if (!single) single = p;
    else { if (!candidates) candidates = [single]; candidates.push(p); }
  }
  if (!single) return;
  let taker = single;
  let contested = false;
  if (candidates) {
    let mixed = false;
    for (const c of candidates) if (c.team !== candidates[0].team) { mixed = true; break; }
    if (!mixed) {
      let bestD = Infinity;
      for (const c of candidates) {
        const d = (c.pos.x - ball.pos.x) ** 2 + (c.pos.y - ball.pos.y) ** 2;
        if (d < bestD) { bestD = d; taker = c; }
      }
    } else {
      contested = true;
      let total = 0;
      const weights: number[] = [];
      for (const c of candidates) {
        const dx = ball.pos.x - c.pos.x, dy = ball.pos.y - c.pos.y;
        const d = Math.hypot(dx, dy);
        const toward = d > 1e-6 && (c.vel.x * dx + c.vel.y * dy) / d > MOVING_TOWARD_SPEED ? 1 : 0;
        const attr = c.team === state.possession ? c.attrs.dribbling : c.attrs.defending;
        const w = Math.exp(1.5 * toward + 1.2 * (attr - 0.5) - d);
        weights.push(w);
        total += w;
      }
      let u = rng.next() * total;
      taker = candidates[candidates.length - 1];
      for (let i = 0; i < candidates.length; i++) {
        u -= weights[i];
        if (u <= 0) { taker = candidates[i]; break; }
      }
    }
  }
  const previousFlight = ball.flight;
  const lastTouchId = ball.lastTouchId;
  ball.ownerId = taker.id;
  ball.lastTouchId = taker.id;
  ball.vel.x = taker.vel.x;
  ball.vel.y = taker.vel.y;
  ball.z = 0;
  ball.vz = 0;
  ball.flight = null;
  taker.lastControlTime = time;
  emit(state, { kind: 'control', playerId: taker.id, flight: previousFlight, contested, lastTouchId });
}

/**
 * Duels (§3.3) : un adversaire qui **attaque** le porteur — à moins de r_tackle et se rapprochant de lui à plus de
 * `duelClosingSpeed` (le porteur qui fonce sur lui compte aussi : prise à défaut), ou resté à son contact (dans
 * r_tackle) plus de `duelContactTime` s — déclenche un duel, au plus un par `duelCooldown` pour ce défenseur **et**
 * pour ce porteur, jamais dans les `duelCarrierGrace` s qui suivent une prise de balle. Un défenseur qui contient à
 * distance ou marche à côté du porteur ne déclenche rien ; un face-à-face prolongé ne peut pas durer indéfiniment.
 * P_win^def = σ(base + goalSide·[côté but] + pressure·Π₋(b) + skill·(defending − dribbling)), borné, où Π₋ est la
 * pression des autres adversaires (le tacleur lui-même n'est pas compté deux fois).
 * Victoire ⇒ ballon au tacleur (tackleKeepProb) ou libre à 1,5 m vers lui ; défaite ⇒ défenseur « passé ».
 */
function resolveDuels(state: MatchState, params: SimParams, rng: Rng): void {
  const ph = params.physics;
  const ball = state.ball;
  const owner = playerById(state, ball.ownerId!);
  if (!owner) return;
  const time = state.time;
  const carrierReady = !(owner.lastDuelTime !== undefined && time - owner.lastDuelTime < ph.duelCooldown)
    && !(owner.lastControlTime !== undefined && time - owner.lastControlTime < ph.duelCarrierGrace);
  const r2 = params.defence.tackleRadius * params.defence.tackleRadius;
  const dir = attackDir(owner.team);
  for (const d of state.players) {
    if (d.team === owner.team) continue;
    const dx = d.pos.x - owner.pos.x, dy = d.pos.y - owner.pos.y;
    const d2 = dx * dx + dy * dy;
    // Suivi du contact (entrée / sortie de r_tackle), tenu à jour même pendant les délais d'attente
    if (d2 > r2) { d.duelContactSince = undefined; continue; }
    if (d.duelContactSince === undefined) d.duelContactSince = time;
    if (!carrierReady) continue;
    if (d.beatenUntil !== undefined && time < d.beatenUntil) continue;
    if (d.lastDuelTime !== undefined && time - d.lastDuelTime < ph.duelCooldown) continue;
    // Vitesse de rapprochement (m/s) : projection de la vitesse relative sur l'axe porteur → défenseur
    const n = Math.sqrt(d2) || 1;
    const closing = -((d.vel.x - owner.vel.x) * dx + (d.vel.y - owner.vel.y) * dy) / n;
    if (closing < ph.duelClosingSpeed && time - d.duelContactSince < ph.duelContactTime) continue;
    d.lastDuelTime = time;
    d.duelContactSince = time;
    owner.lastDuelTime = time;
    const goalSide = dx * dir > 0 ? 1 : 0;
    const pressure = pressureExcluding(state, ball.pos, owner.team, params, d);
    const z = ph.duelBase + ph.duelGoalSide * goalSide + ph.duelPressure * pressure + ph.duelSkill * (d.attrs.defending - owner.attrs.dribbling);
    const p = clamp(sigmoid(z), ph.duelMinProb, ph.duelMaxProb);
    if (rng.bernoulli(p)) {
      const keep = rng.bernoulli(ph.tackleKeepProb);
      if (keep) {
        ball.ownerId = d.id;
        ball.lastTouchId = d.id;
        ball.pos.x = d.pos.x;
        ball.pos.y = d.pos.y;
        ball.vel.x = d.vel.x;
        ball.vel.y = d.vel.y;
        ball.flight = null;
      } else {
        const ux = dx / n, uy = dy / n;
        ball.ownerId = null;
        ball.lastTouchId = d.id;
        ball.pos.x = owner.pos.x + ux * ph.tackleLooseDistance;
        ball.pos.y = owner.pos.y + uy * ph.tackleLooseDistance;
        ball.vel.x = ux * LOOSE_BALL_SPEED;
        ball.vel.y = uy * LOOSE_BALL_SPEED;
        ball.flight = {
          kind: 'loose', kickerId: owner.id, targetId: null, targetPoint: { x: ball.pos.x, y: ball.pos.y },
          origin: { x: owner.pos.x, y: owner.pos.y }, startTime: time, initialSpeed: LOOSE_BALL_SPEED,
        };
      }
      ball.z = 0;
      ball.vz = 0;
      emit(state, { kind: 'tackle', tacklerId: d.id, victimId: owner.id, loose: !keep, probability: p });
    } else {
      d.beatenUntil = time + ph.beatenFreeze;
      emit(state, { kind: 'duel_won', carrierId: owner.id, defenderId: d.id, probability: p });
    }
    return; // un seul duel par tick
  }
}

/** Pression Π(q) subie par `team` en excluant un adversaire donné (le tacleur, déjà représenté par le terme de base). */
function pressureExcluding(state: MatchState, q: Vec2, team: TeamId, params: SimParams, excluded: Player): number {
  const players = state.players.filter((p) => p !== excluded);
  return pressureAt({ ...state, players }, q, team, params);
}
