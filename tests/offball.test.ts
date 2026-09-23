/**
 * Tests du déplacement sans ballon (src/decision/offball.ts, docs/CONCEPTION.md §7) : invariant de dispersion,
 * modulation tactique (largeur, tempo, contre-attaque), appels en profondeur, hors-jeu, défenseurs de repos,
 * hystérésis, réception, symétrie miroir A/B, décomposition additive, probabilité de passe rapide.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_PARAMS } from '@/core/params';
import { Rng } from '@/core/rng';
import { buildState, type PlayerSpec } from '@/core/state-builder';
import { PITCH, isInsidePitch } from '@/core/pitch';
import type { Decision, MatchState, TeamId } from '@/core/types';
import { attackDir } from '@/core/types';
import type { Vec2 } from '@/core/vec2';
import { dist } from '@/core/vec2';
import { FORMATIONS } from '@/tactics/formations';
import { makeTactic } from '@/tactics/styles';
import { computeFields } from '@/models/fields';
import { passProbability } from '@/models/probability';
import { offsideLine } from '@/models/structure';
import { createMatch, giveBall, slotPosition } from '@/engine/match';
import { decideOffBall, decideReceive, deepRunPoints, isRestDefender, quickPassProbability } from '@/decision/offball';
import { decideAll, FULL_POLICY } from '@/decision/coordinator';
import type { DecisionInput, PolicySet } from '@/decision/policy';

const P = DEFAULT_PARAMS;
const v = (x: number, y: number): Vec2 => ({ x, y });
const mirror = (p: Vec2): Vec2 => ({ x: -p.x, y: -p.y });

/** Politique complète dont le porteur est protégé : si decideOnBall n'est pas disponible, conservation. */
const GUARDED: PolicySet = {
  ...FULL_POLICY,
  onBall: (input, id, prev) => {
    try { return FULL_POLICY.onBall(input, id, prev); } catch (e) {
      if (!(e instanceof Error) || !/non implémenté/.test(e.message)) throw e;
      const c = { action: { type: 'hold' as const }, score: 0, probability: 1, valueIfSuccess: 0, valueIfFailure: 0, components: [], reason: 'conservation (porteur indisponible)' };
      return { playerId: id, time: input.state.time, chosen: c, candidates: [c], context: { phase: 'attack', style: 'balanced', formation: '4-3-3', pressure: 0, availableTeammates: 0, localSuperiority: 0 }, explanation: '', computeMs: 0 };
    }
  },
};
const POLICIES = { A: GUARDED, B: GUARDED };

