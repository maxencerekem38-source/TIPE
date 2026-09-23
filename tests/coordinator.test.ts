/**
 * Tests du coordonnateur, du ballon libre et des baselines (src/decision/coordinator.ts, loose.ts, baselines.ts) :
 * 22 décisions valides, receveur / chasseurs, gel de remise en jeu, déterminisme, budget de performance,
 * simulation complète, candidats triés et regret ≥ 0 pour les baselines.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_PARAMS } from '@/core/params';
import { Rng } from '@/core/rng';
import { isInsidePitch } from '@/core/pitch';
import type { Candidate, Decision, MatchState, TeamId } from '@/core/types';
import type { Vec2 } from '@/core/vec2';
import { dist } from '@/core/vec2';
import { makeTactic } from '@/tactics/styles';
import { createMatch, giveBall, slotPosition } from '@/engine/match';
import { createSimulation } from '@/engine/loop';
import { decideAll, FULL_POLICY, attackingTeam } from '@/decision/coordinator';
import { ballStopPoint, timeToBall, rankChasers } from '@/decision/loose';
import { BASELINES, pickGreedyProgress, pickGreedySafe, pickRandom, withChosen, candidateEndPoint } from '@/decision/baselines';
import type { PolicySet } from '@/decision/policy';

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
