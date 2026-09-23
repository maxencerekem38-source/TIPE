/**
 * Tests du banc d'expériences : bibliothèque de scénarios, générateur, métriques et statistiques,
 * optimiseurs (CEM, recherche aléatoire, (1+1)-ES), calibration (Platt), pool de workers, analyse des arguments,
 * et — quand le moteur est disponible — exécution de matchs et de scénarios.
 */
import { describe, it, expect } from 'vitest';
import { PITCH, isInsidePitch } from '@/core/pitch';
import { Rng } from '@/core/rng';
import { DEFAULT_PARAMS, flattenParams } from '@/core/params';
import { buildFullState, emptyStats } from '@/core/state-builder';
import { attackDir, type Action, type Decision, type MatchEvent, type MatchState, type TeamId } from '@/core/types';
import { SCENARIOS, SCENARIO_CATEGORIES, isAcceptable, actionClassOf, describeAcceptable, reservedScenarios } from '@/experiments/scenarios';
import { generateScenarios, benchmarkScenarios, buildGeneratedState } from '@/experiments/scenario-generator';
import { teamKpis, aggregate, wilcoxonSignedRank, cliffsDelta, holmCorrection, eloRatings, pairedSummary, fmt, mdTable, turnoverDanger, normalCdf } from '@/experiments/metrics';
import { cem, randomSearch, onePlusOneEs, vectorToFlat, flatToVector, paramsToVector, vectorToParams, DEFAULT_OPTIM_PATHS, defaultLogSpace, defaultSigma0, OpponentPool, makeMatchFitness } from '@/experiments/cem';
import { brierScore, fitPlattScaling, reliabilityTable, collectCalibrationPairs, calibrationReport, type CalibrationPair } from '@/experiments/calibration';
import { runBatch } from '@/experiments/worker-pool';
import { parseArgs, numFlag, strFlag, boolFlag, parseTactic, makeConfig, simulationAvailable, engineAvailable, simulationStatus, engineStatus, resolvePolicy } from '@/experiments/cli';
import { runMatch, runScenario, loadStateInto, convexHullArea, teamCompactness, createMatchCollector, type MatchResult } from '@/experiments/runner';
import { matchStatsTable } from '@/experiments/report';
import { sideMetrics } from '@/experiments/tournament';
import { createSimulation, type DecideFn } from '@/engine/loop';
import { goalCentre } from '@/core/pitch';

// ---------------------------------------------------------------------------
// Aides
// ---------------------------------------------------------------------------
const stateHash = (s: MatchState): string => JSON.stringify({ players: s.players.map((p) => [p.id, p.pos, p.vel]), ball: s.ball.pos, owner: s.ball.ownerId, score: s.score, stats: s.stats });

/** Décision factice : le porteur passe à un coéquipier (ou tire près du but), les autres se déplacent. */
function makeDummyDecide(): DecideFn {
  return (state, _params, _policies, _previous, rng) => {
    const out = new Map<number, Decision>();
    const owner = state.ball.ownerId;
    const mkDecision = (playerId: number, action: Action, alt: Action, ms: number): Decision => {
      const chosen = { action, score: 1, probability: 0.8, valueIfSuccess: 1, valueIfFailure: 0, components: [], reason: 'factice' };
      return { playerId, time: state.time, chosen, candidates: [chosen, { ...chosen, action: alt, score: 0.5 }], context: { phase: 'attack', style: 'balanced', formation: '4-3-3', pressure: 0, availableTeammates: 3, localSuperiority: 0 }, explanation: 'décision factice', computeMs: ms };
    };
    for (const p of state.players) {
      if (p.id === owner && state.time - p.lastKickTime > 0.5) {
        const dir = attackDir(p.team);
        const goal = goalCentre(dir);
        const mates = state.players.filter((q) => q.team === p.team && q.id !== p.id);
        const mate = mates[Math.floor(rng.next() * mates.length)];
        const toGoal = Math.hypot(goal.x - p.pos.x, goal.y - p.pos.y);
        const action: Action = toGoal < 22 ? { type: 'shoot', targetPoint: goal, power: 1 } : { type: 'pass', targetId: mate.id, targetPoint: { ...mate.pos }, kind: 'ground', speed: 12 };
        out.set(p.id, mkDecision(p.id, action, { type: 'hold' }, 0.05));
      } else if (p.id !== owner) {
        const target = { x: p.pos.x + (rng.next() - 0.5) * 6, y: p.pos.y + (rng.next() - 0.5) * 6 };
        const intent = p.team === state.possession && rng.next() < 0.1 ? 'run' : 'support';
        out.set(p.id, mkDecision(p.id, { type: 'move', target, intent, speed: 4 }, { type: 'hold' }, 0.01));
      }
    }
    return out;
  };
}

const simReady = simulationAvailable();
const engineReady = engineAvailable();
const skipSim = simReady ? '' : `simulation indisponible : ${simulationStatus().reason}`;
const skipEngine = engineReady ? '' : `couche décision indisponible : ${engineStatus().reason}`;

