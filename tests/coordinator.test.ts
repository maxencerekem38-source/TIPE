/**
 * Tests du coordonnateur, du ballon libre et des baselines (src/decision/coordinator.ts, loose.ts, baselines.ts) :
 * 22 décisions valides, receveur / chasseurs, gel de remise en jeu, déterminisme, budget de performance,
 * simulation complète, candidats triés et regret ≥ 0 pour les baselines, point de rencontre physiquement stable.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_PARAMS } from '@/core/params';
import { Rng } from '@/core/rng';
import { isInsidePitch } from '@/core/pitch';
import type { Candidate, Decision, MatchState, MoveIntent, TeamId } from '@/core/types';
import type { Vec2 } from '@/core/vec2';
import { dist } from '@/core/vec2';
import { makeTactic } from '@/tactics/styles';
import { createMatch, giveBall, slotPosition } from '@/engine/match';
import { createSimulation } from '@/engine/loop';
import { computeFields } from '@/models/fields';
import { allocateRuns, decideAll, FULL_POLICY, attackingTeam, runBand } from '@/decision/coordinator';
import { ballPositionAt, ballStopPoint, ballTimeAt, engagedArrivalTime, meetingStillValid, timeToBall, rankChasers, stableMeetingPoint, teamSlot, updateSlotBallRef } from '@/decision/loose';
import { runTime, timeToArrive } from '@/models/motion';
import { decideKeeper } from '@/decision/keeper';
import { BASELINES, pickGreedyProgress, pickGreedySafe, pickRandom, withChosen, candidateEndPoint } from '@/decision/baselines';
import type { DecisionInput, PolicySet } from '@/decision/policy';

const P = DEFAULT_PARAMS;
const v = (x: number, y: number): Vec2 => ({ x, y });
const NOT_IMPL = /non implémenté/;

/** Politique protégée : si le porteur (module concurrent) n'est pas disponible, conservation. */
function guard(policy: PolicySet): PolicySet {
  return {
    ...policy,
    onBall: (input, id, prev) => {
      try { return policy.onBall(input, id, prev); } catch (e) {
        if (!(e instanceof Error) || !NOT_IMPL.test(e.message)) throw e;
        const c: Candidate = { action: { type: 'hold' }, score: 0, probability: 1, valueIfSuccess: 0, valueIfFailure: 0, components: [], reason: 'conservation (porteur indisponible)' };
        return { playerId: id, time: input.state.time, chosen: c, candidates: [c], context: { phase: 'attack', style: 'balanced', formation: '4-3-3', pressure: 0, availableTeammates: 0, localSuperiority: 0 }, explanation: '', computeMs: 0 };
      }
    },
  };
}
const GUARDED = guard(FULL_POLICY);
const POLICIES = { A: GUARDED, B: GUARDED };

function onBallAvailable(): boolean {
  const state = matchState(1, 6, v(0, 0));
  try { decideAll(state, P, { A: FULL_POLICY, B: FULL_POLICY }, new Map(), new Rng(1)); return true; } catch (e) {
    if (e instanceof Error && NOT_IMPL.test(e.message)) return false;
    throw e;
  }
}

