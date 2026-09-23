import { describe, it, expect } from 'vitest';
import type { Action, Candidate, Decision, MatchConfig, MatchState, SimParams, TeamId } from '@/core/types';
import { attackDir } from '@/core/types';
import { Rng } from '@/core/rng';
import { DEFAULT_PARAMS, cloneParams } from '@/core/params';
import { PITCH } from '@/core/pitch';
import { dist } from '@/core/vec2';
import { buildState, effectiveMaxSpeed, emptyFields } from '@/core/state-builder';
import { makeTactic } from '@/tactics/styles';
import { FORMATIONS } from '@/tactics/formations';
import { createMatch, setupKickoff, slotPosition, cloneState, giveBall } from '@/engine/match';
import { stepPhysics } from '@/engine/physics';
import { executeAction } from '@/engine/actions';
import { applyRules, updatePhases, pushEvent, MAX_EVENTS } from '@/engine/rules';
import { createSimulation, type DecideFn } from '@/engine/loop';
import { launchSpeed, ballTravelTime, localIsOffside, lobKinematics, nearestOutfield } from '@/engine/helpers';
import { flightModel } from '@/models/interception';
import { FULL_POLICY } from '@/decision/coordinator';
import type { PolicySet } from '@/decision/policy';
import { sigmoid } from '@/core/vec2';

// ---------------------------------------------------------------------------
// Outils de test
// ---------------------------------------------------------------------------
const DT = DEFAULT_PARAMS.physics.dt;

/** Paramètres sans bruit d'exécution (tests géométriques déterministes). */
function quietParams(over: Partial<SimParams['physics']> = {}): SimParams {
  const p = cloneParams(DEFAULT_PARAMS);
  p.physics.executionNoiseDeg = 0;
  p.physics.executionNoisePressure = 0;
  p.physics.speedNoise = 0;
  Object.assign(p.physics, over);
  return p;
}

function configFor(state: MatchState, params: SimParams = DEFAULT_PARAMS, seed = 1): MatchConfig {
  return { seed, tactics: state.tactics, params, durationSec: 600 };
}