// ---------------------------------------------------------------------------
// Bibliothèque de scénarios
// ---------------------------------------------------------------------------
describe('bibliothèque de scénarios', () => {
  it('contient au moins 24 scénarios aux identifiants uniques et catégories valides', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(24);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    for (const s of SCENARIOS) {
      expect(SCENARIO_CATEGORIES[s.category]).toBeTruthy();
      expect(s.name.length).toBeGreaterThan(3);
      expect(s.description.length).toBeGreaterThan(20);
    }
  });

  it('chaque scénario construit 22 joueurs dans le terrain, le ballon au protagoniste, avec des actions acceptables', () => {
    for (const s of SCENARIOS) {
      const st = s.build();
      expect(st.players.length, s.id).toBe(22);
      for (const p of st.players) expect(isInsidePitch(p.pos), `${s.id} joueur ${p.id} (${p.pos.x}, ${p.pos.y})`).toBe(true);
      expect(st.ball.ownerId, s.id).toBe(s.protagonistId);
      const owner = st.players.find((p) => p.id === s.protagonistId)!;
      expect(owner.team).toBe(s.team);
      expect(Math.hypot(st.ball.pos.x - owner.pos.x, st.ball.pos.y - owner.pos.y)).toBeLessThan(1e-9);
      expect(st.possession).toBe(s.team);
      expect(s.acceptable.length, s.id).toBeGreaterThan(0);
      // Aucun joueur superposé (géométrie réaliste)
      for (let i = 0; i < 22; i++) for (let j = i + 1; j < 22; j++) {
        const a = st.players[i].pos, b = st.players[j].pos;
        expect(Math.hypot(a.x - b.x, a.y - b.y), `${s.id} joueurs ${i}/${j}`).toBeGreaterThan(0.8);
      }
      // Les gardiens sont dans leur moitié, près de leur but.
      for (const gk of st.players.filter((p) => p.role === 'GK')) expect(-attackDir(gk.team) * gk.pos.x).toBeGreaterThan(PITCH.halfLength - PITCH.penaltyAreaLength - 1);
    }
  });

  it('apply() reproduit exactement les positions dans un état vivant (aller-retour)', () => {
    for (const s of SCENARIOS) {
      const live = buildFullState();
      live.time = 42;
      live.restart = { kind: 'kickoff', team: 'A', pos: { x: 0, y: 0 }, resumeAt: 50 };
      s.apply(live);
      const ref = s.build();
      expect(stateHash(live).replace(/"score".*$/, '')).toBe(stateHash(ref).replace(/"score".*$/, ''));
      expect(live.restart).toBeNull();
      expect(live.possessionSince).toBe(42);
      expect(live.tactics.A.formation).toBe(ref.tactics.A.formation);
    }
  });

  it('classe et juge les actions selon l’ensemble acceptable (cible, direction)', () => {
    const s = SCENARIOS.find((x) => x.id === 'counter_3v2')!;
    const st = s.build();
    const owner = st.players.find((p) => p.id === s.protagonistId)!;
    const lw = st.players.find((p) => p.id === 8)!;
    const pass: Action = { type: 'pass', targetId: 8, targetPoint: lw.pos, kind: 'ground', speed: 10 };
    const passBack: Action = { type: 'pass', targetId: 5, targetPoint: st.players[5].pos, kind: 'ground', speed: 10 };
    const dribbleFwd: Action = { type: 'dribble', direction: { x: 1, y: 0 }, distance: 6 };
    const dribbleBack: Action = { type: 'dribble', direction: { x: -1, y: 0 }, distance: 6 };
    const through: Action = { type: 'pass', targetId: 10, targetPoint: { x: 40, y: 10 }, kind: 'through', speed: 14 };
    expect(actionClassOf(pass)).toBe('pass');
    expect(actionClassOf(through)).toBe('through');
    expect(actionClassOf({ type: 'move', target: { x: 0, y: 0 }, intent: 'support', speed: 1 })).toBeNull();
    expect(isAcceptable(s.acceptable, pass, owner)).toBe(true);
    expect(isAcceptable(s.acceptable, passBack, owner)).toBe(false);
    expect(isAcceptable(s.acceptable, dribbleFwd, owner)).toBe(true);
    expect(isAcceptable(s.acceptable, dribbleBack, owner)).toBe(false);
    expect(isAcceptable(s.acceptable, through, owner)).toBe(true);
    expect(isAcceptable(s.acceptable, { type: 'hold' }, owner)).toBe(false);
    expect(describeAcceptable(s.acceptable)).toContain('passe → 8');
    // Équipe B : la direction « avant » est vers −x.
    const sB = SCENARIOS.find((x) => x.team === 'B' && x.acceptable.some((a) => typeof a !== 'string' && a.direction === 'forward'))!;
    const stB = sB.build();
    const ownerB = stB.players.find((p) => p.id === sB.protagonistId)!;
    const fwdB: Action = { type: 'pass', targetId: 20, targetPoint: { x: ownerB.pos.x - 10, y: ownerB.pos.y }, kind: 'ground', speed: 10 };
    expect(isAcceptable([{ cls: 'pass', direction: 'forward' }], fwdB, ownerB)).toBe(true);
  });

  it('le jeu de référence compte exactement 20 scénarios réservés', () => {
    const bench = benchmarkScenarios(SCENARIOS, 24, 2024);
    expect(bench.length).toBe(SCENARIOS.length + 24);
    expect(reservedScenarios(bench).length).toBe(20);
    expect(reservedScenarios(SCENARIOS).length).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// Générateur
// ---------------------------------------------------------------------------
describe('générateur de scénarios', () => {
  it('est déterministe pour une graine donnée et varie avec la graine', () => {
    const a = generateScenarios(5, 6), b = generateScenarios(5, 6), c = generateScenarios(6, 6);
    expect(a.map((s) => stateHash(s.build()))).toEqual(b.map((s) => stateHash(s.build())));
    expect(stateHash(a[0].build())).not.toBe(stateHash(c[0].build()));
    expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id));
    // build() est pur : deux appels donnent le même état.
    expect(stateHash(a[2].build())).toBe(stateHash(a[2].build()));
  });

  it('produit des états valides (22 joueurs dans le terrain, porteur de champ, gardiens chez eux)', () => {
    for (const s of generateScenarios(11, 30, { reservedCount: 5 })) {
      const st = s.build();
      expect(st.players.length).toBe(22);
      for (const p of st.players) expect(isInsidePitch(p.pos)).toBe(true);
      const owner = st.players.find((p) => p.id === st.ball.ownerId)!;
      expect(owner.team).toBe(s.team);
      expect(owner.role).not.toBe('GK');
      expect(st.ball.ownerId).toBe(s.protagonistId);
      for (const gk of st.players.filter((p) => p.role === 'GK')) expect(-attackDir(gk.team) * gk.pos.x).toBeGreaterThanOrEqual(PITCH.halfLength - PITCH.penaltyAreaLength - 1e-9);
      expect(s.generated).toBe(true);
      expect(s.acceptable.length).toBe(6);
    }
    const gens = generateScenarios(11, 30, { reservedCount: 5 });
    expect(gens.filter((s) => s.reserved).length).toBe(5);
    const thirds = new Set(gens.map((s) => buildGeneratedState(11, gens.indexOf(s)).info.third));
    expect(thirds.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Métriques et statistiques
// ---------------------------------------------------------------------------
describe('métriques', () => {
  it('dérive les KPI d’équipe à partir de MatchStats synthétiques', () => {
    const stats = emptyStats();
    Object.assign(stats.A, { goals: 2, shots: 10, xG: 1.4, passes: 200, passesCompleted: 160, turnovers: 12, possessionTime: 360, threatCreated: 0.9, decisions: 1000, decisionMs: 250, regret: 5, tackles: 10, interceptions: 5 });
    Object.assign(stats.B, { goals: 1, shots: 6, xG: 0.6, passes: 150, passesCompleted: 100, turnovers: 20, possessionTime: 240, threatCreated: 0.4, decisions: 1000, decisionMs: 500, regret: 8, tackles: 20, interceptions: 10 });
    const a = teamKpis(stats, 'A', 600);
    expect(a.possessionShare).toBeCloseTo(0.6);
    expect(a.passCompletion).toBeCloseTo(0.8);
    expect(a.xGDiff).toBeCloseTo(0.8);
    expect(a.turnoversPer10).toBeCloseTo(12);
    expect(a.decisionLatencyMean).toBeCloseTo(0.25);
    expect(a.regretPerDecision).toBeCloseTo(0.005);
    expect(a.ppda).toBeCloseTo(150 / 15);
    const b = teamKpis(stats, 'B', 300);
    expect(b.turnoversPer10).toBeCloseTo(40);
    expect(b.xGDiff).toBeCloseTo(-0.8);
    const r: MatchResult = { seed: 1, score: { A: 2, B: 1 }, stats, durationSec: 600, wallMs: 10, kpi: { A: a, B: b } };
    expect(sideMetrics(r, 'A').xG).toBeCloseTo(0.8);
    expect(sideMetrics(r, 'B').goals).toBe(-1);
    expect(matchStatsTable(r)).toContain('| xG | 1,40 | 0,60 |');
  });

  it('agrège avec moyenne, écart-type, IC de Student et bootstrap reproductible', () => {
    const rng = new Rng(3);
    const xs = Array.from({ length: 40 }, () => rng.normal(2, 1));
    const a1 = aggregate(xs, new Rng(9)), a2 = aggregate(xs, new Rng(9));
    expect(a1.n).toBe(40);
    expect(a1.mean).toBeCloseTo(2, 0);
    expect(a1.ci.low).toBeLessThan(2);
    expect(a1.ci.high).toBeGreaterThan(2);
    expect(a1.bootstrap).toEqual(a2.bootstrap);
    expect(a1.bootstrap.low).toBeLessThan(a1.mean);
    expect(a1.bootstrap.high).toBeGreaterThan(a1.mean);
    expect(Math.abs(a1.bootstrap.high - a1.ci.high)).toBeLessThan(0.15);
    const ps = pairedSummary(xs, xs.map((x) => x - 0.5), new Rng(1));
    expect(ps.meanDiff).toBeCloseTo(0.5, 6);
    expect(ps.winRate).toBe(1);
    expect(ps.wilcoxon.pValue).toBeLessThan(1e-6);
  });

  it('calcule le test de Wilcoxon signé sur un exemple connu (exact) et en approximation normale', () => {
    // Exemple classique (Wikipédia) : 10 paires, une différence nulle ⇒ n = 9, W⁺ = 27, W⁻ = 18.
    const x = [125, 115, 130, 140, 140, 115, 140, 125, 140, 135];
    const y = [110, 122, 125, 120, 140, 124, 123, 137, 135, 145];
    const w = wilcoxonSignedRank(x.map((v, i) => v - y[i]));
    expect(w.n).toBe(9);
    expect(w.method).toBe('exact');
    expect(w.wPlus).toBeCloseTo(27);
    expect(w.wMinus).toBeCloseTo(18);
    expect(w.pValue).toBeGreaterThan(0.5);
    expect(w.pValue).toBeLessThan(0.8);
    const wn = wilcoxonSignedRank(x.map((v, i) => v - y[i]), 5);
    expect(wn.method).toBe('normal');
    expect(Math.abs(wn.pValue - w.pValue)).toBeLessThan(0.15);
    // Toutes les différences positives : p = 2 / 2ⁿ.
    const all = wilcoxonSignedRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(all.pValue).toBeCloseTo(2 / 1024, 6);
    expect(wilcoxonSignedRank([0, 0, 0]).pValue).toBe(1);
    // Grand échantillon : approximation normale cohérente avec l'effet.
    const rng = new Rng(8);
    const big = Array.from({ length: 60 }, () => rng.normal(0.5, 1));
    const wb = wilcoxonSignedRank(big);
    expect(wb.method).toBe('normal');
    expect(wb.pValue).toBeLessThan(0.01);
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
  });

  it('δ de Cliff : bornes, antisymétrie, séparation complète', () => {
    expect(cliffsDelta([1, 2, 3], [4, 5, 6])).toBe(-1);
    expect(cliffsDelta([4, 5, 6], [1, 2, 3])).toBe(1);
    expect(cliffsDelta([1, 2, 3], [1, 2, 3])).toBe(0);
    const a = [1, 3, 5, 7], b = [2, 3, 6];
    expect(cliffsDelta(a, b)).toBeCloseTo(-cliffsDelta(b, a));
    expect(Math.abs(cliffsDelta(a, b))).toBeLessThanOrEqual(1);
  });

  it('applique la correction de Holm', () => {
    expect(holmCorrection([0.01, 0.04, 0.03]).map((p) => +p.toFixed(6))).toEqual([0.03, 0.06, 0.06]);
    expect(holmCorrection([0.5])).toEqual([0.5]);
    expect(holmCorrection([])).toEqual([]);
  });

  it('Elo : symétrie, conservation de la somme, invariance aux matchs nuls', () => {
    const games = Array.from({ length: 10 }, () => ({ a: 'X', b: 'Y', scoreA: 2, scoreB: 0 }));
    const r = eloRatings(games);
    expect(r.X - 1500).toBeCloseTo(1500 - r.Y, 9);
    expect(r.X).toBeGreaterThan(1550);
    // Indépendance du côté : les mêmes résultats avec les rôles a/b échangés donnent les mêmes ratings.
    const mirrored = eloRatings(games.map((g) => ({ a: g.b, b: g.a, scoreA: g.scoreB, scoreB: g.scoreA })));
    expect(mirrored.X).toBeCloseTo(r.X, 9);
    expect(mirrored.Y).toBeCloseTo(r.Y, 9);
    // Symétrie du résultat : si Y gagnait tout, Y aurait le rating de X.
    const inverted = eloRatings(games.map((g) => ({ ...g, scoreA: 0, scoreB: 2 })));
    expect(inverted.Y).toBeCloseTo(r.X, 9);
    const draws = eloRatings([{ a: 'P', b: 'Q', scoreA: 1, scoreB: 1 }], { passes: 3 });
    expect(draws.P).toBe(1500);
    expect(draws.Q).toBe(1500);
    const three = eloRatings([{ a: 'A', b: 'B', scoreA: 1, scoreB: 0 }, { a: 'B', b: 'C', scoreA: 1, scoreB: 0 }, { a: 'A', b: 'C', scoreA: 1, scoreB: 0 }], { passes: 5 });
    expect(three.A + three.B + three.C).toBeCloseTo(4500, 6);
    expect(three.A).toBeGreaterThan(three.B);
    expect(three.B).toBeGreaterThan(three.C);
  });

  it('formate les nombres à la française et les tableaux Markdown', () => {
    expect(fmt(3.14159, 2)).toBe('3,14');
    expect(fmt(-0.001, 2)).toBe('0,00');
    expect(fmt(NaN)).toBe('—');
    const t = mdTable(['Nom', 'Valeur'], [['a', 1.5], ['b', 2]]);
    expect(t.split('\n')).toEqual(['| Nom | Valeur |', '| :--- | ---: |', '| a | 1,50 |', '| b | 2 |']);
  });

  it('estime le danger des pertes à partir des événements', () => {
    const events: MatchEvent[] = [
      { time: 1, kind: 'turnover', team: 'A', pos: { x: -45, y: 0 } },
      { time: 2, kind: 'turnover', team: 'A', pos: { x: 40, y: 0 } },
      { time: 3, kind: 'turnover', team: 'B', value: 0.2 },
    ];
    const dA = turnoverDanger(events, 'A');
    expect(dA).toBeGreaterThan(0.2);
    expect(turnoverDanger(events, 'B')).toBeCloseTo(0.2);
    expect(turnoverDanger(events.slice(0, 1), 'A')).toBeGreaterThan(turnoverDanger(events.slice(1, 2), 'A'));
  });
});

// ---------------------------------------------------------------------------
// Optimiseurs
// ---------------------------------------------------------------------------
describe('optimisation (CEM, recherche aléatoire, (1+1)-ES)', () => {
  const c = [1, -2, 0.5, 3, -1];
  const sphere = (t: Float64Array): number => -t.reduce((s, x, i) => s + (x - c[i]) ** 2, 0);

  it('le CEM converge sur une sphère en dimension 5', async () => {
    const gens: number[] = [];
    const r = await cem({ dims: 5, mu0: [0, 0, 0, 0, 0], sigma0: [2, 2, 2, 2, 2], population: 32, elites: 8, generations: 30, minSigma: 1e-4, fitness: sphere, rng: new Rng(1), onGeneration: (g) => gens.push(g.generation) });
    expect(r.history.length).toBe(30);
    expect(gens).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(r.evaluations).toBe(32 * 30);
    for (let i = 0; i < 5; i++) expect(r.best[i]).toBeCloseTo(c[i], 2);
    expect(r.bestFitness).toBeGreaterThan(-1e-3);
    expect(r.history[29].meanFitness).toBeGreaterThan(r.history[0].meanFitness);
    expect(r.history[0].ci.low).toBeLessThanOrEqual(r.history[0].meanFitness);
    // Graines communes : la même liste de graines est fournie à toute la population d'une génération.
    const seen = new Map<number, string>();
    await cem({ dims: 1, mu0: [0], sigma0: [1], population: 4, elites: 2, generations: 2, fitness: (_t, g, seeds) => { const k = JSON.stringify(seeds); if (seen.has(g)) expect(seen.get(g)).toBe(k); seen.set(g, k); return 0; }, rng: new Rng(2) });
    expect(seen.get(0)).not.toBe(seen.get(1));
  });

  it('le CEM en espace log converge sur un Rosenbrock décalé (optimum (2, 2))', async () => {
    const rosen = (t: Float64Array): number => { const x = t[0] - 1, y = t[1] - 1; return -((1 - x) ** 2 + 100 * (y - x * x) ** 2); };
    const r = await cem({ dims: 2, mu0: [1.5, 1.5], sigma0: [0.5, 0.5], population: 100, elites: 10, generations: 100, minSigma: 0.01, logSpace: [true, true], fitness: rosen, rng: new Rng(3) });
    expect(r.best[0]).toBeCloseTo(2, 1);
    expect(r.best[1]).toBeCloseTo(2, 1);
    expect(r.bestFitness).toBeGreaterThan(-0.01);
    expect(r.best[0]).toBeGreaterThan(0); // positivité garantie par l'espace log
  });

  it('la recherche aléatoire et le (1+1)-ES exposent la même interface et améliorent la solution', async () => {
    const opts = { dims: 5, mu0: [0, 0, 0, 0, 0], sigma0: [1, 1, 1, 1, 1], population: 16, generations: 8, minSigma: 1e-4, fitness: sphere };
    const rs = await randomSearch({ ...opts, rng: new Rng(3) });
    const es = await onePlusOneEs({ ...opts, rng: new Rng(4) });
    for (const r of [rs, es]) {
      expect(r.history.length).toBe(8);
      expect(r.best.length).toBe(5);
      expect(r.mu.length).toBe(5);
      expect(r.sigma.length).toBe(5);
      expect(r.bestFitness).toBeGreaterThan(sphere(Float64Array.from([0, 0, 0, 0, 0])));
      expect(r.bestFitness).toBeCloseTo(sphere(r.best), 9);
    }
    expect(es.bestFitness).toBeGreaterThan(rs.bestFitness);
    expect(es.bestFitness).toBeGreaterThan(-0.05);
    expect(es.evaluations).toBe(8 * (16 + 1));
    // Déterminisme : même graine ⇒ même résultat.
    const rs2 = await randomSearch({ ...opts, rng: new Rng(3) });
    expect(Array.from(rs2.best)).toEqual(Array.from(rs.best));
  });

  it('correspondance vecteur ⇄ paramètres (aller-retour) et pool d’adversaires', () => {
    const v = paramsToVector(DEFAULT_PARAMS);
    expect(v.length).toBe(DEFAULT_OPTIM_PATHS.length);
    expect(v[0]).toBe(DEFAULT_PARAMS.decision.wProgress);
    const flat = vectorToFlat(v);
    expect(Array.from(flatToVector(flat))).toEqual(Array.from(v));
    const params = vectorToParams(v);
    expect(flattenParams(params)).toEqual(flattenParams(DEFAULT_PARAMS));
    const modified = Float64Array.from(v); modified[5] = 0.9;
    expect(vectorToParams(modified).decision.gamma).toBe(0.9);
    expect(vectorToParams(modified).decision.wProgress).toBe(DEFAULT_PARAMS.decision.wProgress);
    expect(defaultLogSpace().every((b) => b)).toBe(true);
    expect(defaultSigma0()[0]).toBeCloseTo(0.3 * DEFAULT_PARAMS.decision.wProgress);
    expect(() => flatToVector({})).toThrow(/paramètre absent/);
    const pool = new OpponentPool(3);
    for (let i = 0; i < 6; i++) pool.add({ 'decision.gamma': i });
    expect(pool.entries.length).toBe(4);
    expect(pool.entries[0]).toEqual({});
    expect(pool.entries[3]['decision.gamma']).toBe(5);
    const fit = makeMatchFitness({ matches: 4, minutes: 1, pool });
    const tasks = fit.tasks(v, [11, 12]);
    expect(tasks.length).toBe(4);
    expect(tasks[0].paramOverrides?.A).toEqual(flat);
    expect(tasks[1].paramOverrides?.B).toEqual(flat);
    expect(tasks[0].config.seed).not.toBe(tasks[2].config.seed);
  });
});

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------
describe('calibration', () => {
  it('le recalibrage de Platt réduit le score de Brier d’un échantillon mal calibré', () => {
    const rng = new Rng(21);
    const pairs: CalibrationPair[] = [];
    for (let i = 0; i < 3000; i++) {
      const p = rng.uniform(0.05, 0.95);
      // Vraie probabilité : sur-confiance systématique et biais (a = 0,5, b = −0,4).
      const logit = Math.log(p / (1 - p));
      const truth = 1 / (1 + Math.exp(-(0.5 * logit - 0.4)));
      pairs.push({ p, y: rng.bernoulli(truth) ? 1 : 0, kind: 'pass' });
    }
    const before = brierScore(pairs);
    const model = fitPlattScaling(pairs);
    expect(model.a).toBeCloseTo(0.5, 0);
    expect(model.b).toBeCloseTo(-0.4, 0);
    const after = brierScore(pairs.map((q) => ({ ...q, p: model.apply(q.p) })));
    expect(after).toBeLessThan(before - 0.01);
    const table = reliabilityTable(pairs);
    expect(table.length).toBe(10);
    expect(table.reduce((s, b) => s + b.count, 0)).toBe(3000);
    expect(table[8].meanPredicted).toBeGreaterThan(table[8].observed); // sur-confiance visible
    const rep = calibrationReport(pairs, 'test');
    expect(rep.after.brier).toBeLessThan(rep.before.brier);
    expect(rep.after.ece).toBeLessThan(rep.before.ece);
    expect(rep.markdown).toContain('Brier avant');
    // Échantillon déjà calibré : a ≈ 1, b ≈ 0.
    const good: CalibrationPair[] = [];
    for (let i = 0; i < 3000; i++) { const p = rng.uniform(0.05, 0.95); good.push({ p, y: rng.bernoulli(p) ? 1 : 0, kind: 'shot' }); }
    const m2 = fitPlattScaling(good);
    expect(m2.a).toBeCloseTo(1, 0);
    expect(Math.abs(m2.b)).toBeLessThan(0.2);
  });

  it('apparie les probabilités attendues aux issues dans un journal d’événements synthétique', () => {
    const eventLog: MatchEvent[] = [
      { time: 1.0, kind: 'pass', team: 'A', playerId: 3, value: 0.9 },
      { time: 1.1, kind: 'pass', team: 'B', playerId: 15, value: 0.4 },
      { time: 2.0, kind: 'pass_complete', team: 'A', playerId: 5 },
      { time: 2.5, kind: 'pass_intercepted', team: 'B', playerId: 15 },
      { time: 3.0, kind: 'shot', team: 'A', playerId: 9, value: 0.3 },
      { time: 3.5, kind: 'goal', team: 'A', playerId: 9 },
      { time: 8.0, kind: 'shot', team: 'B', playerId: 20, value: 0.1 },
    ];
    const r: MatchResult = { seed: 1, score: { A: 1, B: 0 }, stats: emptyStats(), durationSec: 10, wallMs: 1, eventLog };
    const s = collectCalibrationPairs([r]);
    expect(s.passes).toEqual([{ p: 0.9, y: 1, kind: 'pass' }, { p: 0.4, y: 0, kind: 'pass' }]);
    expect(s.shots).toEqual([{ p: 0.3, y: 1, kind: 'shot' }, { p: 0.1, y: 0, kind: 'shot' }]);
    // Les trajectoires avec expectedP ont priorité sur la valeur des événements.
    const r2: MatchResult = { ...r, flightLog: [{ kind: 'pass', kickerId: 3, targetId: 5, team: 'A', startTime: 1.0, expectedP: 0.7 }] };
    expect(collectCalibrationPairs([r2]).passes).toEqual([{ p: 0.7, y: 1, kind: 'pass' }]);
  });
});

// ---------------------------------------------------------------------------
// Pool de workers, arguments
// ---------------------------------------------------------------------------
describe('pool de workers et interface en ligne de commande', () => {
  it('runBatch exécute séquentiellement et se replie sans erreur si les workers échouent', async () => {
    const tasks = [1, 2, 3, 4, 5];
    const seq = await runBatch(tasks, (t) => t * t, { sequential: true });
    expect(seq).toEqual([1, 4, 9, 16, 25]);
    const progress: number[] = [];
    const asyncSeq = await runBatch(tasks, async (t) => t + 1, { sequential: true, onProgress: (d) => progress.push(d) });
    expect(asyncSeq).toEqual([2, 3, 4, 5, 6]);
    expect(progress).toEqual([1, 2, 3, 4, 5]);
    // Tâche inconnue côté worker (ou workers indisponibles) ⇒ repli sur fn, résultats identiques et ordonnés.
    const fallback = await runBatch(tasks, (t) => t * 10, { sequential: false, workers: 1, workerTask: 'tache_inexistante', probeTimeoutMs: 8000 });
    expect(fallback).toEqual([10, 20, 30, 40, 50]);
  }, 30000);

  it('analyse les arguments et les tactiques', () => {
    const a = parseArgs(['--seed', '7', '--quick', '--tacticA=4-4-2:counter', '--minutes', '-3', '--no-color', 'pos']);
    expect(numFlag(a, 'seed', 1)).toBe(7);
    expect(numFlag(a, 'minutes', 10)).toBe(-3);
    expect(boolFlag(a, 'quick')).toBe(true);
    expect(boolFlag(a, 'color', true)).toBe(false);
    expect(strFlag(a, 'tacticA', '')).toBe('4-4-2:counter');
    expect(numFlag(a, 'absent', 5)).toBe(5);
    expect(a.positional).toEqual(['pos']);
    const t = parseTactic('4-4-2:counter');
    expect(t.formation).toBe('4-4-2');
    expect(t.style).toBe('counter');
    expect(parseTactic('inconnu').formation).toBe('4-3-3');
    const cfg = makeConfig({ seed: 3, minutes: 2 });
    expect(cfg.durationSec).toBe(120);
    expect(cfg.params).toEqual(DEFAULT_PARAMS);
    expect(cfg.params).not.toBe(DEFAULT_PARAMS);
  });

  it('calcule l’aire d’une enveloppe convexe et la compacité de repli', () => {
    expect(convexHullArea([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }, { x: 2, y: 1 }])).toBeCloseTo(12);
    expect(convexHullArea([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(0);
    const st = buildFullState();
    const c = teamCompactness(st, 'A');
    expect(c.spanX).toBeGreaterThan(30);
    expect(c.hullArea).toBeGreaterThan(500);
  });
});

// ---------------------------------------------------------------------------
// Moteur (simulation seule, décision factice)
// ---------------------------------------------------------------------------
describe.skipIf(!simReady)(`exécution avec le moteur de simulation ${skipSim}`, () => {
  it('runMatch est déterministe (même graine ⇒ mêmes score, statistiques et événements) et remplit les KPI', () => {
    const cfg = makeConfig({ seed: 5, durationSec: 20 });
    const r1 = runMatch(cfg, undefined, { decide: makeDummyDecide(), collectEvents: true });
    const r2 = runMatch(cfg, undefined, { decide: makeDummyDecide(), collectEvents: true });
    expect(r1.score).toEqual(r2.score);
    // decisionMs est un temps de calcul (non déterministe par construction) : on l'exclut de la comparaison.
    const strip = (st: typeof r1.stats) => ({ A: { ...st.A, decisionMs: 0 }, B: { ...st.B, decisionMs: 0 } });
    expect(strip(r1.stats)).toEqual(strip(r2.stats));
    expect(r1.events).toBe(r2.events);
    expect(r1.eventLog!.map((e) => [e.time, e.kind, e.team])).toEqual(r2.eventLog!.map((e) => [e.time, e.kind, e.team]));
    expect(r1.durationSec).toBe(20);
    expect(r1.stats.A.decisions + r1.stats.B.decisions).toBeGreaterThan(0);
    expect(r1.latency!.count).toBe(r1.stats.A.decisions + r1.stats.B.decisions);
    expect(r1.latency!.cycles).toBeGreaterThan(50);
    expect(r1.latency!.p95).toBeGreaterThanOrEqual(r1.latency!.p50);
    expect(r1.kpi!.A.possessionShare + r1.kpi!.B.possessionShare).toBeCloseTo(1, 6);
    expect(r1.structure!.A.samples).toBeGreaterThanOrEqual(4);
    expect(r1.structure!.A.spanX).toBeGreaterThan(10);
    expect(r1.stability!.A.carrierSeconds + r1.stability!.B.carrierSeconds).toBeGreaterThan(0);
    const r3 = runMatch(makeConfig({ seed: 6, durationSec: 20 }), undefined, { decide: makeDummyDecide() });
    expect(stateHash({ ...buildFullState(), stats: r3.stats } as MatchState)).not.toBe(stateHash({ ...buildFullState(), stats: r1.stats } as MatchState));
  });

  it('loadStateInto charge un scénario dans une simulation vivante et runScenario capture la première décision', () => {
    const scenario = SCENARIOS.find((s) => s.id === 'one_v_one_keeper')!;
    const sim = createSimulation(makeConfig({ seed: 1, durationSec: 10 }));
    sim.advance(1, { decide: () => new Map() });
    loadStateInto(sim, scenario.build());
    expect(sim.state.ball.ownerId).toBe(scenario.protagonistId);
    expect(sim.state.restart).toBeNull();
    expect(sim.state.stats).toEqual(emptyStats());
    const ref = scenario.build();
    for (const p of ref.players) { const q = sim.state.players.find((x) => x.id === p.id)!; expect(q.pos).toEqual(p.pos); }
    const r1 = runScenario(scenario, undefined, 3, 4, { decide: makeDummyDecide() });
    const r2 = runScenario(scenario, undefined, 3, 4, { decide: makeDummyDecide() });
    expect(r1.decision).not.toBeNull();
    expect(r1.decision!.playerId).toBe(scenario.protagonistId);
    expect(r1.actionClass).toBe('shoot');
    expect(r1.acceptable).toBe(true);
    expect(r1.regret).toBe(0);
    expect(r1.kpis.value).toBe(r2.kpis.value);
    expect(r1.actionLabel).toBe(r2.actionLabel);
    expect(typeof r1.kpis.possessionKept).toBe('boolean');
  });

  it('le collecteur compte les changements d’intention et de cible', () => {
    const cfg = makeConfig({ seed: 2, durationSec: 6 });
    const seen: number[] = [];
    const r = runMatch(cfg, undefined, { decide: makeDummyDecide(), onDecisions: (d) => seen.push(d.size) });
    expect(seen.length).toBeGreaterThan(20);
    expect(r.stability!.A.targetChanges + r.stability!.B.targetChanges).toBeGreaterThan(0);
    const collector = createMatchCollector();
    expect(collector.eventLog).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Moteur complet (couche décision)
// ---------------------------------------------------------------------------
describe.skipIf(!engineReady)(`exécution avec l’algorithme de décision complet ${skipEngine}`, () => {
  it('runMatch avec l’algorithme complet est déterministe et produit des décisions', () => {
    const cfg = makeConfig({ seed: 11, durationSec: 30 });
    const r1 = runMatch(cfg), r2 = runMatch(cfg);
    expect(r1.score).toEqual(r2.score);
    // decisionMs est un temps de calcul (non déterministe par construction) : on l'exclut de la comparaison.
    const strip = (st: typeof r1.stats) => ({ A: { ...st.A, decisionMs: 0 }, B: { ...st.B, decisionMs: 0 } });
    expect(strip(r1.stats)).toEqual(strip(r2.stats));
    expect(r1.stats.A.decisions).toBeGreaterThan(0);
    expect(r1.latency!.p99).toBeGreaterThan(0);
  }, 60000);

  it('runScenario renvoie une décision du protagoniste, son acceptabilité et un regret ≥ 0', () => {
    const policy = resolvePolicy('full');
    for (const s of SCENARIOS.slice(0, 4)) {
      const r = runScenario(s, policy, 1, 3);
      expect(r.decision, s.id).not.toBeNull();
      expect(r.decision!.playerId).toBe(s.protagonistId);
      expect(r.actionClass).not.toBeNull();
      expect(typeof r.acceptable).toBe('boolean');
      expect(r.regret).toBeGreaterThanOrEqual(0);
      const again = runScenario(s, policy, 1, 3);
      expect(again.actionLabel).toBe(r.actionLabel);
    }
  }, 60000);
});