/** Match réel (createMatch), gel levé, ballon donné à `ownerId` placé en `ballPos`, autres joueurs sur leurs postes. */
function matchState(seed: number, ownerId: number, ballPos: Vec2, tactics = { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-4-2', 'balanced') }): MatchState {
  const cfg = { seed, tactics, params: P, durationSec: 60 };
  const state = createMatch(cfg, new Rng(seed));
  state.restart = null;
  const owner = state.players[ownerId];
  owner.pos = { ...ballPos };
  state.phase = { [owner.team]: 'attack', [owner.team === 'A' ? 'B' : 'A']: 'defence' } as MatchState['phase'];
  giveBall(state, ownerId, true);
  return state;
}

const inputFor = (state: MatchState, team: TeamId, rng = new Rng(1)): DecisionInput => {
  const fields = state.fields ?? computeFields(state, P);
  state.fields = fields;
  return { state, fields, params: P, tactic: state.tactics[team], rng };
};

const target = (d: Decision): Vec2 => (d.chosen.action.type === 'move' ? d.chosen.action.target : { x: NaN, y: NaN });
const intent = (d: Decision): string => (d.chosen.action.type === 'move' ? d.chosen.action.intent : d.chosen.action.type);

/** 22 joueurs sur les postes 4-3-3 des deux équipes (B en miroir), rôles et postes explicites, léger décalage déterministe. */
function symmetricSpecs(): PlayerSpec[] {
  const specs: PlayerSpec[] = [];
  const slots = FORMATIONS['4-3-3'].slots;
  for (const team of ['A', 'B'] as TeamId[]) {
    const dir = attackDir(team);
    slots.forEach((s, i) => {
      const jitter = ((i * 7) % 5) - 2; // −2..2 m, identique pour les deux équipes (symétrie exacte)
      specs.push({ team, pos: v(dir * (s.x + jitter), dir * (s.y + jitter / 2)), role: s.role, number: i + 1, slotIndex: i });
    });
  }
  return specs;
}

const mirrorSpecs = (specs: PlayerSpec[]): PlayerSpec[] => specs.map((s) => ({ ...s, team: s.team === 'A' ? 'B' : 'A', pos: mirror(s.pos), vel: s.vel ? mirror(s.vel) : undefined }));

// ---------------------------------------------------------------------------
describe('offball — dispersion et validité', () => {
  it('sur un état complet, les cibles des coéquipiers du porteur sont dispersées (distance moyenne ≥ 8 m) et dans le terrain', () => {
    for (const seed of [1, 2, 3]) {
      const state = matchState(seed, 6, v(-5 + seed * 4, -10));
      const decisions = decideAll(state, P, POLICIES, new Map(), new Rng(seed));
      const targets: Vec2[] = [];
      for (const p of state.players) {
        if (p.team !== 'A' || p.role === 'GK' || p.id === 6) continue;
        const d = decisions.get(p.id)!;
        expect(d.chosen.action.type).toBe('move');
        const t = target(d);
        expect(isInsidePitch(t)).toBe(true);
        targets.push(t);
      }
      expect(targets).toHaveLength(9);
      let s = 0, n = 0;
      for (let i = 0; i < targets.length; i++) for (let j = i + 1; j < targets.length; j++) { s += dist(targets[i], targets[j]); n++; }
      expect(s / n).toBeGreaterThanOrEqual(8);
      // Personne ne converge sur le ballon : au plus 2 cibles à moins de 6 m du ballon.
      expect(targets.filter((t) => dist(t, state.ball.pos) < 6).length).toBeLessThanOrEqual(2);
    }
  });

  it('décomposition additive exacte, candidats triés (≤ 6), explication française en 3–4 lignes', () => {
    const state = matchState(4, 6, v(0, 0));
    const d = decideOffBall(inputFor(state, 'A'), 9, null);
    expect(d.candidates.length).toBeGreaterThanOrEqual(2);
    expect(d.candidates.length).toBeLessThanOrEqual(6);
    for (const c of d.candidates) {
      const sum = c.components.reduce((a, x) => a + x.contribution, 0);
      expect(Math.abs(c.score - sum)).toBeLessThan(1e-9);
      expect(c.action.type).toBe('move');
      expect(c.reason.length).toBeGreaterThan(0);
      expect(c.reason.length).toBeLessThanOrEqual(140);
    }
    for (let i = 1; i < d.candidates.length; i++) expect(d.candidates[i - 1].score).toBeGreaterThanOrEqual(d.candidates[i].score);
    expect(d.candidates[0]).toBe(d.chosen);
    const lines = d.explanation.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines[0]).toMatch(/^Intention : /);
    expect(d.computeMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
describe('offball — modulation tactique', () => {
  it('un ailier avec widthUsage 0,95 vise un point plus large qu’avec 0,3', () => {
    const run = (width: number): number => {
      const state = matchState(5, 5, v(-20, 0), { A: makeTactic('4-3-3', 'balanced', { widthUsage: width }), B: makeTactic('4-4-2', 'balanced') });
      const winger = state.players[8]; // LW
      const d = decideOffBall(inputFor(state, 'A'), winger.id, null);
      return Math.abs(target(d).y);
    };
    const wide = run(0.95), narrow = run(0.3);
    expect(wide).toBeGreaterThan(narrow);
    expect(wide - narrow).toBeGreaterThan(2);
  });

  it('tempo : la vitesse de consigne d’un déplacement non-appel vaut v_max·(0,5 + 0,5·tempo)', () => {
    for (const tempo of [0.2, 0.9]) {
      const state = matchState(6, 5, v(-20, 0), { A: makeTactic('4-3-3', 'balanced', { tempo }), B: makeTactic('4-4-2', 'balanced') });
      const d = decideOffBall(inputFor(state, 'A'), 2, null); // défenseur central
      expect(intent(d)).not.toBe('run');
      const p = state.players[2];
      expect(d.chosen.action.type === 'move' ? d.chosen.action.speed : 0).toBeCloseTo(Math.max(3, p.maxSpeed * (0.5 + 0.5 * tempo)), 6);
    }
  });

  it('counterAttackBias : en transition offensive, les candidats vers l’avant ont un poids de valeur recevable renforcé', () => {
    const base = matchState(7, 6, v(0, 0));
    const dA = decideOffBall(inputFor(base, 'A'), 9, null);
    const trans = matchState(7, 6, v(0, 0));
    trans.phase.A = 'transition_attack';
    trans.phaseSince.A = trans.time;
    const dT = decideOffBall(inputFor(trans, 'A'), 9, null);
    const fwd = (d: Decision): number => {
      const c = d.candidates.find((x) => x.action.type === 'move' && x.action.target.x > trans.ball.pos.x + 1)!;
      return c.components.find((x) => x.key === 'receivable')!.weight;
    };
    const bias = trans.tactics.A.params.counterAttackBias;
    expect(fwd(dT)).toBeCloseTo(P.offBall.wReceivable * (1 + 1.5 * bias), 9);
    expect(fwd(dA)).toBeCloseTo(P.offBall.wReceivable, 9);
  });
});

// ---------------------------------------------------------------------------
describe('offball — appels, hors-jeu, défenseurs de repos', () => {
  it('un attaquant fait un appel derrière une ligne défensive haute quand il est en jeu', () => {
    const state = matchState(8, 6, v(0, 0));
    // Ligne défensive de B haute (x = 10), attaquant A en jeu juste devant, espace derrière (gardien B à 50).
    for (const id of [12, 13, 14, 15]) state.players[id].pos = { x: 10, y: -20 + (id - 12) * 13 };
    for (const id of [16, 17, 18, 19]) state.players[id].pos = { x: 0, y: -18 + (id - 16) * 12 };
    state.players[20].pos = { x: -12, y: -6 };
    state.players[21].pos = { x: -12, y: 6 };
    state.players[11].pos = { x: 50, y: 0 };
    state.players[9].pos = { x: 8, y: 0 };
    state.players[6].pos = { x: 0, y: -8 };
    giveBall(state, 6);
    state.fields = null;
    const input = inputFor(state, 'A');
    const runs = deepRunPoints(state, input.fields, state.players[9]);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const line = offsideLine(state, 'A');
    for (const r of runs) expect(r.x).toBeGreaterThan(line + 2 - 1e-9);
    const d = decideOffBall(input, 9, null);
    expect(intent(d)).toBe('run');
    expect(target(d).x).toBeGreaterThan(line);
    expect(d.chosen.action.type === 'move' ? d.chosen.action.speed : 0).toBeCloseTo(state.players[9].maxSpeed, 9);
    expect(d.chosen.components.find((c) => c.key === 'run')!.contribution).toBeCloseTo(P.offBall.wRun * 2 * state.tactics.A.params.runFrequency, 9);
  });

  it('un candidat en position de hors-jeu est pénalisé de w_offside ; un joueur déjà hors-jeu ne génère pas d’appel', () => {
    const state = matchState(9, 6, v(0, 0));
    for (const id of [12, 13, 14, 15]) state.players[id].pos = { x: 10, y: -20 + (id - 12) * 13 };
    state.players[11].pos = { x: 50, y: 0 };
    state.players[9].pos = { x: 14, y: 0 }; // hors-jeu (ligne à 10)
    giveBall(state, 6);
    state.fields = null;
    const input = inputFor(state, 'A');
    expect(deepRunPoints(state, input.fields, state.players[9]).length).toBeGreaterThan(0); // géométrie disponible…
    const d = decideOffBall(input, 9, null);
    expect(d.candidates.every((c) => c.action.type === 'move' && c.action.intent !== 'run')).toBe(true); // …mais pas d'appel (hors-jeu au lancement)
    const offsideCands = d.candidates.filter((c) => c.action.type === 'move' && c.action.target.x > offsideLine(state, 'A') + 0.5);
    for (const c of offsideCands) expect(c.components.find((x) => x.key === 'offside')!.contribution).toBeCloseTo(-P.offBall.wOffside, 9);
    const onside = d.candidates.filter((c) => c.action.type === 'move' && c.action.target.x <= offsideLine(state, 'A'));
    for (const c of onside) expect(c.components.find((x) => x.key === 'offside')!.contribution).toBeCloseTo(0, 12);
  });

  it('les défenseurs de repos (restDefenders) ne s’éloignent pas à plus de 5 m', () => {
    const state = matchState(10, 9, v(30, 0), { A: makeTactic('4-3-3', 'balanced', { restDefenders: 3 }), B: makeTactic('4-4-2', 'balanced') });
    const input = inputFor(state, 'A');
    const rest = state.players.filter((p) => p.team === 'A' && p.role !== 'GK' && isRestDefender(state, p, 3));
    expect(rest).toHaveLength(3);
    const xs = state.players.filter((p) => p.team === 'A' && p.role !== 'GK').map((p) => p.pos.x).sort((a, b) => a - b);
    for (const p of rest) expect(p.pos.x).toBeLessThanOrEqual(xs[2] + 1e-9);
    for (const p of rest) {
      const d = decideOffBall(input, p.id, null);
      for (const c of d.candidates) expect(dist(target({ ...d, chosen: c }), p.pos)).toBeLessThanOrEqual(5 + 1e-6);
    }
  });
});

// ---------------------------------------------------------------------------
describe('offball — hystérésis, réception, symétrie, probabilité rapide', () => {
  it('hystérésis : la cible est conservée au cycle suivant (bonus h_off) puis ré-examinée après reexamineEvery', () => {
    const state = matchState(11, 6, v(0, 0));
    const input = inputFor(state, 'A');
    // Premier joueur de champ (hors porteur) qui décide de se déplacer.
    const mover = state.players.find((p) => p.team === 'A' && p.role !== 'GK' && p.id !== 6 && intent(decideOffBall(input, p.id, null)) !== 'hold_shape')!;
    expect(mover).toBeDefined();
    const first = decideOffBall(input, mover.id, null);
    state.time += P.decisionPeriod;
    const second = decideOffBall(input, mover.id, first);
    expect(dist(target(second), target(first))).toBeLessThan(1e-6);
    expect(second.keptByHysteresis).toBe(true);
    expect(second.chosen.components.find((c) => c.key === 'hysteresis')!.contribution).toBeCloseTo(P.offBall.hysteresis, 9);
    state.time += P.offBall.reexamineEvery + 1;
    const third = decideOffBall(input, mover.id, first);
    expect(third.keptByHysteresis).toBeUndefined();
    expect(third.chosen.components.some((c) => c.key === 'hysteresis')).toBe(false);
  });

  it('receveur d’une passe en cours : intention « receive » vers le point de rencontre', () => {
    const state = matchState(12, 6, v(0, 0));
    const receiver = state.players[9];
    const ball = state.ball;
    ball.ownerId = null;
    ball.pos = { x: 2, y: -6 };
    ball.vel = { x: 8, y: 2 };
    ball.flight = { kind: 'pass', kickerId: 6, targetId: receiver.id, targetPoint: { ...receiver.pos }, origin: { x: 0, y: -8 }, startTime: state.time, initialSpeed: 9 };
    state.fields = null;
    const input = inputFor(state, 'A');
    const d = decideOffBall(input, receiver.id, null);
    expect(intent(d)).toBe('receive');
    const t = target(d);
    expect(isInsidePitch(t)).toBe(true);
    expect(dist(t, target(decideReceive(input, receiver.id)))).toBeLessThan(1e-9);
    // Le point de rencontre est sur la trajectoire du ballon (colinéaire à sa vitesse).
    const rel = { x: t.x - ball.pos.x, y: t.y - ball.pos.y };
    expect(Math.abs(rel.x * ball.vel.y - rel.y * ball.vel.x)).toBeLessThan(1e-6 + 1e-6 * dist(t, ball.pos));
  });

  it('symétrie miroir A/B : l’état (x, y) ↦ (−x, −y) avec équipes échangées donne la cible miroir et la même intention', () => {
    const specs = symmetricSpecs();
    const state = buildState({ players: specs, ball: { pos: specs[6].pos, ownerId: 6 }, tactics: { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-3-3', 'balanced') } });
    const ms = mirrorSpecs(specs);
    const mirrored = buildState({ players: ms, ball: { pos: ms[6].pos, ownerId: 6 }, tactics: { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-3-3', 'balanced') } });
    const inA = inputFor(state, 'A'), inB = inputFor(mirrored, 'B');
    for (const id of [1, 5, 7, 8, 9, 10]) {
      const dA = decideOffBall(inA, id, null), dB = decideOffBall(inB, id, null);
      expect(intent(dB)).toBe(intent(dA));
      expect(target(dB).x).toBeCloseTo(-target(dA).x, 4);
      expect(target(dB).y).toBeCloseTo(-target(dA).y, 4);
      // La grille des champs (nœuds x = −52,5 + 2i, 54 colonnes) n'est pas exactement symétrique : tolérance 5·10⁻³ sur le score.
      expect(Math.abs(dB.chosen.score - dA.chosen.score)).toBeLessThan(5e-3);
    }
  });

  it('quickPassProbability : ancrage 15 m libre ≈ 0,86, cohérent avec passProbability, décroissant avec un défenseur sur la ligne', () => {
    const free = buildState({ players: [
      { team: 'A', pos: v(0, 0), role: 'MF' }, { team: 'A', pos: v(15, 0), role: 'MF' }, { team: 'B', pos: v(-40, 30), role: 'MF' },
    ], ball: { pos: v(0, 0), ownerId: 0 } });
    const fields = computeFields(free, P);
    const q = quickPassProbability(free, fields, v(0, 0), v(15, 0), 'A', P);
    expect(q.p).toBeCloseTo(0.86, 1);
    expect(Math.abs(q.p - passProbability(free, fields, 0, 1, v(15, 0), P).p)).toBeLessThan(0.05);
    const blocked = buildState({ players: [
      { team: 'A', pos: v(0, 0), role: 'MF' }, { team: 'A', pos: v(15, 0), role: 'MF' }, { team: 'B', pos: v(8, 0.5), role: 'MF' },
    ], ball: { pos: v(0, 0), ownerId: 0 } });
    const qb = quickPassProbability(blocked, computeFields(blocked, P), v(0, 0), v(15, 0), 'A', P);
    expect(qb.p).toBeLessThan(q.p * 0.5);
    expect(qb.pIntercept).toBeGreaterThan(0.5);
  });

  it('le poste instancié (slotPosition) est un candidat : loin du ballon et sans option, un joueur revient vers son poste', () => {
    const state = matchState(13, 6, v(-40, -20));
    const p = state.players[10]; // RW, à l'opposé du ballon
    p.pos = { x: 40, y: 30 };
    state.fields = null;
    const d = decideOffBall(inputFor(state, 'A'), p.id, null);
    const slot = slotPosition(state, p);
    expect(dist(target(d), slot)).toBeLessThan(dist(p.pos, slot));
    expect(['hold_shape', 'width', 'support', 'exploit_space', 'create_space']).toContain(intent(d));
    expect(Math.abs(target(d).x)).toBeLessThanOrEqual(PITCH.halfLength);
  });
});