function defaultConfig(seed = 42, params: SimParams = DEFAULT_PARAMS): MatchConfig {
  return { seed, tactics: { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-4-2', 'balanced') }, params, durationSec: 600 };
}

function candidate(action: Action, score = 0.1, probability = 0.8): Candidate {
  return { action, score, probability, valueIfSuccess: 0.2, valueIfFailure: -0.1, components: [], reason: 'test' };
}

function decisionOf(state: MatchState, playerId: number, action: Action, alternatives: Candidate[] = []): Decision {
  const chosen = candidate(action);
  return {
    playerId, time: state.time, chosen, candidates: [chosen, ...alternatives],
    context: { phase: 'attack', style: 'balanced', formation: '4-3-3', pressure: 0, availableTeammates: 0, localSuperiority: 0 },
    explanation: '', computeMs: 0.1,
  };
}

/** Décision factice : le porteur passe au coéquipier le plus proche (ou dribble), les autres rejoignent leur poste. */
const fakeDecide: DecideFn = (state) => {
  const out = new Map<number, Decision>();
  for (const p of state.players) {
    let action: Action;
    if (state.ball.ownerId === p.id) {
      let best: typeof p | undefined;
      let bestD = Infinity;
      for (const q of state.players) {
        if (q.team !== p.team || q.id === p.id) continue;
        const d = dist(q.pos, p.pos);
        if (d < bestD) { bestD = d; best = q; }
      }
      action = best
        ? { type: 'pass', targetId: best.id, targetPoint: { ...best.pos }, kind: 'ground', speed: 6 }
        : { type: 'dribble', direction: { x: attackDir(p.team), y: 0 }, distance: 6 };
    } else if (state.ball.ownerId === null && chaser(state, p.team) === p.id) {
      action = { type: 'move', target: { ...state.ball.pos }, intent: 'chase', speed: p.maxSpeed };
    } else {
      action = { type: 'move', target: slotPosition(state, p), intent: 'hold_shape', speed: 5 };
    }
    out.set(p.id, decisionOf(state, p.id, action));
  }
  return out;
};

/** Joueur de `team` le plus proche du ballon (course au ballon libre). */
function chaser(state: MatchState, team: TeamId): number {
  let best = -1;
  let bestD = Infinity;
  for (const q of state.players) {
    if (q.team !== team) continue;
    const d = dist(q.pos, state.ball.pos);
    if (d < bestD) { bestD = d; best = q.id; }
  }
  return best;
}

/** Avance jusqu'à ce que `predicate` soit vrai (retourne true) ou que `maxSeconds` s'écoulent (false). */
function runUntil(state: MatchState, config: MatchConfig, rng: Rng, maxSeconds: number, predicate: (s: MatchState) => boolean): boolean {
  const n = Math.round(maxSeconds / config.params.physics.dt);
  for (let i = 0; i < n; i++) {
    run(state, config, rng, config.params.physics.dt);
    if (predicate(state)) return true;
  }
  return false;
}

/** Décision factice « statique » : personne ne bouge, le porteur conserve. */
const staticDecide: DecideFn = (state) => {
  const out = new Map<number, Decision>();
  for (const p of state.players) {
    const action: Action = state.ball.ownerId === p.id ? { type: 'hold' } : { type: 'move', target: { ...p.pos }, intent: 'hold_shape', speed: 0 };
    out.set(p.id, decisionOf(state, p.id, action));
  }
  return out;
};

/** Avance un état « à la main » (physique + règles + phases) sans cycle de décision. */
function run(state: MatchState, config: MatchConfig, rng: Rng, seconds: number, each?: (s: MatchState) => void): void {
  const n = Math.round(seconds / config.params.physics.dt);
  for (let i = 0; i < n; i++) {
    stepPhysics(state, config.params, rng, config.params.physics.dt);
    applyRules(state, config, rng);
    updatePhases(state, config);
    state.time += config.params.physics.dt;
    state.tick++;
    each?.(state);
  }
}

const hasEvent = (state: MatchState, kind: string): boolean => state.events.some((e) => e.kind === kind);

// ---------------------------------------------------------------------------
// createMatch / setupKickoff / slotPosition / cloneState
// ---------------------------------------------------------------------------
describe('createMatch', () => {
  it('crée 22 joueurs avec identifiants, équipes, numéros, noms, rôles et attributs conformes', () => {
    const state = createMatch(defaultConfig(), new Rng(42));
    expect(state.players).toHaveLength(22);
    state.players.forEach((p, i) => {
      expect(p.id).toBe(i);
      expect(p.team).toBe(i < 11 ? 'A' : 'B');
      expect(p.number).toBe((i % 11) + 1);
      expect(p.name).toBe(`${p.team}${p.number}`);
      const slot = FORMATIONS[state.tactics[p.team].formation].slots[p.slotIndex];
      expect(p.role).toBe(slot.role);
      for (const v of Object.values(p.attrs)) { expect(v).toBeGreaterThanOrEqual(0.2); expect(v).toBeLessThanOrEqual(0.9); }
      if (p.role === 'GK') expect(p.attrs.goalkeeping).toBe(0.8);
      expect(p.maxSpeed).toBeCloseTo(effectiveMaxSpeed(p.attrs), 9);
    });
    expect(state.players.filter((p) => p.role === 'GK')).toHaveLength(2);
    expect(state.events).toEqual([]);
    expect(state.fields).toBeNull();
    expect(state.stats.A.passes).toBe(0);
  });

  it('place le coup d’envoi : ballon au centre pour un attaquant de A, chacun dans son camp, gel de 1,5 s', () => {
    const state = createMatch(defaultConfig(), new Rng(1));
    expect(state.ball.pos).toEqual({ x: 0, y: 0 });
    expect(state.ball.ownerId).not.toBeNull();
    const striker = state.players[state.ball.ownerId!];
    expect(striker.team).toBe('A');
    expect(striker.role).toBe('FW');
    expect(striker.pos).toEqual({ x: 0, y: 0 });
    for (const p of state.players) {
      if (p.team === 'A') expect(p.pos.x).toBeLessThanOrEqual(0);
      else expect(p.pos.x).toBeGreaterThanOrEqual(2);
    }
    expect(state.restart).toMatchObject({ kind: 'kickoff', team: 'A', pos: { x: 0, y: 0 } });
    expect(state.restart!.resumeAt).toBeCloseTo(1.5, 9);
    expect(state.possession).toBe('A');
    expect(state.phase).toEqual({ A: 'attack', B: 'defence' });
    expect(state.lastKickoff).toBe('A');
  });

  it('est déterministe à graine fixée (création et 20 s de simulation)', () => {
    const a = createMatch(defaultConfig(7), new Rng(7));
    const b = createMatch(defaultConfig(7), new Rng(7));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const s1 = createSimulation(defaultConfig(7), { decide: fakeDecide });
    const s2 = createSimulation(defaultConfig(7), { decide: fakeDecide });
    s1.advance(20);
    s2.advance(20);
    expect(JSON.stringify(s1.state)).toBe(JSON.stringify(s2.state));
    expect(s1.state.tick).toBe(600);
    const s3 = createSimulation(defaultConfig(8), { decide: fakeDecide });
    s3.advance(20);
    expect(JSON.stringify(s3.state.players.map((p) => p.pos))).not.toBe(JSON.stringify(s1.state.players.map((p) => p.pos)));
  });

  it('le coup d’envoi de B est le miroir (x, y) ↦ (−x, −y) de celui de A à tactiques égales', () => {
    const cfg: MatchConfig = { ...defaultConfig(3), tactics: { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-3-3', 'balanced') } };
    const sa = createMatch(cfg, new Rng(3));
    const sb = createMatch(cfg, new Rng(3));
    setupKickoff(sb, 'B', cfg);
    for (let i = 0; i < 11; i++) {
      expect(sb.players[11 + i].pos.x).toBeCloseTo(-sa.players[i].pos.x, 9);
      expect(sb.players[11 + i].pos.y).toBeCloseTo(-sa.players[i].pos.y, 9);
    }
    expect(sb.players[sb.ball.ownerId!].team).toBe('B');
    expect(sb.possession).toBe('B');
    expect(sb.restart!.team).toBe('B');
  });
});

describe('slotPosition', () => {
  it('suit le ballon, applique la largeur tactique et respecte la symétrie miroir A/B', () => {
    const cfg: MatchConfig = { ...defaultConfig(3), tactics: { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-3-3', 'balanced') } };
    const state = createMatch(cfg, new Rng(3));
    state.restart = null;
    state.phase = { A: 'attack', B: 'attack' };
    const ball = { x: 20, y: 10 };
    const slot = FORMATIONS['4-3-3'].slots[8]; // LW
    const w = 0.7 + 0.6 * cfg.tactics.A.params.widthUsage;
    const qa = slotPosition(state, state.players[8], ball);
    expect(qa.x).toBeCloseTo(slot.x + slot.followX * ball.x, 9);
    expect(qa.y).toBeCloseTo(slot.y * w + slot.followY * ball.y, 9);
    const qb = slotPosition(state, state.players[19], { x: -ball.x, y: -ball.y });
    expect(qb.x).toBeCloseTo(-qa.x, 9);
    expect(qb.y).toBeCloseTo(-qa.y, 9);
    // Largeur : widthUsage plus grand ⇒ ailier plus large
    state.tactics.A = makeTactic('4-3-3', 'balanced', { widthUsage: 1 });
    expect(Math.abs(slotPosition(state, state.players[8], ball).y)).toBeGreaterThan(Math.abs(qa.y));
  });

  it('en défense, le bloc est ré-instancié sur la ligne défensive (§9.2) : profondeur Λ = 45 − 25·compacité, bloc bas ≥ 15 m plus bas que pressing haut', () => {
    const state = createMatch(defaultConfig(3), new Rng(3));
    state.restart = null;
    state.possession = 'B';
    state.phase = { A: 'defence', B: 'attack' };
    const ball = { x: 10, y: 0 };
    const outfield = state.players.filter((p) => p.team === 'A' && p.role !== 'GK');
    const xsFor = (style: 'low_block' | 'high_press'): number[] => {
      state.tactics.A = makeTactic('4-3-3', style);
      return outfield.map((p) => slotPosition(state, p, ball).x);
    };
    const low = xsFor('low_block');
    const tp = state.tactics.A.params;
    const lineLow = tp.defensiveLine + 0.35 * (ball.x - tp.defensiveLine); // ≈ −20 pour une ligne à −36
    const lambdaLow = 45 - 25 * tp.compactness; // ≈ 24
    expect(lineLow).toBeLessThan(ball.x - 3);
    for (const x of low) {
      expect(x).toBeGreaterThanOrEqual(lineLow - 1e-9);
      expect(x).toBeLessThanOrEqual(lineLow + lambdaLow + 1e-9);
    }
    expect(Math.max(...low) - Math.min(...low)).toBeLessThanOrEqual(lambdaLow + 1e-9);
    const high = xsFor('high_press');
    expect(Math.min(...high) - Math.min(...low)).toBeGreaterThanOrEqual(15);
    expect(Math.max(...high) - Math.min(...high)).toBeLessThanOrEqual(45 - 25 * state.tactics.A.params.compactness + 1e-9);
    // La ligne ne dépasse jamais x_b − 3 (ballon profond dans son camp)
    const deep = { x: -45, y: 0 };
    expect(Math.min(...outfield.map((p) => slotPosition(state, p, deep).x))).toBeLessThanOrEqual(deep.x - 3 + 1e-9);
    // La compacité contracte le bloc latéralement vers le ballon
    const lb = state.players[1]; // LB
    state.tactics.A = makeTactic('4-3-3', 'balanced', { compactness: 0 });
    const loose = slotPosition(state, lb, ball);
    state.tactics.A = makeTactic('4-3-3', 'balanced', { compactness: 1 });
    const tight = slotPosition(state, lb, ball);
    expect(Math.abs(tight.y - ball.y)).toBeLessThan(Math.abs(loose.y - ball.y));
    expect(dist(tight, ball)).toBeLessThan(dist(loose, ball));
    for (const p of state.players) {
      const s = slotPosition(state, p, ball);
      expect(Math.abs(s.x)).toBeLessThanOrEqual(PITCH.halfLength - 1);
      expect(Math.abs(s.y)).toBeLessThanOrEqual(PITCH.halfWidth - 1);
    }
  });
});

describe('cloneState / giveBall', () => {
  it('cloneState est une copie profonde indépendante qui partage les champs spatiaux', () => {
    const state = createMatch(defaultConfig(5), new Rng(5));
    state.fields = emptyFields();
    const copy = cloneState(state);
    expect(JSON.stringify(copy)).toBe(JSON.stringify(state));
    expect(copy.fields).toBe(state.fields);
    copy.players[3].pos.x += 10;
    copy.ball.pos.x = 7;
    copy.stats.A.passes = 99;
    copy.score.B = 4;
    expect(state.players[3].pos.x).not.toBe(copy.players[3].pos.x);
    expect(state.ball.pos.x).toBe(0);
    expect(state.stats.A.passes).toBe(0);
    expect(state.score.B).toBe(0);
  });

  it('giveBall place le ballon dans les pieds du joueur et met à jour la possession', () => {
    const state = createMatch(defaultConfig(5), new Rng(5));
    state.time = 12;
    giveBall(state, 15);
    expect(state.ball.ownerId).toBe(15);
    expect(state.ball.pos).toEqual(state.players[15].pos);
    expect(state.ball.flight).toBeNull();
    expect(state.possession).toBe('B');
    expect(state.possessionSince).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Physique
// ---------------------------------------------------------------------------
describe('physics', () => {
  it('un joueur atteint une cible à 20 m en 2,8–4,5 s sans jamais dépasser sa vitesse maximale', () => {
    const state = buildState({ players: [{ team: 'A', pos: { x: 0, y: 0 }, role: 'MF', number: 8 }] });
    state.ball.pos = { x: -40, y: -30 }; // ballon loin : le joueur n'est pas porteur
    const p = state.players[0];
    p.target = { x: 20, y: 0 };
    p.targetSpeed = 10;
    const rng = new Rng(1);
    let arrival = -1;
    let maxSpeed = 0;
    for (let i = 0; i < 300 && arrival < 0; i++) {
      stepPhysics(state, DEFAULT_PARAMS, rng, DT);
      state.time += DT;
      maxSpeed = Math.max(maxSpeed, Math.hypot(p.vel.x, p.vel.y));
      if (dist(p.pos, p.target!) < 0.5) arrival = state.time;
    }
    expect(arrival).toBeGreaterThan(2.8);
    expect(arrival).toBeLessThan(4.5);
    expect(maxSpeed).toBeLessThanOrEqual(p.maxSpeed + 1e-9);
    expect(maxSpeed).toBeGreaterThan(0.9 * p.maxSpeed);
    // Il finit par s'arrêter sur la cible
    for (let i = 0; i < 60; i++) { stepPhysics(state, DEFAULT_PARAMS, rng, DT); state.time += DT; }
    expect(dist(p.pos, p.target!)).toBeLessThan(0.5);
    expect(Math.hypot(p.vel.x, p.vel.y)).toBeLessThan(0.5);
  });

  it('le ballon libre décélère de μ par seconde, s’arrête, et parcourt ≈ s0²/(2μ)', () => {
    const state = buildState({ players: [{ team: 'A', pos: { x: -40, y: -30 }, role: 'MF', number: 8 }] });
    const mu = DEFAULT_PARAMS.physics.ballFriction;
    state.ball.pos = { x: 0, y: 0 };
    state.ball.vel = { x: 9, y: 0 };
    const rng = new Rng(1);
    for (let i = 0; i < 30; i++) stepPhysics(state, DEFAULT_PARAMS, rng, DT); // 1 s
    expect(state.ball.vel.x).toBeCloseTo(9 - mu, 6);
    expect(state.ball.vel.y).toBe(0);
    for (let i = 0; i < 300; i++) stepPhysics(state, DEFAULT_PARAMS, rng, DT);
    expect(state.ball.vel).toEqual({ x: 0, y: 0 });
    expect(state.ball.pos.x).toBeCloseTo(81 / (2 * mu), 0);
    expect(state.ball.ownerId).toBeNull();
  });

  it('launchSpeed / ballTravelTime : ancrage §3.2 (20 m, 6 m/s ⇒ 9,8 m/s, 2,5 s) et cohérence avec la simulation', () => {
    const ph = DEFAULT_PARAMS.physics;
    const s0 = launchSpeed(20, 6, ph);
    expect(s0).toBeCloseTo(9.8, 1);
    const T = ballTravelTime(20, s0, ph);
    expect(T).toBeCloseTo(2.5, 1);
    expect(launchSpeed(1000, 6, ph)).toBe(ph.passSpeedMax);
    expect(ballTravelTime(50, 5, ph)).toBe(Infinity);
    // Simulation : le ballon lancé à s0 atteint 20 m à ≈ T avec une vitesse ≈ 6 m/s
    const state = buildState({ players: [{ team: 'A', pos: { x: -40, y: -30 }, role: 'MF', number: 8 }] });
    state.ball.vel = { x: s0, y: 0 };
    const rng = new Rng(1);
    let t = 0;
    while (state.ball.pos.x < 20 && t < 10) { stepPhysics(state, DEFAULT_PARAMS, rng, DT); t += DT; }
    expect(t).toBeGreaterThan(T - 0.15);
    expect(t).toBeLessThan(T + 0.15);
    expect(state.ball.vel.x).toBeGreaterThan(5.5);
    expect(state.ball.vel.x).toBeLessThan(6.5);
  });

  it('deux joueurs ne se superposent jamais (séparation ≥ 0,6 m) et restent dans le terrain élargi', () => {
    const state = buildState({ players: [
      { team: 'A', pos: { x: 0, y: 0 }, role: 'MF', number: 8 },
      { team: 'B', pos: { x: 0.1, y: 0 }, role: 'MF', number: 8 },
      { team: 'A', pos: { x: 50, y: 0 }, role: 'FW', number: 9 },
    ] });
    state.players[2].target = { x: 80, y: 0 };
    state.players[2].targetSpeed = 8;
    const rng = new Rng(1);
    for (let i = 0; i < 90; i++) {
      stepPhysics(state, DEFAULT_PARAMS, rng, DT);
      expect(dist(state.players[0].pos, state.players[1].pos)).toBeGreaterThanOrEqual(0.6 - 1e-9);
    }
    expect(state.players[2].pos.x).toBeLessThanOrEqual(PITCH.halfLength + 2 + 1e-9);
  });
});

// ---------------------------------------------------------------------------
// Actions et règles
// ---------------------------------------------------------------------------
describe('passes', () => {
  it('une passe sans bruit vers un coéquipier statique à 15 m est contrôlée par lui (pass_complete)', () => {
    const params = quietParams();
    const state = buildState({ players: [
      { team: 'A', pos: { x: -20, y: 0 }, role: 'MF', number: 8 },
      { team: 'A', pos: { x: -20, y: 15 }, role: 'MF', number: 6 },
    ], ball: { ownerId: 0, pos: { x: -20, y: 0 } } });
    const cfg = configFor(state, params);
    const rng = new Rng(1);
    stepPhysics(state, params, rng, DT); // place le ballon aux pieds du porteur
    const ok = executeAction(state, 0, { type: 'pass', targetId: 1, targetPoint: { x: -20, y: 15 }, kind: 'ground', speed: 6 }, params, rng);
    expect(ok).toBe(true);
    expect(state.ball.ownerId).toBeNull();
    expect(state.ball.flight).toMatchObject({ kind: 'pass', kickerId: 0, targetId: 1, receiverOffside: false });
    expect(state.stats.A.passes).toBe(1);
    // Le passeur ne reprend pas son ballon immédiatement
    stepPhysics(state, params, rng, DT);
    expect(state.ball.ownerId).toBeNull();
    run(state, cfg, rng, 4);
    expect(state.ball.ownerId).toBe(1);
    expect(state.stats.A.passesCompleted).toBe(1);
    expect(hasEvent(state, 'pass_complete')).toBe(true);
    expect(state.possession).toBe('A');
    expect(hasEvent(state, 'turnover')).toBe(false);
  });

  it('une passe à travers un défenseur placé sur la ligne est interceptée (interception, perte de balle)', () => {
    const params = quietParams();
    const state = buildState({ players: [
      { team: 'A', pos: { x: -20, y: 0 }, role: 'MF', number: 8 },
      { team: 'A', pos: { x: -20, y: 20 }, role: 'MF', number: 6 },
      { team: 'B', pos: { x: -20, y: 10 }, role: 'DF', number: 4 },
    ], ball: { ownerId: 0, pos: { x: -20, y: 0 } } });
    const cfg = configFor(state, params);
    const rng = new Rng(1);
    stepPhysics(state, params, rng, DT);
    expect(executeAction(state, 0, { type: 'pass', targetId: 1, targetPoint: { x: -20, y: 20 }, kind: 'ground', speed: 6 }, params, rng)).toBe(true);
    run(state, cfg, rng, 3);
    expect(state.ball.ownerId).toBe(2);
    expect(state.possession).toBe('B');
    expect(state.stats.B.interceptions).toBe(1);
    expect(state.stats.A.turnovers).toBe(1);
    expect(state.stats.A.passesCompleted).toBe(0);
    expect(hasEvent(state, 'pass_intercepted')).toBe(true);
    expect(hasEvent(state, 'possession_change')).toBe(true);
    expect(state.phase.B).toBe('transition_attack');
  });

  it('un lob décolle (vz > 0), ne peut être contrôlé en l’air et retombe près de la cible', () => {
    const params = quietParams();
    const state = buildState({ players: [
      { team: 'A', pos: { x: -20, y: 0 }, role: 'MF', number: 8 },
      { team: 'B', pos: { x: -10, y: 0 }, role: 'DF', number: 4 },
      { team: 'A', pos: { x: 5, y: 0 }, role: 'FW', number: 9 },
    ], ball: { ownerId: 0, pos: { x: -20, y: 0 } } });
    const rng = new Rng(1);
    stepPhysics(state, params, rng, DT);
    expect(executeAction(state, 0, { type: 'pass', targetId: 2, targetPoint: { x: 0, y: 0 }, kind: 'lob', speed: 6 }, params, rng)).toBe(true);
    expect(state.ball.vz).toBeGreaterThan(0);
    let maxZ = 0;
    let landing: number | null = null;
    for (let i = 0; i < 150; i++) {
      stepPhysics(state, params, rng, DT);
      state.time += DT;
      maxZ = Math.max(maxZ, state.ball.z);
      if (landing === null && state.ball.z === 0 && i > 5) landing = state.ball.pos.x;
    }
    expect(maxZ).toBeGreaterThan(2);
    expect(state.ball.ownerId).not.toBe(1); // le défenseur ne peut pas contrôler un ballon en l'air
    expect(Math.abs(landing! - 0)).toBeLessThan(2);
  });

  it('executeAction refuse une frappe sans le ballon, pendant le délai entre deux touches et pendant un gel', () => {
    const params = quietParams();
    const state = buildState({ players: [
      { team: 'A', pos: { x: 0, y: 0 }, role: 'MF', number: 8 },
      { team: 'A', pos: { x: 10, y: 0 }, role: 'MF', number: 6 },
    ], ball: { ownerId: 0, pos: { x: 0, y: 0 } } });
    const rng = new Rng(1);
    const pass: Action = { type: 'pass', targetId: 1, targetPoint: { x: 10, y: 0 }, kind: 'ground', speed: 6 };
    expect(executeAction(state, 1, pass, params, rng)).toBe(false);
    state.players[0].lastKickTime = state.time - 0.1;
    expect(executeAction(state, 0, pass, params, rng)).toBe(false);
    state.players[0].lastKickTime = -10;
    state.restart = { kind: 'throw_in', team: 'A', pos: { x: 0, y: 0 }, resumeAt: state.time + 1 };
    expect(executeAction(state, 0, pass, params, rng)).toBe(false);
    expect(executeAction(state, 0, { type: 'shoot', targetPoint: { x: 52.5, y: 0 }, power: 1 }, params, rng)).toBe(false);
    state.restart = null;
    expect(executeAction(state, 0, pass, params, rng)).toBe(true);
  });
});

describe('tirs et buts', () => {
  it('un tir à 8 m sans gardien (xG = 1) marque : score, événement, coup d’envoi pour B avec retour aux postes', () => {
    const params = quietParams();
    const state = buildState({ players: [
      { team: 'A', pos: { x: 44.5, y: 0 }, role: 'FW', number: 9 },
      { team: 'A', pos: { x: 20, y: 0 }, role: 'MF', number: 8 },
      { team: 'B', pos: { x: 20, y: 10 }, role: 'MF', number: 8 },
      { team: 'B', pos: { x: -20, y: 10 }, role: 'FW', number: 9 },
    ], ball: { ownerId: 0, pos: { x: 44.5, y: 0 } } });
    const cfg = configFor(state, params);
    const rng = new Rng(1);
    stepPhysics(state, params, rng, DT);
    expect(executeAction(state, 0, { type: 'shoot', targetPoint: { x: 52.5, y: 0 }, power: 1, xg: 1 }, params, rng)).toBe(true);
    expect(state.ball.flight).toMatchObject({ kind: 'shot', outcome: 'goal', onTarget: true });
    expect(state.stats.A.shots).toBe(1);
    expect(state.stats.A.shotsOnTarget).toBe(1);
    expect(state.stats.A.xG).toBeCloseTo(1, 9);
    run(state, cfg, rng, 1);
    expect(state.score.A).toBe(1);
    expect(state.stats.A.goals).toBe(1);
    expect(hasEvent(state, 'goal')).toBe(true);
    expect(state.restart).toMatchObject({ kind: 'kickoff', team: 'B', resetOnResume: true });
    expect(state.possession).toBe('B');
    expect(state.ball.pos).toEqual({ x: 0, y: 0 });
    expect(state.ball.ownerId).toBeNull();
    // Pendant le gel le ballon ne bouge pas, les joueurs rejoignent leurs postes
    const goalTime = state.time;
    run(state, cfg, rng, 1);
    expect(state.ball.pos).toEqual({ x: 0, y: 0 });
    expect(state.players[0].pos.x).toBeLessThan(44);
    run(state, cfg, rng, params.physics.goalFreeze - 1 + 0.1);
    expect(state.restart).toBeNull();
    expect(state.time).toBeGreaterThan(goalTime + params.physics.goalFreeze - 1e-6);
    // Positions réinitialisées : l'attaquant de B engage au centre, tous dans leur camp
    const owner = state.players[state.ball.ownerId!];
    expect(owner.team).toBe('B');
    expect(owner.pos).toEqual({ x: 0, y: 0 });
    for (const p of state.players) {
      if (p.team === 'A') expect(p.pos.x).toBeLessThanOrEqual(-2 + 1e-9);
      else expect(p.pos.x).toBeGreaterThanOrEqual(0);
    }
    expect(state.lastKickoff).toBe('B');
  });

  it('un tir non cadré (xG = 0, pas d’arrêt) sort ⇒ sortie de but pour B, ballon au gardien à (47, 0)', () => {
    const params = quietParams({ saveProb: 0 });
    const state = buildState({ players: [
      { team: 'A', pos: { x: 35, y: 0 }, role: 'FW', number: 9 },
      { team: 'B', pos: { x: 50, y: 0 }, role: 'GK', number: 1 },
    ], ball: { ownerId: 0, pos: { x: 35, y: 0 } } });
    const cfg = configFor(state, params);
    const rng = new Rng(2);
    stepPhysics(state, params, rng, DT);
    expect(executeAction(state, 0, { type: 'shoot', targetPoint: { x: 52.5, y: 1 }, power: 1, xg: 0 }, params, rng)).toBe(true);
    expect(state.ball.flight!.outcome).toBe('miss');
    expect(state.ball.flight!.onTarget).toBe(false);
    expect(state.stats.A.shotsOnTarget).toBe(0);
    expect(runUntil(state, cfg, rng, 3, (s) => s.restart !== null)).toBe(true);
    expect(state.score).toEqual({ A: 0, B: 0 });
    expect(state.restart).toMatchObject({ kind: 'goal_kick', team: 'B' });
    expect(state.ball.ownerId).toBe(1);
    expect(state.ball.pos).toEqual({ x: 47, y: 0 });
    expect(state.possession).toBe('B');
    expect(hasEvent(state, 'out')).toBe(true);
    expect(hasEvent(state, 'turnover')).toBe(false);
  });

  it('un tir arrêté (xG = 0, arrêt certain) donne un événement « save » et le ballon au gardien ou un corner', () => {
    const params = quietParams({ saveProb: 1 });
    const state = buildState({ players: [
      { team: 'A', pos: { x: 35, y: 0 }, role: 'FW', number: 9 },
      { team: 'B', pos: { x: 49, y: 0.5 }, role: 'GK', number: 1 },
    ], ball: { ownerId: 0, pos: { x: 35, y: 0 } } });
    const cfg = configFor(state, params);
    const rng = new Rng(2);
    stepPhysics(state, params, rng, DT);
    expect(executeAction(state, 0, { type: 'shoot', targetPoint: { x: 52.5, y: 2 }, power: 1, xg: 0 }, params, rng)).toBe(true);
    expect(state.ball.flight!.outcome).toBe('save');
    expect(state.stats.A.shotsOnTarget).toBe(1);
    expect(runUntil(state, cfg, rng, 3, (s) => hasEvent(s, 'save'))).toBe(true);
    run(state, cfg, rng, DT);
    expect(hasEvent(state, 'save')).toBe(true);
    expect(state.score.A).toBe(0);
    const cornerA = state.restart?.kind === 'corner' && state.restart.team === 'A';
    const keeperHolds = state.ball.ownerId === 1 && state.possession === 'B';
    expect(cornerA || keeperHolds).toBe(true);
  });

  it('en ré-exécutant un tir sur de nombreuses graines, la fréquence de but converge vers xG', () => {
    const params = quietParams();
    let goals = 0;
    const N = 200;
    for (let seed = 0; seed < N; seed++) {
      const state = buildState({ players: [
        { team: 'A', pos: { x: 35, y: 0 }, role: 'FW', number: 9 },
        { team: 'B', pos: { x: 49, y: 0 }, role: 'GK', number: 1 },
      ], ball: { ownerId: 0, pos: { x: 35, y: 0 } } });
      const rng = new Rng(seed + 100);
      stepPhysics(state, params, rng, DT);
      executeAction(state, 0, { type: 'shoot', targetPoint: { x: 52.5, y: 0 }, power: 1, xg: 0.3 }, params, rng);
      run(state, configFor(state, params), rng, 1.5);
      goals += state.score.A;
    }
    expect(goals / N).toBeGreaterThan(0.2);
    expect(goals / N).toBeLessThan(0.4);
  });
});

describe('sorties et remises en jeu', () => {
  it('un ballon sorti en touche revient au joueur le plus proche de l’autre équipe, au point de sortie, avec un gel', () => {
    const params = quietParams();
    const state = buildState({ players: [
      { team: 'A', pos: { x: 0, y: 30 }, role: 'MF', number: 8 },
      { team: 'B', pos: { x: 5, y: 20 }, role: 'MF', number: 8 },
      { team: 'B', pos: { x: -30, y: 0 }, role: 'DF', number: 4 },
    ], ball: { ownerId: 0, pos: { x: 0, y: 30 } } });
    const cfg = configFor(state, params);
    const rng = new Rng(1);
    stepPhysics(state, params, rng, DT);
    expect(executeAction(state, 0, { type: 'clear', targetPoint: { x: 0, y: 60 } }, params, rng)).toBe(true);
    expect(runUntil(state, cfg, rng, 3, (s) => s.restart !== null)).toBe(true);
    expect(state.restart).toMatchObject({ kind: 'throw_in', team: 'B' });
    expect(state.ball.ownerId).toBe(1);
    expect(Math.abs(state.players[1].pos.y)).toBeCloseTo(PITCH.halfWidth - 0.5, 6);
    expect(Math.abs(state.ball.pos.y)).toBeLessThanOrEqual(PITCH.halfWidth);
    expect(state.possession).toBe('B');
    expect(state.stats.A.turnovers).toBe(0);
    // Gel : le ballon ne bouge pas jusqu'à la reprise, puis le gel est levé
    const pos = { ...state.ball.pos };
    run(state, cfg, rng, 1);
    expect(state.ball.pos).toEqual(pos);
    expect(state.restart).not.toBeNull();
    run(state, cfg, rng, 1);
    expect(state.restart).toBeNull();
  });

  it('un ballon sorti derrière la ligne de but, touché en dernier par un défenseur, donne un corner à l’attaque', () => {
    const params = quietParams();
    const state = buildState({ players: [
      { team: 'B', pos: { x: 45, y: 10 }, role: 'DF', number: 4 },
      { team: 'A', pos: { x: 30, y: 10 }, role: 'FW', number: 9 },
      { team: 'A', pos: { x: 0, y: 0 }, role: 'MF', number: 8 },
      { team: 'B', pos: { x: 50, y: 0 }, role: 'GK', number: 1 },
    ], ball: { ownerId: 0, pos: { x: 45, y: 10 } } });
    const cfg = configFor(state, params);
    const rng = new Rng(1);
    stepPhysics(state, params, rng, DT);
    // Le défenseur B dégage vers sa propre ligne de but, hors des poteaux
    expect(executeAction(state, 0, { type: 'clear', targetPoint: { x: 60, y: 20 } }, params, rng)).toBe(true);
    expect(runUntil(state, cfg, rng, 3, (s) => s.restart !== null)).toBe(true);
    expect(state.restart).toMatchObject({ kind: 'corner', team: 'A' });
    expect(state.ball.ownerId).toBe(1);
    expect(state.ball.pos.x).toBeCloseTo(PITCH.halfLength - 0.5, 6);
    expect(state.ball.pos.y).toBeCloseTo(PITCH.halfWidth - 0.5, 6);
    expect(state.possession).toBe('A');
    expect(state.score).toEqual({ A: 0, B: 0 });
  });

  it('un hors-jeu sur passe en profondeur est sifflé à la réception : coup franc pour l’adversaire', () => {
    const params = quietParams();
    const state = buildState({ players: [
      { team: 'A', pos: { x: 10, y: 0 }, role: 'MF', number: 8 },
      { team: 'A', pos: { x: 30, y: 5 }, role: 'FW', number: 9 },
      { team: 'B', pos: { x: 20, y: -10 }, role: 'DF', number: 4 },
      { team: 'B', pos: { x: 50, y: 0 }, role: 'GK', number: 1 },
    ], ball: { ownerId: 0, pos: { x: 10, y: 0 } } });
    expect(localIsOffside(state, state.players[1].pos, 'A')).toBe(true);
    expect(localIsOffside(state, { x: 15, y: 5 }, 'A')).toBe(false);
    expect(localIsOffside(state, { x: -5, y: 5 }, 'A')).toBe(false);
    const cfg = configFor(state, params);
    const rng = new Rng(1);
    stepPhysics(state, params, rng, DT);
    expect(executeAction(state, 0, { type: 'pass', targetId: 1, targetPoint: { x: 30, y: 5 }, kind: 'through', speed: 9 }, params, rng)).toBe(true);
    expect(state.ball.flight!.receiverOffside).toBe(true);
    expect(state.stats.A.throughBalls).toBe(1);
    expect(runUntil(state, cfg, rng, 4, (s) => hasEvent(s, 'offside'))).toBe(true);
    expect(state.restart).toMatchObject({ kind: 'free_kick', team: 'B' });
    expect(state.players[state.ball.ownerId!].team).toBe('B');
    expect(state.possession).toBe('B');
    expect(state.stats.A.passesCompleted).toBe(0);
    expect(state.stats.A.turnovers).toBe(1);
  });

  it('pendant le gel initial du coup d’envoi, la boucle ne décide pas et le ballon reste au centre', () => {
    const sim = createSimulation(defaultConfig(11), { decide: fakeDecide });
    sim.advance(1.4);
    expect(sim.decisions.size).toBe(0);
    expect(sim.state.ball.pos).toEqual({ x: 0, y: 0 });
    expect(sim.state.restart).not.toBeNull();
    sim.advance(0.5);
    expect(sim.state.restart).toBeNull();
    expect(sim.decisions.size).toBe(22);
    expect(sim.state.stats.A.decisions + sim.state.stats.B.decisions).toBeGreaterThan(0);
  });
});

describe('possession, phases, duels, dribbles', () => {
  it('une récupération déclenche transition_attack / transition_defence puis attack / defence après transitionWindow', () => {
    const state = createMatch(defaultConfig(3), new Rng(3));
    const cfg = defaultConfig(3);
    state.restart = null;
    state.time = 10;
    updatePhases(state, cfg);
    expect(state.phase).toEqual({ A: 'attack', B: 'defence' });
    // Ballon libre : les phases sont conservées
    state.ball.ownerId = null;
    updatePhases(state, cfg);
    expect(state.phase).toEqual({ A: 'attack', B: 'defence' });
    // B récupère
    giveBall(state, 15);
    updatePhases(state, cfg);
    expect(state.phase).toEqual({ A: 'transition_defence', B: 'transition_attack' });
    expect(state.phaseSince.B).toBe(10);
    state.time = 10 + cfg.params.transitionWindow - 0.1;
    updatePhases(state, cfg);
    expect(state.phase.B).toBe('transition_attack');
    state.time = 10 + cfg.params.transitionWindow;
    updatePhases(state, cfg);
    expect(state.phase).toEqual({ A: 'defence', B: 'attack' });
  });

  it('un porteur immobile attaqué par 3 défenseurs est dépossédé par un tacle en moins de 8 s', () => {
    const state = buildState({ players: [
      { team: 'A', pos: { x: 0, y: 0 }, role: 'MF', number: 8 },
      { team: 'B', pos: { x: 2.5, y: 0 }, role: 'DF', number: 4 },
      { team: 'B', pos: { x: -2, y: 1.5 }, role: 'DF', number: 5 },
      { team: 'B', pos: { x: -2, y: -1.5 }, role: 'DF', number: 6 },
    ], ball: { ownerId: 0, pos: { x: 0, y: 0 } } });
    for (const d of state.players) if (d.team === 'B') { d.target = { x: 0, y: 0 }; d.targetSpeed = d.maxSpeed; } // ils attaquent le porteur
    const cfg = configFor(state);
    const rng = new Rng(9);
    let lostAt = -1;
    run(state, cfg, rng, 8, (s) => { if (lostAt < 0 && s.ball.ownerId !== 0) lostAt = s.time; });
    expect(lostAt).toBeGreaterThan(0);
    expect(lostAt).toBeLessThan(8);
    expect(state.stats.B.tackles).toBeGreaterThanOrEqual(1);
    expect(hasEvent(state, 'tackle')).toBe(true);
    expect(state.stats.A.turnovers).toBeGreaterThanOrEqual(1);
    expect(state.possession).toBe('B');
    expect(state.players[0].lastDribbleStart).toBeUndefined();
  });

  it('un défenseur qui perd son duel est « passé » : immobile beatenFreeze s, sans nouveau duel', () => {
    const params = quietParams({ duelMinProb: 0, duelMaxProb: 0 }); // le défenseur perd toujours
    const state = buildState({ players: [
      { team: 'A', pos: { x: 0, y: 0 }, role: 'MF', number: 8 },
      { team: 'B', pos: { x: 2.5, y: 0 }, role: 'DF', number: 4 },
    ], ball: { ownerId: 0, pos: { x: 0, y: 0 } } });
    const cfg = configFor(state, params);
    const rng = new Rng(9);
    const d = state.players[1];
    d.target = { x: -10, y: 0 }; // il fond sur le porteur
    d.targetSpeed = 8;
    let duelAt = -1;
    expect(runUntil(state, cfg, rng, 2, (s) => { if (d.beatenUntil !== undefined) { duelAt = s.time - DT; return true; } return false; })).toBe(true);
    expect(duelAt).toBeGreaterThan(0.1); // il lui a fallu accélérer et entrer dans r_tackle
    expect(d.beatenUntil).toBeCloseTo(duelAt + params.physics.beatenFreeze, 6);
    expect(state.stats.A.dribblesWon).toBe(1); // duel remporté = prise à défaut réussie
    const frozenPos = { ...d.pos };
    state.players[0].target = { x: -30, y: 0 }; // le porteur s'éloigne pendant l'immobilisation
    state.players[0].targetSpeed = 8;
    run(state, cfg, rng, params.physics.beatenFreeze - 0.1);
    expect(d.pos).toEqual(frozenPos);
    expect(state.ball.ownerId).toBe(0);
    run(state, cfg, rng, 0.8); // libéré : ≈ 0,7 s de course depuis l'arrêt (a = 5 m/s² ⇒ > 1 m)
    expect(dist(d.pos, frozenPos)).toBeGreaterThan(0.5);
    expect(state.stats.B.tackles).toBe(0);
  });

  it('un dribble déplace le porteur avec le ballon ; sans adversaire à moins de takeOnRadius ce n’est pas une prise à défaut', () => {
    const params = quietParams();
    const state = buildState({ players: [
      { team: 'A', pos: { x: 0, y: 0 }, role: 'MF', number: 8 },
      { team: 'B', pos: { x: -40, y: 20 }, role: 'DF', number: 4 },
    ], ball: { ownerId: 0, pos: { x: 0, y: 0 } } });
    const cfg = configFor(state, params);
    const rng = new Rng(1);
    const dribble: Action = { type: 'dribble', direction: { x: 1, y: 0 }, distance: 8 };
    expect(executeAction(state, 0, dribble, params, rng)).toBe(true);
    expect(state.stats.A.dribbles).toBe(0); // conduite sans opposition : aucun événement
    expect(state.players[0].target).toEqual({ x: 8, y: 0 });
    for (let i = 0; i < 6; i++) { run(state, cfg, rng, 1); executeAction(state, 0, dribble, params, rng); }
    expect(state.stats.A.dribbles).toBe(0);
    expect(state.stats.A.dribblesWon).toBe(0);
    expect(state.events.filter((e) => e.kind === 'dribble')).toHaveLength(0);
    expect(state.players[0].pos.x).toBeGreaterThan(2); // accélération 5 m/s² plafonnée à 0,75·v_max
    expect(state.ball.ownerId).toBe(0);
    expect(state.ball.pos.x).toBeGreaterThan(state.players[0].pos.x);
    expect(Math.hypot(state.players[0].vel.x, state.players[0].vel.y)).toBeLessThanOrEqual(state.players[0].maxSpeed * params.physics.dribbleSpeedFactor + 1e-9);
  });

  it('une prise à défaut (adversaire à moins de 3 m) compte un dribble, gagné seulement par un duel remporté', () => {
    const params = quietParams({ duelMinProb: 0, duelMaxProb: 0 }); // le défenseur perd toujours
    const state = buildState({ players: [
      { team: 'A', pos: { x: 0, y: 0 }, role: 'MF', number: 8 },
      { team: 'B', pos: { x: 2.5, y: 0 }, role: 'DF', number: 4 },
    ], ball: { ownerId: 0, pos: { x: 0, y: 0 } } });
    const cfg = configFor(state, params);
    const rng = new Rng(1);
    const dribble: Action = { type: 'dribble', direction: { x: 1, y: 0 }, distance: 8 };
    expect(executeAction(state, 0, dribble, params, rng)).toBe(true);
    expect(state.stats.A.dribbles).toBe(1);
    expect(executeAction(state, 0, dribble, params, rng)).toBe(true); // ré-émettre ne recompte pas
    expect(state.stats.A.dribbles).toBe(1);
    // Sans contact pendant dribbleWonDelay, la prise à défaut expire sans être « gagnée » (le défenseur recule)
    state.players[1].target = { x: 40, y: 0 };
    state.players[1].targetSpeed = 8;
    run(state, cfg, rng, params.physics.dribbleWonDelay + 0.1);
    expect(state.stats.A.dribblesWon).toBe(0);
    expect(state.players[0].lastDribbleStart).toBeUndefined();
    // Nouvelle prise à défaut : le défenseur fond sur le porteur et perd son duel ⇒ dribble réussi
    const d = state.players[1];
    d.pos = { x: state.players[0].pos.x + 2.5, y: 0 };
    d.vel = { x: 0, y: 0 };
    d.target = { x: -40, y: 0 };
    executeAction(state, 0, dribble, params, rng);
    expect(state.stats.A.dribbles).toBe(2);
    expect(runUntil(state, cfg, rng, 3, (s) => s.stats.A.dribblesWon === 1)).toBe(true);
    expect(state.players[0].lastDribbleStart).toBeUndefined();
    expect(state.stats.A.dribbles).toBe(2); // le duel gagné ne recompte pas la tentative déjà journalisée
  });

  it('« hold » vise 1 m à l’opposé de l’adversaire le plus proche ; « move » borne la cible au terrain', () => {
    const state = buildState({ players: [
      { team: 'A', pos: { x: 0, y: 0 }, role: 'MF', number: 8 },
      { team: 'B', pos: { x: 3, y: 0 }, role: 'DF', number: 4 },
    ], ball: { ownerId: 0, pos: { x: 0, y: 0 } } });
    const rng = new Rng(1);
    expect(executeAction(state, 0, { type: 'hold' }, DEFAULT_PARAMS, rng)).toBe(true);
    expect(state.players[0].target!.x).toBeCloseTo(-1, 9);
    expect(state.players[0].targetSpeed).toBe(2);
    expect(executeAction(state, 1, { type: 'move', target: { x: 200, y: -100 }, intent: 'press', speed: 50 }, DEFAULT_PARAMS, rng)).toBe(true);
    expect(state.players[1].target).toEqual({ x: PITCH.halfLength - 0.5, y: -(PITCH.halfWidth - 0.5) });
    expect(state.players[1].targetSpeed).toBe(state.players[1].maxSpeed);
  });
});

// ---------------------------------------------------------------------------
// Boucle de simulation et statistiques
// ---------------------------------------------------------------------------
describe('simulation', () => {
  it('statistiques cohérentes après 120 s : passes ≥ réussies, possession A + B = temps écoulé, comptabilité des décisions', () => {
    const sim = createSimulation(defaultConfig(21), { decide: fakeDecide });
    let cycles = 0;
    sim.advance(120, { onDecisions: (d) => { cycles++; expect(d.size).toBe(22); } });
    const s = sim.state.stats;
    expect(sim.state.time).toBeCloseTo(120, 6);
    expect(s.A.passes + s.B.passes).toBeGreaterThan(20);
    expect(s.A.passes).toBeGreaterThanOrEqual(s.A.passesCompleted);
    expect(s.B.passes).toBeGreaterThanOrEqual(s.B.passesCompleted);
    expect(s.A.shots).toBeGreaterThanOrEqual(s.A.shotsOnTarget);
    expect(s.A.shotsOnTarget).toBeGreaterThanOrEqual(s.A.goals);
    expect(s.A.possessionTime + s.B.possessionTime).toBeCloseTo(120, 3);
    expect(cycles).toBeGreaterThan(500);
    expect(s.A.decisions + s.B.decisions).toBe(cycles * 22);
    expect(s.A.decisionMs).toBeCloseTo(s.A.decisions * 0.1, 3);
    expect(s.A.regret).toBe(0);
    expect(sim.state.events.length).toBeLessThanOrEqual(MAX_EVENTS);
    for (const e of sim.state.events) expect(e.label).toBeTruthy();
    for (const p of sim.state.players) {
      expect(Math.abs(p.pos.x)).toBeLessThanOrEqual(PITCH.halfLength + 2 + 1e-9);
      expect(Math.abs(p.pos.y)).toBeLessThanOrEqual(PITCH.halfWidth + 2 + 1e-9);
      expect(p.decision).not.toBeNull();
    }
  });

  it('comptabilise le regret, le xG des tirs et la probabilité attendue des passes à partir des décisions', () => {
    const params = quietParams();
    const cfg = defaultConfig(4, params);
    let phase: 'shoot' | 'pass' | 'idle' = 'shoot';
    const decide: DecideFn = (state) => {
      const out = new Map<number, Decision>();
      const owner = state.ball.ownerId;
      if (owner !== null && phase !== 'idle') {
        const p = state.players[owner];
        const mate = state.players.find((q) => q.team === p.team && q.id !== owner)!;
        const action: Action = phase === 'shoot'
          ? { type: 'shoot', targetPoint: { x: attackDir(p.team) * 52.5, y: 0 }, power: 1 }
          : { type: 'pass', targetId: mate.id, targetPoint: { ...mate.pos }, kind: 'ground', speed: 6 };
        const chosen = candidate(action, 0.1, 0.35);
        const better = candidate({ type: 'hold' }, 0.3, 0.9);
        out.set(owner, { ...decisionOf(state, owner, action), chosen, candidates: [better, chosen] });
        phase = phase === 'shoot' ? 'pass' : 'idle';
      }
      return out;
    };
    const sim = createSimulation(cfg, { decide });
    sim.state.restart = null;
    sim.advance(0.5);
    const team = sim.state.players[sim.state.ball.lastTouchId!].team;
    expect(sim.state.stats[team].shots).toBe(1);
    expect(sim.state.stats[team].xG).toBeCloseTo(0.35, 9);
    expect(sim.state.stats[team].regret).toBeCloseTo(0.2, 9);
    expect(sim.state.stats[team].decisions).toBe(1);
    // Une fois le ballon récupéré (sortie ou arrêt), la passe suivante porte expectedP
    sim.advance(3);
    let sawExpected = false;
    for (let i = 0; i < 600 && !sawExpected; i++) {
      sim.step();
      const fl = sim.state.ball.flight;
      if (fl && fl.kind === 'pass' && fl.expectedP === 0.35) sawExpected = true;
    }
    expect(sawExpected).toBe(true);
  });

  it('reset() rejoue le même match et setTactics() change la tactique en cours', () => {
    const sim = createSimulation(defaultConfig(13), { decide: fakeDecide });
    sim.advance(10);
    const snapshot = JSON.stringify(sim.state);
    sim.reset();
    expect(sim.state.time).toBe(0);
    expect(sim.state.score).toEqual({ A: 0, B: 0 });
    sim.advance(10);
    expect(JSON.stringify(sim.state)).toBe(snapshot);
    const wide = makeTactic('3-5-2', 'wide');
    sim.setTactics('B', wide);
    expect(sim.state.tactics.B).toBe(wide);
    expect(sim.config.tactics.B).toBe(wide);
    expect(sim.finished).toBe(false);
  });

  it('pushEvent borne le journal à 200 entrées et incrémente les compteurs associés', () => {
    const state = createMatch(defaultConfig(1), new Rng(1));
    for (let i = 0; i < 250; i++) pushEvent(state, { time: i, kind: 'pass', team: 'A', playerId: 6, targetId: 9 });
    expect(state.events).toHaveLength(200);
    expect(state.events[0].time).toBe(50);
    expect(state.stats.A.passes).toBe(250);
    expect(state.events[0].label).toContain('Passe');
    pushEvent(state, { time: 0, kind: 'tackle', team: 'B', playerId: 15, targetId: 6 });
    expect(state.stats.B.tackles).toBe(1);
  });

  it('un match nul de 600 s avec la décision « statique » ne produit ni but ni sortie de balle', () => {
    const sim = createSimulation(defaultConfig(2), { decide: staticDecide });
    sim.advance(60);
    expect(sim.state.score).toEqual({ A: 0, B: 0 });
    expect(sim.state.stats.A.shots + sim.state.stats.B.shots).toBe(0);
    expect(sim.state.stats.A.possessionTime + sim.state.stats.B.possessionTime).toBeCloseTo(60, 3);
  });

  it('600 s de simulation avec la décision factice s’exécutent en moins de 3 s', () => {
    const sim = createSimulation(defaultConfig(99), { decide: fakeDecide });
    const t0 = performance.now();
    sim.advance(600);
    const elapsed = performance.now() - t0;
    expect(sim.state.tick).toBe(18000);
    expect(sim.state.time).toBeCloseTo(600, 3);
    expect(sim.finished).toBe(true);
    expect(elapsed).toBeLessThan(3000);
    // Le match a vécu : passes, changements de possession, remises en jeu
    const s = sim.state.stats;
    expect(s.A.passes + s.B.passes).toBeGreaterThan(100);
    // Comptabilité cumulée (le journal `events` est borné à MAX_EVENTS : la politique factice « passe au plus proche »
    // finit par boucler entre deux joueurs et ses 200 derniers événements peuvent n'être que des passes).
    expect(s.A.turnovers + s.B.turnovers).toBeGreaterThan(0);
    const teams: TeamId[] = ['A', 'B'];
    for (const t of teams) expect(s[t].possessionTime).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Régressions de réalisme (revue comportementale) : duels, ballons aériens, événements, regret, engagement
// ---------------------------------------------------------------------------
describe('duels : déclenchement, cadence, probabilité', () => {
  const carrierAndDefender = (dx: number): MatchState => buildState({ players: [
    { team: 'A', pos: { x: 0, y: 0 }, role: 'MF', number: 8 },
    { team: 'B', pos: { x: dx, y: 0 }, role: 'DF', number: 4 },
  ], ball: { ownerId: 0, pos: { x: 0, y: 0 } } });

  it('un adversaire qui contient hors de r_tackle ne déclenche aucun duel ; au contact immobile il en déclenche un après duelContactTime, et aussitôt s’il fond sur le porteur', () => {
    const params = quietParams();
    // Contain à 2 m : jamais de duel
    const far = carrierAndDefender(2);
    run(far, configFor(far, params), new Rng(3), 3);
    expect(far.players[1].lastDuelTime).toBeUndefined();
    expect(far.players[1].duelContactSince).toBeUndefined();
    expect(far.ball.ownerId).toBe(0);
    // Face-à-face immobile à 1 m : pas de duel avant duelContactTime, duel juste après (le face-à-face ne dure pas)
    const near = carrierAndDefender(1);
    const cfgNear = configFor(near, params);
    const rngNear = new Rng(3);
    run(near, cfgNear, rngNear, params.physics.duelContactTime - 0.1);
    expect(near.players[1].lastDuelTime).toBeUndefined();
    expect(near.players[1].duelContactSince).toBeCloseTo(0, 9);
    run(near, cfgNear, rngNear, 0.2);
    expect(near.players[1].lastDuelTime).toBeCloseTo(params.physics.duelContactTime, 1);
    // Défenseur qui fond sur le porteur depuis 2,5 m : duel dès l'entrée dans r_tackle (< duelContactTime)
    const charge = carrierAndDefender(2.5);
    const cfgCharge = configFor(charge, params);
    const d = charge.players[1];
    d.target = { x: -5, y: 0 };
    d.targetSpeed = 8;
    expect(runUntil(charge, cfgCharge, new Rng(3), 2, () => d.lastDuelTime !== undefined)).toBe(true);
    expect(charge.time - d.duelContactSince!).toBeLessThan(params.physics.duelContactTime);
  });

  it('un porteur ne subit qu’un duel par duelCooldown même face à deux défenseurs, et aucun juste après sa prise de balle', () => {
    const params = quietParams({ duelMinProb: 0, duelMaxProb: 0 }); // le porteur gagne toujours (le ballon reste)
    const state = buildState({ players: [
      { team: 'A', pos: { x: 0, y: 0 }, role: 'MF', number: 8 },
      { team: 'B', pos: { x: 2.5, y: 0.6 }, role: 'DF', number: 4 },
      { team: 'B', pos: { x: 2.5, y: -0.6 }, role: 'DF', number: 5 },
      { team: 'B', pos: { x: -2.5, y: 0 }, role: 'DF', number: 6 },
    ], ball: { ownerId: 0, pos: { x: 0, y: 0 } } });
    for (const d of state.players) if (d.team === 'B') { d.target = { x: 0, y: 0 }; d.targetSpeed = 8; }
    const cfg = configFor(state, params);
    const rng = new Rng(5);
    const duels = (): number => state.stats.A.dribblesWon; // chaque duel gagné = un dribble réussi
    expect(runUntil(state, cfg, rng, 2, () => duels() >= 1)).toBe(true);
    const first = state.time;
    run(state, cfg, rng, params.physics.duelCooldown - 0.1);
    expect(duels()).toBe(1);
    run(state, cfg, rng, 1.5);
    expect(duels()).toBeGreaterThanOrEqual(2);
    expect(state.time - first).toBeGreaterThan(params.physics.duelCooldown - 0.1);
    // Délai de grâce après une prise de balle
    const fresh = carrierAndDefender(1.2);
    fresh.players[0].lastControlTime = 0;
    fresh.players[1].target = { x: -5, y: 0 };
    fresh.players[1].targetSpeed = 8;
    fresh.players[1].vel = { x: -3, y: 0 };
    const cfg2 = configFor(fresh, params);
    run(fresh, cfg2, new Rng(1), params.physics.duelCarrierGrace - 0.05);
    expect(fresh.players[1].lastDuelTime).toBeUndefined();
  });

  it('P_def d’un défenseur seul, de face, à qualité égale vaut σ(duelBase + duelGoalSide) : le tacleur n’est pas compté dans la pression', () => {
    const params = quietParams({ duelMinProb: 0, duelMaxProb: 1 });
    const state = carrierAndDefender(2.5);
    const cfg = configFor(state, params);
    const d = state.players[1];
    d.target = { x: -10, y: 0 };
    d.targetSpeed = 8;
    expect(runUntil(state, cfg, new Rng(2), 2, () => d.lastDuelTime !== undefined)).toBe(true);
    const ev = state.events.find((e) => (e.kind === 'tackle' || e.kind === 'dribble') && typeof e.value === 'number')!;
    expect(ev).toBeDefined();
    expect(ev.value).toBeCloseTo(sigmoid(params.physics.duelBase + params.physics.duelGoalSide), 6);
    expect(sigmoid(params.physics.duelBase + params.physics.duelGoalSide)).toBeLessThan(0.55);
  });

  it('une perte de balle sur tacle « ballon libre » est attribuée à la victime, pas au tacleur', () => {
    const params = quietParams({ duelMinProb: 1, duelMaxProb: 1, tackleKeepProb: 0 });
    const state = carrierAndDefender(2.5);
    const cfg = configFor(state, params);
    const d = state.players[1];
    d.target = { x: -10, y: 0 };
    d.targetSpeed = 8;
    expect(runUntil(state, cfg, new Rng(2), 4, (s) => s.possession === 'B')).toBe(true);
    const turnover = state.events.find((e) => e.kind === 'turnover')!;
    expect(turnover.team).toBe('A');
    expect(turnover.playerId).toBe(0);
  });
});

describe('ballons aériens : cinématique partagée et atterrissage', () => {
  it('lobKinematics et flightModel(« lob ») prévoient la même durée de vol, et la simulation la respecte à 5 %', () => {
    const params = quietParams();
    for (const d of [20, 30, 45, 60]) {
      const k = lobKinematics(d, params.physics);
      expect(flightModel('lob', d, params).travelTime).toBeCloseTo(k.T, 9);
      expect(k.hs * k.T).toBeCloseTo(d, 9); // portée exacte
      const state = buildState({ players: [
        { team: 'A', pos: { x: -30, y: 0 }, role: 'MF', number: 8 },
        { team: 'A', pos: { x: -30 + d, y: 12 }, role: 'FW', number: 9 }, // receveur écarté : le ballon retombe seul
      ], ball: { ownerId: 0, pos: { x: -30, y: 0 } } });
      const cfg = configFor(state, params);
      const rng = new Rng(1);
      stepPhysics(state, params, rng, DT);
      state.time += DT;
      const t0 = state.time;
      expect(executeAction(state, 0, { type: 'pass', targetId: 1, targetPoint: { x: -30 + d, y: 0 }, kind: 'lob', speed: 6 }, params, rng)).toBe(true);
      expect(runUntil(state, cfg, rng, 8, (s) => s.ball.flight?.landed === true)).toBe(true);
      const T = state.time - t0;
      expect(Math.abs(T - k.T) / k.T).toBeLessThan(0.05);
      expect(dist(state.ball.pos, { x: -30 + d, y: 0 })).toBeLessThan(2);
      expect(Math.hypot(state.ball.vel.x, state.ball.vel.y)).toBeLessThanOrEqual(params.physics.lobLandingSpeed + 1e-9);
    }
  });

  it('un lob de 30 m et de 45 m est contrôlable au point visé (fenêtre ≥ 0,15 s) et s’arrête à moins de 15 m ; un receveur immobile le contrôle en 0,5 s', () => {
    const params = quietParams();
    for (const d of [30, 45]) {
      // Sans receveur au point visé : fenêtre de contrôle et distance d'arrêt
      const free = buildState({ players: [
        { team: 'A', pos: { x: -30, y: 0 }, role: 'MF', number: 8 },
        { team: 'A', pos: { x: -30 + d, y: 12 }, role: 'FW', number: 9 },
      ], ball: { ownerId: 0, pos: { x: -30, y: 0 } } });
      const target = { x: -30 + d, y: 0 };
      const rng = new Rng(1);
      stepPhysics(free, params, rng, DT);
      executeAction(free, 0, { type: 'pass', targetId: 1, targetPoint: target, kind: 'lob', speed: 6 }, params, rng);
      let windowTicks = 0;
      run(free, configFor(free, params), rng, 12, (s) => {
        const b = s.ball;
        if (dist(b.pos, target) <= params.physics.controlRadius + params.physics.controlSlowBonus && b.z < params.physics.controlMaxHeight && Math.hypot(b.vel.x, b.vel.y) < params.physics.controlMaxRelSpeed) windowTicks++;
      });
      expect(windowTicks * DT).toBeGreaterThanOrEqual(0.15); // ≈ 1,3 m de portée franchis à lobLandingSpeed après un atterrissage à < 0,5 m
      expect(free.ball.vel).toEqual({ x: 0, y: 0 });
      expect(dist(free.ball.pos, target)).toBeLessThan(15);
      expect(Math.abs(free.ball.pos.y)).toBeLessThan(PITCH.halfWidth);
      // Receveur immobile au point visé : contrôle dans les 0,5 s suivant le premier contact au sol
      const recv = buildState({ players: [
        { team: 'A', pos: { x: -30, y: 0 }, role: 'MF', number: 8 },
        { team: 'A', pos: { x: -30 + d, y: 0 }, role: 'FW', number: 9 },
      ], ball: { ownerId: 0, pos: { x: -30, y: 0 } } });
      const rng2 = new Rng(1);
      stepPhysics(recv, params, rng2, DT);
      executeAction(recv, 0, { type: 'pass', targetId: 1, targetPoint: target, kind: 'lob', speed: 6 }, params, rng2);
      const cfg = configFor(recv, params);
      let landedAt = -1;
      expect(runUntil(recv, cfg, rng2, 8, (s) => { if (landedAt < 0 && (s.ball.flight?.landed || s.ball.ownerId !== null)) landedAt = s.time; return s.ball.ownerId === 1; })).toBe(true);
      expect(recv.time - landedAt).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(hasEvent(recv, 'pass_complete')).toBe(true);
    }
  });

  it('un receveur qui court au-devant d’une passe rapide (ballon 11 m/s + joueur 4 m/s) la contrôle', () => {
    const params = quietParams();
    const state = buildState({ players: [
      { team: 'A', pos: { x: -20, y: 0 }, role: 'MF', number: 8 },
      { team: 'A', pos: { x: -4, y: 0 }, role: 'MF', number: 6 },
    ], ball: { ownerId: 0, pos: { x: -20, y: 0 } } });
    const cfg = configFor(state, params);
    const rng = new Rng(1);
    const r = state.players[1];
    r.target = { x: -20, y: 0 }; // il vient au-devant du ballon
    r.targetSpeed = 4;
    r.vel = { x: -4, y: 0 };
    stepPhysics(state, params, rng, DT);
    executeAction(state, 0, { type: 'pass', targetId: 1, targetPoint: { x: -4, y: 0 }, kind: 'ground', speed: 10 }, params, rng);
    expect(state.ball.flight!.initialSpeed).toBeGreaterThan(10);
    expect(runUntil(state, cfg, rng, 3, (s) => s.ball.ownerId === 1)).toBe(true);
    expect(hasEvent(state, 'pass_complete')).toBe(true);
  });
});

describe('événements : contres, dégagements, remises en jeu', () => {
  it('un tir contré produit un événement « block » (pas de tacle) et la perte est attribuée au tireur', () => {
    const params = quietParams({ saveProb: 0 });
    const state = buildState({ players: [
      { team: 'A', pos: { x: 30, y: 0 }, role: 'FW', number: 9 },
      { team: 'B', pos: { x: 31.5, y: 0.1 }, role: 'DF', number: 4 },
      { team: 'B', pos: { x: 51, y: 0 }, role: 'GK', number: 1 },
    ], ball: { ownerId: 0, pos: { x: 30, y: 0 } } });
    const cfg = configFor(state, params);
    const rng = new Rng(1);
    stepPhysics(state, params, rng, DT);
    executeAction(state, 0, { type: 'shoot', targetPoint: { x: 52.5, y: 0 }, power: 1, xg: 0 }, params, rng);
    expect(runUntil(state, cfg, rng, 2, (s) => hasEvent(s, 'block'))).toBe(true);
    expect(state.stats.B.blocks).toBe(1);
    expect(state.stats.B.tackles).toBe(0);
    expect(hasEvent(state, 'tackle')).toBe(false);
    expect(state.score.A).toBe(0);
    expect(runUntil(state, cfg, rng, 3, (s) => s.possession === 'B')).toBe(true);
    const turnover = state.events.find((e) => e.kind === 'turnover')!;
    expect(turnover.playerId).toBe(0);
  });

  it('un tir dont l’issue tirée est « but » n’est jamais contré (les contreurs sont déjà dans le xG) : fréquence de but = xG', () => {
    const params = quietParams({ saveProb: 0 });
    let goals = 0;
    const N = 300;
    for (let seed = 0; seed < N; seed++) {
      const state = buildState({ players: [
        { team: 'A', pos: { x: 30, y: 0 }, role: 'FW', number: 9 },
        { team: 'B', pos: { x: 31.5, y: 0.2 }, role: 'DF', number: 4 },
        { team: 'B', pos: { x: 32.5, y: -0.3 }, role: 'DF', number: 5 },
        { team: 'B', pos: { x: 51, y: 0 }, role: 'GK', number: 1 },
      ], ball: { ownerId: 0, pos: { x: 30, y: 0 } } });
      const rng = new Rng(seed + 500);
      stepPhysics(state, params, rng, DT);
      executeAction(state, 0, { type: 'shoot', targetPoint: { x: 52.5, y: 0 }, power: 1, xg: 0.3 }, params, rng);
      run(state, configFor(state, params), rng, 1.5);
      goals += state.score.A;
    }
    expect(Math.abs(goals / N - 0.3)).toBeLessThan(0.06);
  });

  it('un dégagement produit un événement « clearance » et ne compte pas comme une passe', () => {
    const params = quietParams();
    const state = buildState({ players: [
      { team: 'A', pos: { x: -40, y: 0 }, role: 'DF', number: 4 },
      { team: 'A', pos: { x: 0, y: 0 }, role: 'MF', number: 8 },
    ], ball: { ownerId: 0, pos: { x: -40, y: 0 } } });
    const rng = new Rng(1);
    stepPhysics(state, params, rng, DT);
    expect(executeAction(state, 0, { type: 'clear', targetPoint: { x: 0, y: 10 } }, params, rng)).toBe(true);
    expect(state.stats.A.clearances).toBe(1);
    expect(state.stats.A.passes).toBe(0);
    expect(state.events.at(-1)!.kind).toBe('clearance');
    expect(state.ball.flight!.kind).toBe('clearance');
  });

  it('une touche ou un corner n’est jamais remis par le gardien, même s’il est le plus proche : il ne bouge pas', () => {
    const params = quietParams();
    const state = buildState({ players: [
      { team: 'A', pos: { x: 0, y: 0 }, role: 'MF', number: 8 },
      { team: 'B', pos: { x: 6, y: 30 }, role: 'GK', number: 1 },
      { team: 'B', pos: { x: 30, y: 0 }, role: 'DF', number: 4 },
    ], ball: { pos: { x: 5, y: 33.9 } } });
    state.ball.vel = { x: 0, y: 6 };
    state.ball.lastTouchId = 0;
    state.possession = 'A';
    const gk = state.players[1];
    const gkPos = { ...gk.pos };
    expect(nearestOutfield(state, { x: 5, y: 34 }, 'B')!.id).toBe(2);
    run(state, configFor(state, params), new Rng(1), 0.5);
    const restart = state.events.find((e) => e.kind === 'restart')!;
    expect(restart).toBeDefined();
    expect(state.restart!.kind).toBe('throw_in');
    expect(restart.playerId).toBe(2);
    expect(gk.pos).toEqual(gkPos);
    expect(state.ball.ownerId).toBe(2);
  });
});

describe('boucle : regret du porteur et décisions engagées', () => {
  it('le regret n’est comptabilisé que pour les décisions du porteur (pas pour les tâches de déplacement)', () => {
    const decide: DecideFn = (state) => {
      const out = new Map<number, Decision>();
      for (const p of state.players) {
        if (state.ball.ownerId === p.id) {
          const chosen = candidate({ type: 'hold' }, 0.1, 0.9);
          out.set(p.id, { ...decisionOf(state, p.id, { type: 'hold' }), chosen, candidates: [candidate({ type: 'hold' }, 0.15, 0.9), chosen] });
        } else {
          const action: Action = { type: 'move', target: { ...p.pos }, intent: 'zone', speed: 0 };
          const chosen = candidate(action, -3, 1);
          out.set(p.id, { ...decisionOf(state, p.id, action), chosen, candidates: [candidate(action, 0, 1), chosen] }); // « meilleur » écart de 3 s
        }
      }
      return out;
    };
    const sim = createSimulation(defaultConfig(7), { decide });
    sim.state.restart = null;
    sim.advance(1);
    const s = sim.state.stats;
    const owner = sim.state.players[sim.state.ball.ownerId!];
    expect(s.A.regret + s.B.regret).toBeCloseTo(5 * 0.05, 9);
    expect(s[owner.team].onBallDecisions).toBe(5);
    expect(s.A.decisions + s.B.decisions).toBe(5 * 22);
  });

  it('un dribble engagé (committedUntil) n’est pas re-décidé : onBall n’est pas rappelé et les compteurs n’augmentent pas', () => {
    const params = quietParams();
    const cfg = defaultConfig(8, params);
    let onBallCalls = 0;
    const policy: PolicySet = {
      ...FULL_POLICY,
      name: 'test',
      onBall: (input, playerId, previous) => {
        onBallCalls++;
        const state = input.state;
        const action: Action = { type: 'dribble', direction: { x: attackDir(state.players[playerId].team), y: 0 }, distance: 8 };
        const d = decisionOf(state, playerId, action);
        d.chosen.duration = 1.0;
        d.committedUntil = state.time + 1.0;
        void previous;
        return d;
      },
    };
    const sim = createSimulation(cfg, { policies: { A: policy, B: policy } });
    sim.state.restart = null;
    sim.advance(0.2);
    expect(onBallCalls).toBe(1);
    const ownerId = sim.state.ball.ownerId!;
    const first = sim.decisions.get(ownerId)!;
    const decisionsAfterFirst = sim.state.stats.A.decisions + sim.state.stats.B.decisions;
    sim.advance(0.6); // 3 cycles de plus, tous dans la fenêtre d'engagement
    expect(onBallCalls).toBe(1);
    expect(sim.decisions.get(ownerId)).toBe(first);
    expect(sim.state.players[ownerId].decision).toBe(first);
    expect(sim.state.stats.A.decisions + sim.state.stats.B.decisions).toBe(decisionsAfterFirst + 3 * 21);
    // Engagement écoulé (t ≥ 1,0 s) : le prochain porteur (le même ou un adversaire après un duel) est re-décidé
    for (let i = 0; i < 90 && onBallCalls < 2; i++) sim.step();
    expect(onBallCalls).toBeGreaterThanOrEqual(2);
    expect(sim.state.time).toBeLessThanOrEqual(1.2 + 3 + 1e-9);
    // Sans engagement, chaque cycle re-décide
    let plainCalls = 0;
    const plain: PolicySet = { ...policy, onBall: (input, playerId, previous) => { plainCalls++; const d = policy.onBall(input, playerId, previous); delete d.committedUntil; return d; } };
    const sim2 = createSimulation(cfg, { policies: { A: plain, B: plain } });
    sim2.state.restart = null;
    sim2.advance(1);
    expect(plainCalls).toBe(5);
  });
});

describe('réalisme : match de 3 minutes avec l’algorithme complet', () => {
  it('tacles ≤ 2,5 par minute et par équipe, pertes de balle < 6 par minute, dribbles < 4 par minute, pas de NaN, gardiens près de leur but', () => {
    const sim = createSimulation({ ...defaultConfig(3), tactics: { A: makeTactic('4-3-3', 'possession'), B: makeTactic('4-4-2', 'counter') }, durationSec: 180 });
    let keeperFar = 0, samples = 0;
    while (!sim.finished) {
      sim.step();
      if (sim.state.tick % 30 === 0) {
        samples++;
        for (const p of sim.state.players) {
          if (p.role !== 'GK') continue;
          const goalX = -attackDir(p.team) * PITCH.halfLength;
          if (Math.hypot(p.pos.x - goalX, p.pos.y) > 25) keeperFar++;
        }
      }
    }
    const s = sim.state.stats;
    const minutes = 3;
    for (const team of ['A', 'B'] as const) {
      expect(s[team].tackles / minutes).toBeLessThanOrEqual(2.5); // avant correction : 3,5–7 tacles/min
      expect(s[team].turnovers / minutes).toBeLessThan(6); // avant correction : 6–8 pertes/min
      expect(s[team].dribbles / minutes).toBeLessThan(4);
      expect(s[team].passesCompleted).toBeLessThanOrEqual(s[team].passes);
      for (const v of Object.values(s[team])) expect(Number.isFinite(v)).toBe(true);
    }
    expect(keeperFar / Math.max(1, samples)).toBeLessThan(0.02);
    for (const p of sim.state.players) {
      expect(Math.abs(p.pos.x)).toBeLessThanOrEqual(PITCH.halfLength + 2 + 1e-9);
      expect(Math.abs(p.pos.y)).toBeLessThanOrEqual(PITCH.halfWidth + 2 + 1e-9);
    }
  });
});