function matchState(seed: number, ownerId: number, ballPos: Vec2, tactics = { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-4-2', 'balanced') }): MatchState {
  const state = createMatch({ seed, tactics, params: P, durationSec: 60 }, new Rng(seed));
  state.restart = null;
  const owner = state.players[ownerId];
  owner.pos = { ...ballPos };
  const other: TeamId = owner.team === 'A' ? 'B' : 'A';
  state.phase = { [owner.team]: 'attack', [other]: 'defence' } as MatchState['phase'];
  giveBall(state, ownerId, true);
  return state;
}

const move = (d: Decision) => (d.chosen.action.type === 'move' ? d.chosen.action : null);
/** Champs spatiaux d'un état (calcul synchrone). */
const await0 = (state: MatchState) => computeFields(state, P);

/** Décision « synthétique » du porteur avec des candidats de scores/probabilités donnés (tests des baselines). */
function syntheticDecision(specs: { score: number; p: number; x: number }[]): Decision {
  const candidates: Candidate[] = specs.map((s, i): Candidate => ({
    action: { type: 'pass', targetId: i + 1, targetPoint: { x: s.x, y: 0 }, kind: 'ground', speed: 6 },
    score: s.score, probability: s.p, valueIfSuccess: s.score, valueIfFailure: 0,
    components: [{ key: 'v', label: 'valeur', value: s.score, weight: 1, contribution: s.score }], reason: `candidat ${i}`,
  })).sort((a, b) => b.score - a.score);
  return { playerId: 0, time: 0, chosen: candidates[0], candidates, context: { phase: 'attack', style: 'balanced', formation: '4-3-3', pressure: 0, availableTeammates: 0, localSuperiority: 0 }, explanation: '', computeMs: 0 };
}

// ---------------------------------------------------------------------------
describe('coordinator — cycle complet', () => {
  it('retourne 22 décisions, chaque joueur a une action valide (cibles dans le terrain), state.fields est renseigné', () => {
    const state = matchState(1, 6, v(-5, 8));
    const out = decideAll(state, P, POLICIES, new Map(), new Rng(1));
    expect(out.size).toBe(22);
    expect(state.fields).not.toBeNull();
    expect(state.fields!.time).toBe(state.time);
    expect(attackingTeam(state)).toBe('A');
    for (const p of state.players) {
      const d = out.get(p.id)!;
      expect(d.playerId).toBe(p.id);
      expect(d.time).toBe(state.time);
      expect(d.candidates.length).toBeGreaterThanOrEqual(1);
      expect(d.candidates).toContain(d.chosen);
      const a = d.chosen.action;
      if (p.id === 6) expect(['pass', 'dribble', 'hold', 'shoot', 'clear']).toContain(a.type);
      else {
        expect(a.type).toBe('move');
        if (a.type === 'move') {
          expect(isInsidePitch(a.target)).toBe(true);
          expect(a.speed).toBeGreaterThan(0);
          expect(a.speed).toBeLessThanOrEqual(p.maxSpeed + 1e-9);
          if (p.team === 'A') expect(['support', 'run', 'width', 'create_space', 'exploit_space', 'hold_shape', 'gk_position', 'receive']).toContain(a.intent);
          else expect(['press', 'mark', 'cover', 'zone', 'recover', 'intercept', 'chase', 'gk_position']).toContain(a.intent);
        }
      }
    }
  });

  it('ballon libre : le joueur le plus rapide sur le ballon de chaque équipe court dessus (« chase »), 2 si le ballon est disputé', () => {
    const state = matchState(2, 6, v(0, 0));
    const ball = state.ball;
    ball.ownerId = null;
    ball.pos = { x: 5, y: 5 };
    ball.vel = { x: 6, y: 3 };
    ball.flight = { kind: 'loose', kickerId: 6, targetId: null, targetPoint: { x: 5, y: 5 }, origin: { x: 5, y: 5 }, startTime: state.time, initialSpeed: 6.7 };
    const out = decideAll(state, P, POLICIES, new Map(), new Rng(2));
    expect(out.size).toBe(22);
    const stop = ballStopPoint(ball, P.physics);
    expect(dist(stop.point, ball.pos)).toBeCloseTo((6.7 ** 2) / (2 * P.physics.ballFriction), 1);
    for (const team of ['A', 'B'] as TeamId[]) {
      const ranked = rankChasers(state, P, team);
      const best = ranked[0];
      const a = move(out.get(best.id)!)!;
      expect(a.intent).toBe('chase');
      expect(dist(a.target, best.point)).toBeLessThan(1e-9);
      expect(a.speed).toBeCloseTo(state.players[best.id].maxSpeed, 9);
      // Le point de rencontre est sur la trajectoire du ballon
      const rel = { x: best.point.x - ball.pos.x, y: best.point.y - ball.pos.y };
      expect(Math.abs(rel.x * ball.vel.y - rel.y * ball.vel.x)).toBeLessThan(1e-6 * (1 + dist(best.point, ball.pos)));
      // Le chasseur est bien le plus rapide (temps d'interception minimal)
      for (const p of state.players) if (p.team === team && p.role !== 'GK') expect(timeToBall(p, ball, P).time).toBeGreaterThanOrEqual(best.time - 1e-9);
      const chasers = state.players.filter((p) => p.team === team && move(out.get(p.id)!)?.intent === 'chase');
      const contested = Math.abs(rankChasers(state, P, 'A')[0].time - rankChasers(state, P, 'B')[0].time) < 0.5;
      expect(chasers.length).toBe(contested ? 2 : 1);
    }
  });

  it('passe en cours : le receveur désigné reçoit « receive », l’équipe adverse envoie un intercepteur', () => {
    const state = matchState(3, 6, v(0, 0));
    const ball = state.ball;
    ball.ownerId = null;
    ball.pos = { x: 3, y: 0 };
    ball.vel = { x: 9, y: 0 };
    ball.flight = { kind: 'pass', kickerId: 6, targetId: 9, targetPoint: { x: 26, y: 0 }, origin: { x: 0, y: 0 }, startTime: state.time, initialSpeed: 10 };
    state.players[9].pos = { x: 26, y: 0 };
    const out = decideAll(state, P, POLICIES, new Map(), new Rng(3));
    expect(move(out.get(9)!)!.intent).toBe('receive');
    const bestB = rankChasers(state, P, 'B')[0];
    expect(move(out.get(bestB.id)!)!.intent).toBe('intercept');
    expect(state.players.filter((p) => p.team === 'A' && move(out.get(p.id)!)?.intent === 'receive')).toHaveLength(1);
  });

  it('gel de remise en jeu : tous les joueurs rejoignent leur poste (hold_shape), le remetteur conserve', () => {
    const state = matchState(4, 6, v(0, 0));
    state.restart = { kind: 'throw_in', team: 'A', pos: { x: 0, y: 34 }, resumeAt: state.time + 1 };
    const out = decideAll(state, P, POLICIES, new Map(), new Rng(4));
    expect(out.size).toBe(22);
    for (const p of state.players) {
      const d = out.get(p.id)!;
      if (p.id === 6) { expect(d.chosen.action.type).toBe('hold'); continue; }
      const a = move(d)!;
      expect(a.intent).toBe('hold_shape');
      expect(dist(a.target, slotPosition(state, p))).toBeLessThan(1e-9);
    }
  });

  it('déterminisme : même graine ⇒ décisions identiques (cycle isolé et simulation de 10 s)', () => {
    const s1 = matchState(5, 6, v(-8, 3)), s2 = matchState(5, 6, v(-8, 3));
    const d1 = decideAll(s1, P, POLICIES, new Map(), new Rng(5)), d2 = decideAll(s2, P, POLICIES, new Map(), new Rng(5));
    expect(JSON.stringify([...d1.values()].map((d) => [d.chosen.action, d.chosen.score]))).toBe(JSON.stringify([...d2.values()].map((d) => [d.chosen.action, d.chosen.score])));
    const cfg = { seed: 21, tactics: { A: makeTactic('4-3-3', 'possession'), B: makeTactic('4-4-2', 'high_press') }, params: P, durationSec: 60 };
    const a = createSimulation(cfg, { policies: POLICIES }), b = createSimulation(cfg, { policies: POLICIES });
    a.advance(10);
    b.advance(10);
    expect(JSON.stringify(a.state.players.map((p) => [p.pos, p.vel]))).toBe(JSON.stringify(b.state.players.map((p) => [p.pos, p.vel])));
    expect(JSON.stringify(a.state.ball)).toBe(JSON.stringify(b.state.ball));
    expect(a.state.stats.A.decisions).toBeGreaterThan(0);
  });

  it('simulation complète de 30 s avec la politique complète : 22 décisions par cycle, joueurs dans le terrain, comptabilité cohérente', () => {
    const cfg = { seed: 33, tactics: { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('3-5-2', 'counter') }, params: P, durationSec: 60 };
    const sim = createSimulation(cfg, { policies: POLICIES });
    let cycles = 0;
    sim.advance(30, { onDecisions: (d) => { cycles++; expect(d.size).toBe(22); } });
    expect(cycles).toBeGreaterThan(100);
    for (const p of sim.state.players) expect(isInsidePitch(p.pos, 1)).toBe(true);
    const st = sim.state.stats;
    expect(st.A.decisions + st.B.decisions).toBeGreaterThan(0);
    expect(st.A.regret).toBeGreaterThanOrEqual(0);
    expect(st.B.regret).toBeGreaterThanOrEqual(0);
    expect(st.A.decisionMs).toBeGreaterThanOrEqual(0);
    expect(st.A.possessionTime + st.B.possessionTime).toBeGreaterThan(0);
  });

  it('budget de performance : un cycle decideAll complet (22 joueurs) reste sous 30 ms en moyenne (moyenne affichée)', () => {
    const cfg = { seed: 8, tactics: { A: makeTactic('4-3-3', 'possession'), B: makeTactic('4-4-2', 'high_press') }, params: P, durationSec: 120 };
    const sim = createSimulation(cfg, { policies: POLICIES });
    // Échauffement (JIT) puis mesure sur des états successifs d'un vrai match.
    for (let i = 0; i < 10; i++) { sim.advance(0.5); decideAll(sim.state, P, POLICIES, sim.decisions, sim.rng); }
    const times: number[] = [];
    for (let i = 0; i < 40; i++) {
      sim.advance(0.5);
      const t = performance.now();
      decideAll(sim.state, P, POLICIES, sim.decisions, sim.rng);
      times.push(performance.now() - t);
    }
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    times.sort((a, b) => a - b);
    console.log(`decideAll : moyenne ${mean.toFixed(2)} ms, médiane ${times[Math.floor(times.length / 2)].toFixed(2)} ms, p95 ${times[Math.floor(0.95 * times.length)].toFixed(2)} ms (22 joueurs, porteur ${onBallAvailable() ? 'complet' : 'indisponible'})`);
    expect(mean).toBeLessThan(30);
  });
});

// ---------------------------------------------------------------------------
describe('coordinator — ballon libre : faisabilité, passeur, gardien', () => {
  it('timeToBall : le point de rencontre est atteint avant ou quand le ballon y passe (jamais un point déjà dépassé) ; le passeur n’est pas premier', () => {
    const state = matchState(13, 6, v(0, 0));
    const ball = state.ball;
    ball.ownerId = null;
    ball.pos = { x: 0.6, y: 0 };
    ball.vel = { x: 9, y: 0 };
    ball.flight = { kind: 'pass', kickerId: 6, targetId: 9, targetPoint: { x: 20, y: 0 }, origin: { x: 0, y: 0 }, startTime: state.time, initialSpeed: 9 };
    state.players[6].pos = { x: 0, y: 0 };
    state.players[9].pos = { x: 20, y: 0 };
    for (const p of state.players) p.vel = { x: 0, y: 0 };
    const ranked = rankChasers(state, P, 'A');
    expect(ranked[0].id).not.toBe(6);
    expect(ranked[0].id).toBe(9);
    for (const p of state.players) {
      const r = timeToBall(p, ball, P);
      // Faisabilité : T_j(point) ≤ temps de rencontre, et le ballon est bien au point à cet instant.
      expect(timeToArrive(p.pos, p.vel, r.point, p.maxSpeed, p.maxAccel, P.models)).toBeLessThanOrEqual(r.time + 1e-9);
      expect(dist(ballPositionAt(ball, r.time, P.physics), r.point)).toBeLessThan(0.5);
    }
    // Le passeur ne « rencontre » plus le ballon à sa position courante : son point de rencontre est loin devant lui.
    const passer = timeToBall(state.players[6], ball, P);
    expect(dist(passer.point, ball.pos)).toBeGreaterThan(15);
    expect(passer.time).toBeGreaterThan(3);
  });

  it('passe en cours : l’équipe du passeur n’a pas de second coureur (seul le receveur court), le passeur ne chasse pas sa passe', () => {
    const state = matchState(14, 6, v(0, 0));
    const ball = state.ball;
    ball.ownerId = null;
    ball.pos = { x: 0.6, y: 0 };
    ball.vel = { x: 9, y: 0 };
    ball.flight = { kind: 'pass', kickerId: 6, targetId: 9, targetPoint: { x: 20, y: 0 }, origin: { x: 0, y: 0 }, startTime: state.time, initialSpeed: 9 };
    state.players[6].pos = { x: 0, y: 0 };
    state.players[9].pos = { x: 20, y: 0 };
    const out = decideAll(state, P, POLICIES, new Map(), new Rng(14));
    expect(move(out.get(9)!)!.intent).toBe('receive');
    const runnersA = state.players.filter((p) => p.team === 'A' && ['chase', 'intercept', 'receive'].includes(move(out.get(p.id)!)?.intent ?? ''));
    expect(runnersA.map((p) => p.id)).toEqual([9]);
    expect(move(out.get(6)!)!.intent).not.toBe('chase');
    expect(state.players.filter((p) => p.team === 'B' && move(out.get(p.id)!)?.intent === 'intercept').length).toBeGreaterThanOrEqual(1);
  });

  it('sortie du gardien : dans decideAll, le gardien premier sur un ballon libre de sa surface garde « chase » et aucun joueur de champ n’est envoyé', () => {
    const state = matchState(15, 20, v(10, 0));
    const ball = state.ball;
    ball.ownerId = null;
    ball.pos = { x: -44, y: 3 };
    ball.vel = { x: -2, y: 0 };
    ball.flight = null;
    state.possession = 'B';
    for (const p of state.players) if (p.team === 'B') p.pos = { x: 20 + (p.id % 5) * 3, y: -20 + (p.id % 11) * 4 };
    state.players[0].pos = { x: -50, y: 0 };
    state.fields = null;
    const alone = decideKeeper({ state, fields: (state.fields = (await0(state))), params: P, tactic: state.tactics.A, rng: new Rng(1) }, 0, null);
    expect(move(alone)!.intent).toBe('chase');
    const out = decideAll(state, P, POLICIES, new Map(), new Rng(15));
    expect(move(out.get(0)!)!.intent).toBe('chase');
    expect(dist(move(out.get(0)!)!.target, ball.pos)).toBeLessThan(4);
    const contested = Math.abs(rankChasers(state, P, 'A')[0].time - rankChasers(state, P, 'B')[0].time) < 0.5;
    const outfieldChasers = state.players.filter((p) => p.team === 'A' && p.role !== 'GK' && move(out.get(p.id)!)?.intent === 'chase');
    expect(outfieldChasers.length).toBe(contested ? 1 : 0);
  });

  it('gardien porteur (hors gel) : decideAll passe par la relance §8.6 — action « pass », aucun candidat dribble / tir', () => {
    const state = matchState(16, 0, v(-46, 0));
    expect(state.restart).toBeNull();
    const out = decideAll(state, P, { A: FULL_POLICY, B: FULL_POLICY }, new Map(), new Rng(16));
    const d = out.get(0)!;
    expect(d.chosen.action.type).toBe('pass');
    expect(d.candidates.every((c) => c.action.type === 'pass' || c.action.type === 'hold')).toBe(true);
    expect(d.explanation).toMatch(/^Relance/);
  });

  it('point de rencontre stable : conservé si la nouvelle estimation bouge de moins de 3 m, remplacé sinon ou si l’intention change', () => {
    const prev: Decision = { playerId: 1, time: 0, chosen: { action: { type: 'move', target: { x: 10, y: 0 }, intent: 'chase', speed: 8 }, score: 0, probability: 1, valueIfSuccess: 0, valueIfFailure: 0, components: [], reason: '' }, candidates: [], context: { phase: 'attack', style: 'balanced', formation: '4-3-3', pressure: 0, availableTeammates: 0, localSuperiority: 0 }, explanation: '', computeMs: 0 };
    expect(stableMeetingPoint(prev, 'chase', { x: 12, y: 0 })).toEqual({ x: 10, y: 0 });
    expect(stableMeetingPoint(prev, 'chase', { x: 14, y: 0 })).toEqual({ x: 14, y: 0 });
    expect(stableMeetingPoint(prev, 'receive', { x: 11, y: 0 })).toEqual({ x: 11, y: 0 });
    expect(stableMeetingPoint(null, 'chase', { x: 11, y: 0 })).toEqual({ x: 11, y: 0 });
  });

  it('référence de ballon des postes : recalée au premier cycle, suit le ballon à slotFollowRate m/s au plus, recalée pendant un gel', () => {
    const state = matchState(17, 6, v(0, 0));
    updateSlotBallRef(state, P);
    expect(state.slotBallRef!.pos).toEqual({ x: 0, y: 0 });
    state.ball.pos = { x: 30, y: 0 };
    state.time += 1;
    updateSlotBallRef(state, P);
    expect(state.slotBallRef!.pos.x).toBeCloseTo(P.offBall.slotFollowRate!, 9);
    state.time += 10;
    updateSlotBallRef(state, P);
    expect(state.slotBallRef!.pos.x).toBeCloseTo(30, 9);
    state.ball.pos = { x: -40, y: 10 };
    state.restart = { kind: 'throw_in', team: 'A', pos: { x: -40, y: 10 }, resumeAt: state.time + 1 };
    updateSlotBallRef(state, P);
    expect(state.slotBallRef!.pos).toEqual({ x: -40, y: 10 });
  });
});

// ---------------------------------------------------------------------------
describe('baselines', () => {
  it('BASELINES expose les 7 politiques attendues, chacune complète (onBall, offBall, defence)', () => {
    expect(Object.keys(BASELINES).sort()).toEqual(['greedy_progress', 'greedy_safe', 'nearest_man', 'no_lookahead', 'no_risk', 'no_tactic', 'random'].sort());
    for (const [name, p] of Object.entries(BASELINES)) {
      expect(p.name).toBe(name);
      expect(typeof p.onBall).toBe('function');
      expect(typeof p.offBall).toBe('function');
      expect(typeof p.defence).toBe('function');
    }
    expect(FULL_POLICY.name).toBe('complet');
  });

  it('sélections gloutonne / sûre / aléatoire : candidats triés par le score complet, regret ≥ 0, choix conformes', () => {
    const d = syntheticDecision([{ score: 0.30, p: 0.9, x: 5 }, { score: 0.25, p: 0.35, x: 30 }, { score: 0.10, p: 0.2, x: 40 }, { score: 0.05, p: 0.95, x: -10 }]);
    const safe = withChosen(d, pickGreedySafe(d.candidates), 'sûr');
    expect(safe.chosen.probability).toBe(0.95);
    expect(safe.candidates[0].score - safe.chosen.score).toBeCloseTo(0.25, 9);
    const prog = withChosen(d, pickGreedyProgress(d.candidates, 1, 0, 0), 'progression');
    expect(candidateEndPoint(prog.chosen, 0, 0).x).toBe(30); // max Δx parmi P ≥ 0,3 (le candidat à x = 40 a P = 0,2)
    expect(prog.candidates[0].score - prog.chosen.score).toBeCloseTo(0.05, 9);
    const progB = pickGreedyProgress(d.candidates, -1, 0, 0);
    expect(candidateEndPoint(progB, 0, 0).x).toBe(-10); // équipe B : progression vers −x
    const rng = new Rng(7);
    const counts = new Map<number, number>();
    for (let i = 0; i < 400; i++) { const c = pickRandom(d.candidates, rng); counts.set(c.score, (counts.get(c.score) ?? 0) + 1); }
    expect(counts.size).toBe(4);
    for (const n of counts.values()) expect(n).toBeGreaterThan(50);
    for (const dec of [safe, prog]) {
      for (let i = 1; i < dec.candidates.length; i++) expect(dec.candidates[i - 1].score).toBeGreaterThanOrEqual(dec.candidates[i].score);
      expect(dec.candidates[0].score - dec.chosen.score).toBeGreaterThanOrEqual(0);
      expect(dec.explanation).toMatch(/Regret/);
    }
  });

  it('nearest_man : la défense gloutonne produit 11 décisions valides ; no_tactic utilise les paramètres équilibrés', () => {
    const state = matchState(9, 6, v(5, 0), { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-4-2', 'high_press') });
    const out = decideAll(state, P, { A: GUARDED, B: guard(BASELINES.nearest_man) }, new Map(), new Rng(9));
    expect(out.size).toBe(22);
    for (const p of state.players.filter((q) => q.team === 'B')) {
      const a = move(out.get(p.id)!)!;
      expect(a).not.toBeNull();
      expect(isInsidePitch(a.target)).toBe(true);
    }
    const nt = decideAll(state, P, { A: guard(BASELINES.no_tactic), B: guard(BASELINES.no_tactic) }, new Map(), new Rng(9));
    expect(nt.size).toBe(22);
    // pressing haut désactivé pour B sous no_tactic (pressTriggerCount équilibré = 2, pressLine 0) : pas 2 presseurs
    const pressers = state.players.filter((p) => p.team === 'B' && move(nt.get(p.id)!)?.intent === 'press');
    expect(pressers.length).toBeLessThanOrEqual(1);
  });

  it('avec le porteur complet : random / greedy / no_lookahead / no_risk produisent des candidats triés et un regret ≥ 0', () => {
    if (!onBallAvailable()) { console.log('decideOnBall indisponible : test des baselines du porteur ignoré'); return; }
    const state = matchState(10, 6, v(-10, 4));
    for (const name of ['random', 'greedy_progress', 'greedy_safe', 'no_lookahead', 'no_risk'] as const) {
      const out = decideAll(state, P, { A: BASELINES[name], B: FULL_POLICY }, new Map(), new Rng(10));
      const d = out.get(6)!;
      expect(d.candidates.length).toBeGreaterThan(1);
      for (let i = 1; i < d.candidates.length; i++) expect(d.candidates[i - 1].score).toBeGreaterThanOrEqual(d.candidates[i].score);
      expect(d.candidates[0].score - d.chosen.score).toBeGreaterThanOrEqual(-1e-12);
      expect(d.candidates).toContain(d.chosen);
      if (name === 'greedy_safe') expect(d.chosen.probability).toBeCloseTo(Math.max(...d.candidates.map((c) => c.probability)), 9);
      if (name === 'no_lookahead') expect(d.candidates.every((c) => !c.components.some((x) => x.key === 'lookahead'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
describe('coordinator — point de rencontre physiquement stable (loose.ballTimeAt, meetingStillValid)', () => {
  const rolling = (state: MatchState, speed: number): MatchState['ball'] => {
    const ball = state.ball;
    ball.ownerId = null;
    ball.pos = { x: 0, y: 0 };
    ball.vel = { x: speed, y: 0 };
    ball.flight = null;
    return ball;
  };

  it('ballTimeAt : instant de passage du ballon roulant (s·t − μt²/2 = d), ∞ hors trajectoire, derrière le ballon ou au-delà du point d’arrêt', () => {
    const state = matchState(31, 6, v(0, 0));
    const ball = rolling(state, 9);
    const mu = P.physics.ballFriction;
    const t10 = ballTimeAt(ball, { x: 10, y: 0 }, P.physics);
    expect(t10).toBeCloseTo((9 - Math.sqrt(81 - 2 * mu * 10)) / mu, 9);
    expect(dist(ballPositionAt(ball, t10, P.physics), { x: 10, y: 0 })).toBeLessThan(1e-6);
    const stop = ballStopPoint(ball, P.physics);
    expect(ballTimeAt(ball, stop.point, P.physics)).toBeCloseTo(stop.time, 6);
    expect(ballTimeAt(ball, { x: 10, y: 3 }, P.physics)).toBe(Infinity); // hors de la ligne
    expect(ballTimeAt(ball, { x: -5, y: 0 }, P.physics)).toBe(Infinity); // déjà dépassé
    expect(ballTimeAt(ball, { x: stop.point.x + 5, y: 0 }, P.physics)).toBe(Infinity); // au-delà de l'arrêt
    ball.vel = { x: 0, y: 0 };
    expect(ballTimeAt(ball, { x: 0.5, y: 0 }, P.physics)).toBe(0);
    expect(ballTimeAt(ball, { x: 5, y: 0 }, P.physics)).toBe(Infinity);
  });

  it('meetingStillValid / stableMeetingPoint : l’ancien point est gardé s’il reste atteignable avant le ballon (à meetingKeepGain s près), remplacé sinon', () => {
    const state = matchState(32, 6, v(0, 0));
    const ball = rolling(state, 12);
    const receiver = state.players[9];
    receiver.pos = { x: 30, y: 0 };
    receiver.vel = { x: 0, y: 0 };
    const fresh = timeToBall(receiver, ball, P);
    const mk = (target: Vec2): Decision => ({ playerId: receiver.id, time: 0, chosen: { action: { type: 'move', target, intent: 'receive', speed: 8 }, score: 0, probability: 1, valueIfSuccess: 0, valueIfFailure: 0, components: [], reason: '' }, candidates: [], context: { phase: 'attack', style: 'balanced', formation: '4-3-3', pressure: 0, availableTeammates: 0, localSuperiority: 0 }, explanation: '', computeMs: 0 });
    const ctx = { player: receiver, ball, params: P, time: fresh.time };
    // Ancien point un peu plus loin sur la trajectoire (le ballon y passe 0,4 s après le point de rencontre le plus tôt) : gardé même à > 3 m.
    const later = ballPositionAt(ball, fresh.time + 0.4, P.physics);
    expect(dist(later, fresh.point)).toBeGreaterThan(3);
    expect(meetingStillValid(later, ctx)).toBe(true);
    expect(stableMeetingPoint(mk(later), 'receive', fresh.point, ctx)).toEqual(later);
    // Trop tard par rapport au nouveau point (> meetingKeepGain) : remplacé.
    const tooLate = ballPositionAt(ball, fresh.time + P.offBall.meetingKeepGain! + 0.3, P.physics);
    expect(meetingStillValid(tooLate, ctx)).toBe(false);
    expect(stableMeetingPoint(mk(tooLate), 'receive', fresh.point, ctx)).toEqual(fresh.point);
    // Point déjà dépassé par le ballon, ou hors trajectoire : remplacé.
    expect(meetingStillValid({ x: -3, y: 0 }, ctx)).toBe(false);
    expect(meetingStillValid({ x: 12, y: 4 }, ctx)).toBe(false);
    // Point sur la trajectoire que le joueur ne peut plus atteindre avant le ballon : remplacé.
    const early = ballPositionAt(ball, 0.15, P.physics);
    expect(meetingStillValid(early, ctx)).toBe(false);
    expect(stableMeetingPoint(mk(early), 'receive', fresh.point, ctx)).toEqual(fresh.point);
    // Sans contexte : règle des 3 m seule.
    expect(stableMeetingPoint(mk(later), 'receive', fresh.point)).toEqual(fresh.point);
  });

  it('simulation : pendant une passe au sol, la cible du receveur désigné ne recule pas le long de la trajectoire (≤ 2 cibles distinctes par passe)', () => {
    const sim = createSimulation({ seed: 33, tactics: { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-4-2', 'balanced') }, params: P, durationSec: 90 }, { policies: POLICIES });
    const perFlight = new Map<string, Vec2[]>();
    sim.advance(90, {
      onDecisions: (decisions, state) => {
        const f = state.ball.flight;
        if (!f || state.ball.ownerId !== null || f.targetId === null || f.kind === 'lob' || f.kind === 'clearance') return;
        const d = decisions.get(f.targetId);
        const a = d?.chosen.action;
        if (!a || a.type !== 'move' || a.intent !== 'receive') return;
        const key = `${f.kickerId}:${f.startTime.toFixed(3)}`;
        const list = perFlight.get(key) ?? [];
        if (!list.some((q) => dist(q, a.target) < 0.5)) list.push({ x: a.target.x, y: a.target.y });
        perFlight.set(key, list);
      },
    });
    const flights = [...perFlight.values()].filter((l) => l.length > 0);
    expect(flights.length).toBeGreaterThanOrEqual(8);
    const unstable = flights.filter((l) => l.length > 2).length;
    console.log(`passes suivies : ${flights.length}, cibles de réception distinctes par passe : ${(flights.reduce((s, l) => s + l.length, 0) / flights.length).toFixed(2)} (instables > 2 : ${unstable})`);
    expect(flights.reduce((s, l) => s + l.length, 0) / flights.length).toBeLessThan(2.2);
    expect(unstable / flights.length).toBeLessThanOrEqual(0.25);
  });

  it('engagedArrivalTime : à l’arrêt = runTime (sans temps de réaction) ; lancé vers la cible, d/v_max ; s’en éloignant, comme à l’arrêt ; toujours < timeToArrive', () => {
    const state = matchState(37, 6, v(0, 0));
    const p = state.players[9];
    p.pos = { x: 0, y: 0 };
    p.vel = { x: 0, y: 0 };
    const q = { x: 20, y: 0 };
    expect(engagedArrivalTime(p, q)).toBeCloseTo(runTime(20, p.maxSpeed, p.maxAccel), 9);
    expect(engagedArrivalTime(p, q)).toBeLessThan(timeToArrive(p.pos, p.vel, q, p.maxSpeed, p.maxAccel, P.models));
    p.vel = { x: p.maxSpeed, y: 0 };
    expect(engagedArrivalTime(p, q)).toBeCloseTo(20 / p.maxSpeed, 9);
    expect(engagedArrivalTime(p, q)).toBeLessThan(timeToArrive(p.pos, p.vel, q, p.maxSpeed, p.maxAccel, P.models));
    p.vel = { x: -p.maxSpeed, y: 0 };
    expect(engagedArrivalTime(p, q)).toBeCloseTo(runTime(20, p.maxSpeed, p.maxAccel), 9);
    p.vel = { x: 0, y: p.maxSpeed }; // vitesse orthogonale : aucune composante utile
    expect(engagedArrivalTime(p, q)).toBeCloseTo(runTime(20, p.maxSpeed, p.maxAccel), 9);
    expect(engagedArrivalTime(p, p.pos)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('coordinator — un seul coureur par bande latérale (§7.2, allocateRuns)', () => {
  const mkMove = (target: Vec2, intent: MoveIntent, score: number, reason: string): Candidate => ({
    action: { type: 'move', target, intent, speed: 8 }, score, probability: 1, valueIfSuccess: 0, valueIfFailure: 0, components: [], reason,
  });
  const mkDecision = (state: MatchState, id: number, candidates: Candidate[]): Decision => ({
    playerId: id, time: state.time, chosen: candidates[0], candidates, explanation: 'Intention : appel.', computeMs: 0, committedUntil: state.time + 2,
    context: { phase: 'attack', style: 'balanced', formation: '4-3-3', pressure: 0, availableTeammates: 0, localSuperiority: 0 },
  });

  it('runBand : bandes de largeur w sur y, comptées depuis la ligne de touche y = −34', () => {
    expect(runBand(-34, 15)).toBe(0);
    expect(runBand(-19.5, 15)).toBe(0);
    expect(runBand(-19, 15)).toBe(1);
    expect(runBand(0, 15)).toBe(2);
    expect(runBand(33, 15)).toBe(4);
    expect(runBand(0, 10)).toBe(3);
  });

  it('allocation gloutonne par utilité : deux appels dans la même bande ⇒ le meilleur garde le sien, l’autre reprend son meilleur candidat non-appel (explication annotée, engagement conservé) ; bandes différentes ⇒ tous gardés ; sans repli ⇒ retour au poste ; largeur 0 ⇒ désactivé', () => {
    const state = matchState(35, 6, v(0, 0));
    const input: DecisionInput = { state, fields: await0(state), params: P, tactic: state.tactics.A, rng: new Rng(1) };
    const build = (): Map<number, Decision> => {
      const out = new Map<number, Decision>();
      out.set(8, mkDecision(state, 8, [mkMove(v(30, -20), 'run', 0.9, 'appel bande 0'), mkMove(v(10, -20), 'support', 0.5, 'soutien 8')]));
      out.set(9, mkDecision(state, 9, [mkMove(v(30, 2), 'run', 0.8, 'appel bande 2'), mkMove(v(12, 0), 'support', 0.6, 'soutien 9')]));
      out.set(10, mkDecision(state, 10, [mkMove(v(28, 5), 'run', 0.7, 'appel bande 2 aussi'), mkMove(v(5, 12), 'width', 0.4, 'largeur 10')]));
      return out;
    };
    expect(runBand(2, P.offBall.runBandWidth)).toBe(runBand(5, P.offBall.runBandWidth));
    expect(runBand(-20, P.offBall.runBandWidth)).not.toBe(runBand(2, P.offBall.runBandWidth));
    const out = build();
    expect(allocateRuns(state, P, out, 'A', input)).toEqual([10]);
    expect(move(out.get(8)!)!.intent).toBe('run');
    expect(move(out.get(9)!)!.intent).toBe('run');
    const d10 = out.get(10)!;
    expect(move(d10)!.intent).toBe('width');
    expect(d10.chosen).toBe(d10.candidates[1]);
    expect(d10.candidates).toHaveLength(2); // la liste des candidats n'est pas modifiée
    expect(d10.explanation).toContain('cédé à');
    expect(d10.explanation).toContain(state.players[9].name);
    expect(d10.explanation).toContain('largeur 10');
    expect(d10.committedUntil).toBe(state.time + 2);
    // Ordre d'utilité, pas d'identifiant : si 10 a la meilleure utilité, c'est 9 qui cède.
    const out2 = build();
    out2.get(10)!.chosen.score = 0.95;
    expect(allocateRuns(state, P, out2, 'A', input)).toEqual([9]);
    expect(move(out2.get(9)!)!.intent).toBe('support');
    expect(move(out2.get(10)!)!.intent).toBe('run');
    // Sans candidat non-appel : retour au poste (hold_shape vers le poste instancié).
    const out3 = build();
    out3.get(10)!.candidates.length = 1;
    expect(allocateRuns(state, P, out3, 'A', input)).toEqual([10]);
    const a3 = move(out3.get(10)!)!;
    expect(a3.intent).toBe('hold_shape');
    expect(dist(a3.target, teamSlot(state, state.players[10]))).toBeLessThan(1e-6);
    expect(out3.get(10)!.explanation).toContain('retour au poste');
    // Largeur nulle : règle désactivée ; l'équipe qui défend n'est pas concernée (aucune décision d'appel).
    const out4 = build();
    expect(allocateRuns(state, { ...P, offBall: { ...P.offBall, runBandWidth: 0 } }, out4, 'A', input)).toEqual([]);
    expect(move(out4.get(10)!)!.intent).toBe('run');
    expect(allocateRuns(state, P, build(), 'B', input)).toEqual([]);
  });

  it('simulation 60 s (decideAll) : jamais deux appels de l’équipe attaquante dans la même bande latérale, et des cycles avec plusieurs appels existent', () => {
    const sim = createSimulation({ seed: 36, tactics: { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-4-2', 'balanced') }, params: P, durationSec: 60 }, { policies: POLICIES });
    let runCycles = 0, multi = 0, demotedNotes = 0;
    sim.advance(60, {
      onDecisions: (decisions, state) => {
        const att = attackingTeam(state);
        const bands = new Map<number, number>();
        for (const [id, d] of decisions) {
          if (state.players[id].team === att && d.explanation.includes('Appel en profondeur cédé')) demotedNotes++;
          const a = d.chosen.action;
          if (a.type !== 'move' || a.intent !== 'run' || state.players[id].team !== att) continue;
          const b = runBand(a.target.y, P.offBall.runBandWidth);
          expect(bands.has(b)).toBe(false);
          bands.set(b, id);
        }
        if (bands.size) runCycles++;
        if (bands.size >= 2) multi++;
      },
    });
    console.log(`appels : ${runCycles} cycles avec appel, ${multi} avec plusieurs bandes, ${demotedNotes} appels cédés`);
    expect(runCycles).toBeGreaterThan(0);
  });
});
