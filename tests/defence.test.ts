/**
 * Tests de la défense coordonnée et du gardien (src/decision/defence.ts, keeper.ts ; docs/CONCEPTION.md §8) :
 * affectation hongroise sans doublon, pressing dépendant de la tactique (pressing haut / bloc bas), marquage côté but,
 * contre-pressing, optimalité vs affectation gloutonne, hystérésis, interception, symétrie miroir A/B,
 * bissectrice du gardien, sortie sur ballon libre, relance, tenue de ligne, vitesses de tâche, bloc tactique (simulation).
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_PARAMS } from '@/core/params';
import { Rng } from '@/core/rng';
import { buildState, type PlayerSpec } from '@/core/state-builder';
import { PITCH, ownGoalCentre, goalPosts, isInsidePitch } from '@/core/pitch';
import type { Decision, MatchState, TeamId } from '@/core/types';
import { attackDir } from '@/core/types';
import type { Vec2 } from '@/core/vec2';
import { angleBetween, dist, sub } from '@/core/vec2';
import { FORMATIONS } from '@/tactics/formations';
import { makeTactic } from '@/tactics/styles';
import { computeFields } from '@/models/fields';
import { createMatch, giveBall } from '@/engine/match';
import { decideDefence, generateTasks, pressingTrigger, taskCost, defenderInfo, outfieldDefenders, containDistance, previousTaskKey, taskSpeed, INFEASIBLE_COST } from '@/decision/defence';
import { teamSlot } from '@/decision/loose';
import { createSimulation } from '@/engine/loop';
import { decideKeeper, bisectorPosition } from '@/decision/keeper';
import type { DecisionInput } from '@/decision/policy';

const P = DEFAULT_PARAMS;
const v = (x: number, y: number): Vec2 => ({ x, y });
const mirror = (p: Vec2): Vec2 => ({ x: -p.x, y: -p.y });

/** Match réel : ballon à `ownerId` (placé en `ballPos`), les autres sur leurs postes, gel levé. */
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

const inputFor = (state: MatchState, team: TeamId): DecisionInput => {
  const fields = computeFields(state, P);
  state.fields = fields;
  return { state, fields, params: P, tactic: state.tactics[team], rng: new Rng(1) };
};

const move = (d: Decision) => (d.chosen.action.type === 'move' ? d.chosen.action : null);
const intents = (m: Map<number, Decision>, state: MatchState, team: TeamId): string[] =>
  state.players.filter((p) => p.team === team && p.role !== 'GK').map((p) => move(m.get(p.id)!)?.intent ?? 'none');

function symmetricSpecs(): PlayerSpec[] {
  const specs: PlayerSpec[] = [];
  const slots = FORMATIONS['4-3-3'].slots;
  for (const team of ['A', 'B'] as TeamId[]) {
    const dir = attackDir(team);
    slots.forEach((s, i) => {
      const jitter = ((i * 7) % 5) - 2;
      specs.push({ team, pos: v(dir * (s.x + jitter), dir * (s.y + jitter / 2)), role: s.role, number: i + 1, slotIndex: i });
    });
  }
  return specs;
}
const mirrorSpecs = (specs: PlayerSpec[]): PlayerSpec[] => specs.map((s) => ({ ...s, team: s.team === 'A' ? 'B' : 'A', pos: mirror(s.pos), vel: s.vel ? mirror(s.vel) : undefined }));

// ---------------------------------------------------------------------------
describe('defence — affectation', () => {
  it('11 décisions, aucune tâche en double (cibles distinctes, marquages uniques), cibles dans le terrain, score = Σ contributions', () => {
    const state = matchState(1, 6, v(10, -5), { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-4-2', 'high_press') });
    const out = decideDefence(inputFor(state, 'B'), 'B', new Map());
    expect(out.size).toBe(11);
    const targets: Vec2[] = [];
    const marks = new Set<number>();
    for (const p of state.players.filter((q) => q.team === 'B')) {
      const d = out.get(p.id)!;
      expect(d.playerId).toBe(p.id);
      const a = move(d);
      expect(a).not.toBeNull();
      expect(isInsidePitch(a!.target)).toBe(true);
      if (p.role === 'GK') { expect(a!.intent).toBe('gk_position'); continue; }
      if (a!.intent === 'mark') { expect(a!.markId).toBeDefined(); expect(marks.has(a!.markId!)).toBe(false); marks.add(a!.markId!); }
      for (const t of targets) expect(dist(t, a!.target)).toBeGreaterThan(0.5);
      targets.push(a!.target);
      for (const c of d.candidates) expect(Math.abs(c.score - c.components.reduce((s, x) => s + x.contribution, 0))).toBeLessThan(1e-9);
      for (let i = 1; i < d.candidates.length; i++) expect(d.candidates[i - 1].score).toBeGreaterThanOrEqual(d.candidates[i].score);
      expect(d.candidates[0].score - d.chosen.score).toBeLessThan(1e-9); // regret nul pour l'affectation optimale (composante de coordination)
      expect(d.candidates.length).toBeGreaterThanOrEqual(3);
      expect(d.explanation.split('\n').length).toBeGreaterThanOrEqual(3);
      expect(d.explanation).toMatch(/^Tâche : /);
    }
  });

  it('l’affectation hongroise ne coûte jamais plus que l’affectation gloutonne (baseline nearest_man)', () => {
    let strictlyBetter = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const state = matchState(seed, 5 + (seed % 5), v(-20 + seed * 8, (seed % 3) * 9 - 9), { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-4-2', 'high_press') });
      const input = inputFor(state, 'B');
      const defenders = outfieldDefenders(state, 'B');
      const { tasks, info, nearestToBall } = generateTasks(input, 'B', defenders);
      const total = (m: Map<number, Decision>): number => {
        let s = 0;
        for (const d of defenders) {
          const a = move(m.get(d.id)!)!;
          const di = defenderInfo(input, 'B', d, new Map(), info, nearestToBall);
          // La tâche est identifiée par son point (`successPoint`, la cible d'action pouvant être la position tenue sur place).
          const point = m.get(d.id)!.chosen.successPoint!;
          const t = tasks.find((x) => dist(x.point, point) < 1e-6 && (x.kind !== 'mark' || x.markId === a.markId))!;
          expect(t).toBeDefined();
          s += taskCost(input, 'B', d, di, t).cost;
        }
        return s;
      };
      const hung = total(decideDefence(input, 'B', new Map()));
      const greedy = total(decideDefence(input, 'B', new Map(), { greedy: true }));
      expect(hung).toBeLessThanOrEqual(greedy + 1e-9);
      expect(hung).toBeLessThan(INFEASIBLE_COST);
      if (hung < greedy - 1e-6) strictlyBetter++;
    }
    expect(strictlyBetter).toBeGreaterThan(0);
  });

  it('hystérésis : à état inchangé, le cycle suivant conserve l’affectation ; le candidat « même tâche » n’a pas la pénalité ξ', () => {
    const state = matchState(7, 6, v(0, 0), { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-4-2', 'balanced') });
    const input = inputFor(state, 'B');
    const first = decideDefence(input, 'B', new Map());
    state.time += P.decisionPeriod;
    const second = decideDefence(input, 'B', first);
    for (const p of state.players.filter((q) => q.team === 'B' && q.role !== 'GK')) {
      const a = move(first.get(p.id)!)!, b = move(second.get(p.id)!)!;
      expect(b.intent).toBe(a.intent);
      expect(dist(a.target, b.target)).toBeLessThan(1e-6);
      expect(second.get(p.id)!.chosen.components.find((c) => c.key === 'hysteresis')!.contribution).toBeCloseTo(0, 12);
      expect(first.get(p.id)!.chosen.components.find((c) => c.key === 'hysteresis')!.contribution).toBeCloseTo(-P.defence.xiHysteresis, 12);
    }
  });

  it('symétrie miroir A/B : intentions identiques et cibles miroir', () => {
    const specs = symmetricSpecs();
    const tactics = { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-3-3', 'balanced') };
    const state = buildState({ players: specs, ball: { pos: specs[6].pos, ownerId: 6 }, tactics });
    const ms = mirrorSpecs(specs);
    const mirrored = buildState({ players: ms, ball: { pos: ms[6].pos, ownerId: 6 }, tactics });
    const dB = decideDefence(inputFor(state, 'B'), 'B', new Map());
    const dA = decideDefence(inputFor(mirrored, 'A'), 'A', new Map());
    for (let i = 11; i < 22; i++) {
      const a = move(dB.get(i)!)!, b = move(dA.get(i)!)!;
      expect(b.intent).toBe(a.intent);
      expect(b.markId).toBe(a.markId);
      if (a.intent === 'zone') continue; // cellules de la grille (nœuds x = −52,5 + 2i) : la grille n'est pas symétrique, seule l'intention est comparée
      expect(b.target.x).toBeCloseTo(-a.target.x, 3);
      expect(b.target.y).toBeCloseTo(-a.target.y, 3);
    }
  });
});

// ---------------------------------------------------------------------------
describe('defence — pressing et marquage tactiques', () => {
  it('pressing haut : 2 presseurs sur le porteur dans la moitié adverse, dont l’un des 3 défenseurs les plus proches', () => {
    const state = matchState(2, 6, v(-5, 0), { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-4-2', 'high_press') });
    const input = inputFor(state, 'B');
    const info = pressingTrigger(input, 'B', outfieldDefenders(state, 'B'), null);
    expect(info.pressing).toBe(true);
    expect(info.nPress).toBe(2);
    expect(info.triggersActive).toContain('ballon dans la zone de pressing');
    const out = decideDefence(input, 'B', new Map());
    const pressers = state.players.filter((p) => p.team === 'B' && move(out.get(p.id)!)?.intent === 'press');
    expect(pressers).toHaveLength(2);
    for (const p of pressers) {
      const a = move(out.get(p.id)!)!;
      expect(dist(a.target, state.ball.pos)).toBeLessThan(3);
      expect(a.speed).toBeCloseTo(p.maxSpeed, 9);
    }
    const byDist = state.players.filter((p) => p.team === 'B' && p.role !== 'GK').sort((a, b) => dist(a.pos, state.ball.pos) - dist(b.pos, state.ball.pos)).slice(0, 3).map((p) => p.id);
    expect(pressers.some((p) => byDist.includes(p.id))).toBe(true);
    expect(out.get(pressers[0].id)!.explanation).toMatch(/Pressing déclenché/);
  });

  it('bloc bas : aucun presseur quand le ballon est dans la moitié adverse ; un défenseur contient le porteur côté but', () => {
    const state = matchState(3, 6, v(-15, 4), { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-4-2', 'low_block') });
    state.players[17].pos = { x: -13, y: 4 }; // un milieu B à 2 m côté but du porteur : il le contient, les autres tiennent le bloc (bas, §9.2)
    const input = inputFor(state, 'B');
    const info = pressingTrigger(input, 'B', outfieldDefenders(state, 'B'), null);
    expect(info.pressing).toBe(false);
    expect(info.triggersActive).not.toContain('ballon dans la zone de pressing');
    const out = decideDefence(input, 'B', new Map());
    const its = intents(out, state, 'B');
    expect(its).not.toContain('press');
    const contain = state.players.filter((p) => p.team === 'B' && move(out.get(p.id)!)?.intent === 'cover');
    expect(contain).toHaveLength(1);
    const t = move(out.get(contain[0].id)!)!.target;
    // Distance de contain modulée par pressIntensity : un bloc bas contient de plus loin qu'un pressing haut.
    const lowBlock = containDistance(P.defence, state.tactics.B.params.pressIntensity);
    expect(dist(t, state.ball.pos)).toBeCloseTo(lowBlock, 6);
    expect(lowBlock).toBeGreaterThan(containDistance(P.defence, makeTactic('4-4-2', 'high_press').params.pressIntensity) + 1);
    expect(containDistance(P.defence, 1)).toBeCloseTo(P.defence.containOffset, 9);
    expect(dist(t, ownGoalCentre(attackDir('B')))).toBeLessThan(dist(state.ball.pos, ownGoalCentre(attackDir('B'))));
    expect(its.filter((i) => i === 'recover').length).toBeGreaterThanOrEqual(3); // le bloc tient sa forme
    expect(out.get(contain[0].id)!.explanation).toMatch(/Bloc en place/);
  });

  it('bloc bas : pressing déclenché quand le ballon est profond dans son camp avec un défenseur à portée', () => {
    const state = matchState(4, 6, v(38, 0), { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-4-2', 'low_block') });
    state.players[17].pos = { x: 39, y: 0.5 }; // un défenseur B à portée (τ_P < τ_trig)
    const input = inputFor(state, 'B');
    const info = pressingTrigger(input, 'B', outfieldDefenders(state, 'B'), null);
    expect(info.triggersActive).toContain('ballon dans la zone de pressing');
    expect(info.triggersActive).toContain('porteur à portée');
    expect(info.pressing).toBe(true);
    expect(info.nPress).toBe(1);
    const out = decideDefence(input, 'B', new Map());
    expect(intents(out, state, 'B').filter((i) => i === 'press')).toHaveLength(1);
  });

  it('marquage : les cibles sont côté but de l’attaquant marqué, n_mark = 2 + ⌊4·markingTightness⌋ borné', () => {
    for (const style of ['high_press', 'possession'] as const) {
      const state = matchState(5, 6, v(15, 0), { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-4-2', style) });
      // Géométrie pure du marquage : tenue de ligne désactivée (testée séparément).
      const input = { ...inputFor(state, 'B'), params: { ...P, defence: { ...P.defence, lineHoldSlack: 100 } } };
      const out = decideDefence(input, 'B', new Map());
      const ownGoal = ownGoalCentre(attackDir('B'));
      const marks = state.players.filter((p) => p.team === 'B' && move(out.get(p.id)!)?.intent === 'mark');
      for (const p of marks) {
        const a = move(out.get(p.id)!)!;
        const marked = state.players[a.markId!];
        expect(marked.team).toBe('A');
        expect(marked.id).not.toBe(6);
        expect(dist(a.target, ownGoal)).toBeLessThan(dist(marked.pos, ownGoal));
        expect(dist(a.target, marked.pos)).toBeLessThan(6);
      }
      const nMark = Math.min(P.defence.maxMarkTasks, 2 + Math.floor(4 * state.tactics.B.params.markingTightness));
      const { tasks } = generateTasks(input, 'B', outfieldDefenders(state, 'B'));
      expect(tasks.filter((t) => t.kind === 'mark').length).toBeLessThanOrEqual(nMark);
      expect(tasks.filter((t) => t.kind === 'mark').length).toBeGreaterThanOrEqual(2);
      // Priorités de marquage décroissantes avec le danger, dans [0, 1]
      const prios = tasks.filter((t) => t.kind === 'mark').map((t) => t.priority);
      expect(Math.max(...prios)).toBeCloseTo(1, 9);
      for (let i = 1; i < prios.length; i++) expect(prios[i - 1]).toBeGreaterThanOrEqual(prios[i]);
    }
  });

  it('contre-pressing : dans la fenêtre après la perte, ≥ 2 presseurs + couverture ; hors fenêtre, retour au déclencheur ordinaire', () => {
    const tactics = { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-4-2', 'counter') }; // contre : fenêtre 2 s, pressTriggerCount 3
    const state = matchState(6, 6, v(-10, 0), tactics);
    state.time = 30;
    state.phase.B = 'transition_defence';
    state.phaseSince.B = 29.5;
    const input = inputFor(state, 'B');
    const info = pressingTrigger(input, 'B', outfieldDefenders(state, 'B'), null);
    expect(info.counterPress).toBe(true);
    expect(info.pressing).toBe(true);
    expect(info.nPress).toBeGreaterThanOrEqual(2);
    const out = decideDefence(input, 'B', new Map());
    const its = intents(out, state, 'B');
    expect(its.filter((i) => i === 'press').length).toBe(2);
    expect(its.filter((i) => i === 'cover').length).toBe(1);
    const near = state.players.filter((p) => p.team === 'B' && p.role !== 'GK').sort((a, b) => dist(a.pos, state.ball.pos) - dist(b.pos, state.ball.pos)).slice(0, 3);
    const busy = near.filter((p) => ['press', 'cover'].includes(move(out.get(p.id)!)!.intent));
    expect(busy.length).toBeGreaterThanOrEqual(2);
    expect(out.get(busy[0].id)!.chosen.components.find((c) => c.key === 'counterPress')!.contribution).toBeGreaterThan(0);
    expect(out.get(busy[0].id)!.explanation).toMatch(/Contre-pressing/);
    // Hors fenêtre
    state.phaseSince.B = 20;
    const later = pressingTrigger(inputFor(state, 'B'), 'B', outfieldDefenders(state, 'B'), null);
    expect(later.counterPress).toBe(false);
    expect(later.pressing).toBe(false);
  });

  it('porteur bloqué (§15.3) : possession continue > pressHoldTime sans solution de passe ⇒ pressing forcé, même en bloc bas (n_trig = 3) ; pas sous le délai, avec une passe sûre, ni si désactivé', () => {
    const state = matchState(13, 6, v(-8, 6), { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-4-2', 'low_block') });
    const input = inputFor(state, 'B');
    const defenders = outfieldDefenders(state, 'B');
    const hold = P.defence.pressHoldTime!;
    // Ballon frais (giveBall pose lastControlTime = maintenant) : le déclencheur ordinaire seul (bloc bas : pas de pressing).
    const fresh = pressingTrigger(input, 'B', defenders, 0.5);
    expect(fresh.stuck).toBe(false);
    expect(fresh.heldFor).toBeCloseTo(0, 9);
    expect(fresh.pressing).toBe(false);
    // Le porteur garde le ballon depuis plus de pressHoldTime s sans passe à P ≥ pressHoldPass : pressing forcé.
    state.players[6].lastControlTime = state.time - hold - 1;
    const stuck = pressingTrigger(input, 'B', defenders, 0.5);
    expect(stuck.stuck).toBe(true);
    expect(stuck.heldFor).toBeCloseTo(hold + 1, 9);
    expect(stuck.pressing).toBe(true);
    expect(stuck.nPress).toBeGreaterThanOrEqual(1);
    expect(stuck.triggersActive.some((t) => /porteur bloqué/.test(t))).toBe(true);
    // Décision collective : `decideDefence` mesure lui-même la meilleure passe adverse ; avec pressHoldPass > 1 toute passe
    // est « incertaine » et le pressing forcé se traduit par un presseur, expliqué comme tel.
    const forced = { ...input, params: { ...P, defence: { ...P.defence, pressHoldPass: 1.01 } } };
    const out = decideDefence(forced, 'B', new Map());
    const pressers = state.players.filter((p) => p.team === 'B' && move(out.get(p.id)!)?.intent === 'press');
    expect(pressers.length).toBe(stuck.nPress);
    expect(out.get(pressers[0].id)!.explanation).toMatch(/porteur bloqué/);
    expect(intents(decideDefence(input, 'B', new Map()), state, 'B').filter((i) => i === 'press').length).toBeLessThanOrEqual(stuck.nPress);
    // Passe sûre disponible (max P ≥ pressHoldPass) : le porteur n'est pas « bloqué ».
    expect(pressingTrigger(input, 'B', defenders, P.defence.pressHoldPass!).stuck).toBe(false);
    // Juste sous le délai : rien.
    state.players[6].lastControlTime = state.time - hold + 0.1;
    expect(pressingTrigger(input, 'B', defenders, 0.5).stuck).toBe(false);
    // Désactivé (pressHoldTime ≤ 0).
    state.players[6].lastControlTime = state.time - 30;
    const off = { ...input, params: { ...P, defence: { ...P.defence, pressHoldTime: 0 } } };
    expect(pressingTrigger(off, 'B', defenders, 0.5).stuck).toBe(false);
  });

  it('passe adverse en cours : un défenseur qui arrive avant le ballon reçoit une tâche d’interception', () => {
    const state = matchState(8, 6, v(0, 0), { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-4-2', 'balanced') });
    const ball = state.ball;
    ball.ownerId = null;
    ball.pos = { x: 2, y: 0 };
    ball.vel = { x: 8, y: 0 };
    ball.flight = { kind: 'pass', kickerId: 6, targetId: 9, targetPoint: { x: 30, y: 0 }, origin: { x: 0, y: 0 }, startTime: state.time, initialSpeed: 10 };
    state.players[9].pos = { x: 30, y: 0 };
    state.players[16].pos = { x: 16, y: 1.5 }; // défenseur B sur la ligne de passe
    const input = inputFor(state, 'B');
    const { tasks } = generateTasks(input, 'B', outfieldDefenders(state, 'B'));
    const inter = tasks.filter((t) => t.kind === 'intercept');
    expect(inter.length).toBeGreaterThanOrEqual(1);
    expect(tasks.some((t) => t.kind === 'chase')).toBe(true);
    const out = decideDefence(input, 'B', new Map());
    const a = move(out.get(16)!)!;
    expect(['intercept', 'chase']).toContain(a.intent);
    expect(Math.abs(a.target.y)).toBeLessThan(1e-6);
    expect(a.target.x).toBeGreaterThan(ball.pos.x);
  });
});

// ---------------------------------------------------------------------------
describe('keeper — placement, sortie, relance', () => {
  it('adversaire en possession : le gardien se place sur la bissectrice de l’angle de tir, profondeur min(5,5 ; 0,2·d), dans la surface de but', () => {
    for (const [team, ballPos] of [['A', v(-25, 12)], ['B', v(20, -30)], ['A', v(-45, 3)]] as [TeamId, Vec2][]) {
      const opp: TeamId = team === 'A' ? 'B' : 'A';
      const state = matchState(9, opp === 'A' ? 9 : 20, ballPos);
      const gk = state.players.find((p) => p.team === team && p.role === 'GK')!;
      const d = decideKeeper(inputFor(state, team), gk.id, null);
      const a = move(d)!;
      expect(a.intent).toBe('gk_position');
      const dir = attackDir(team);
      const ownGoal = ownGoalCentre(dir);
      const depth = Math.min(P.defence.keeperMaxDepth, P.defence.keeperDepthFactor * dist(ballPos, ownGoal));
      expect(dir * (a.target.x - ownGoal.x)).toBeCloseTo(depth, 6);
      expect(Math.abs(a.target.y)).toBeLessThanOrEqual(PITCH.goalAreaHalfWidth + 1e-9);
      const [p1, p2] = goalPosts((-dir) as 1 | -1);
      const u = sub(a.target, ballPos);
      expect(angleBetween(u, sub(p1, ballPos))).toBeCloseTo(angleBetween(u, sub(p2, ballPos)), 6);
      expect(d.explanation).toMatch(/Bissectrice/);
    }
    // Symétrie de la bissectrice
    const qa = bisectorPosition(v(-25, 12), 'A', 5), qb = bisectorPosition(v(25, -12), 'B', 5);
    expect(qb.x).toBeCloseTo(-qa.x, 9);
    expect(qb.y).toBeCloseTo(-qa.y, 9);
  });

  it('équipe en possession : appui à 8 m de sa ligne dans l’axe', () => {
    const state = matchState(10, 6, v(0, 0));
    const d = decideKeeper(inputFor(state, 'A'), 0, null);
    const a = move(d)!;
    expect(a.intent).toBe('gk_position');
    expect(a.target.x).toBeCloseTo(-PITCH.halfLength + 8, 9);
    expect(a.target.y).toBeCloseTo(0, 9);
  });

  it('ballon libre dans sa surface et gardien premier dessus : sortie (« chase »)', () => {
    const state = matchState(11, 20, v(10, 0));
    const ball = state.ball;
    ball.ownerId = null;
    ball.pos = { x: -44, y: 3 };
    ball.vel = { x: -2, y: 0 };
    ball.flight = null;
    state.possession = 'B';
    for (const p of state.players) if (p.team === 'B') p.pos = { x: 20 + (p.id % 5) * 3, y: -20 + (p.id % 11) * 4 };
    state.players[0].pos = { x: -50, y: 0 };
    const d = decideKeeper(inputFor(state, 'A'), 0, null);
    const a = move(d)!;
    expect(a.intent).toBe('chase');
    expect(dist(a.target, ball.pos)).toBeLessThan(4);
  });

  it('relance : passe vers un défenseur ou long ballon, choix par probabilité × menace, candidats triés, sans sortie de surface', () => {
    const state = matchState(12, 0, v(-46, 0));
    const d = decideKeeper(inputFor(state, 'A'), 0, null);
    expect(d.chosen.action.type).toBe('pass');
    expect(d.candidates.length).toBeGreaterThanOrEqual(3);
    expect(d.candidates.length).toBeLessThanOrEqual(4);
    for (let i = 1; i < d.candidates.length; i++) expect(d.candidates[i - 1].score).toBeGreaterThanOrEqual(d.candidates[i].score);
    for (const c of d.candidates) {
      expect(c.action.type).toBe('pass');
      expect(c.score).toBeCloseTo(c.probability * c.valueIfSuccess, 9);
      const a = c.action as Extract<typeof c.action, { type: 'pass' }>;
      const receiver = state.players[a.targetId];
      expect(receiver.team).toBe('A');
      expect(receiver.role === 'DF' || a.kind === 'lob').toBe(true);
    }
    expect(d.candidates.filter((c) => (c.action as { kind?: string }).kind === 'lob')).toHaveLength(1);
    expect(d.explanation).toMatch(/^Relance/);
    expect(d.explanation).toMatch(/ne quitte jamais sa surface/);
  });
});

// ---------------------------------------------------------------------------
describe('defence — tenue de ligne, vitesses de tâche, bloc tactique', () => {
  /** Ligne du bloc de `team` (repère équipe) : poste instancié le plus bas des joueurs de champ. */
  const blockLine = (state: MatchState, team: TeamId): number => {
    const dir = attackDir(team);
    return Math.min(...outfieldDefenders(state, team).map((d) => dir * teamSlot(state, d).x));
  };

  it('tenue de ligne (§8.4) : les points de marquage et de zone ne descendent pas sous la ligne du bloc − lineHoldSlack ; sans tenue, le marqueur suit l’attaquant', () => {
    const state = matchState(21, 6, v(0, 0));
    // Deux attaquants A très profonds, derrière la ligne du bloc B (ils sont hors-jeu : on les laisse à la ligne).
    state.players[9].pos = { x: 34, y: -6 };
    state.players[10].pos = { x: 34, y: 6 };
    const dir = attackDir('B');
    const line = blockLine(state, 'B');
    expect(dir * 34).toBeLessThan(line - 5); // les attaquants sont bien derrière la ligne (repère B : plus petit = plus proche du but B)
    const held = generateTasks(inputFor(state, 'B'), 'B', outfieldDefenders(state, 'B')).tasks;
    const floor = line - P.defence.lineHoldSlack!;
    for (const t of held) if (t.kind === 'mark' || t.kind === 'zone') expect(dir * t.point.x).toBeGreaterThanOrEqual(floor - 1e-9);
    const deepMarks = held.filter((t) => t.kind === 'mark' && (t.markId === 9 || t.markId === 10));
    expect(deepMarks.length).toBeGreaterThanOrEqual(1);
    for (const t of deepMarks) {
      expect(dir * t.point.x).toBeCloseTo(floor, 6); // marqué sur la ligne, à sa hauteur
      expect(Math.abs(t.point.y - state.players[t.markId!].pos.y)).toBeLessThan(3);
    }
    // Sans tenue de ligne (lineHoldSlack ≥ 100) : le point de marquage est côté but de l'attaquant, donc plus profond que la ligne.
    const free = generateTasks({ ...inputFor(state, 'B'), params: { ...P, defence: { ...P.defence, lineHoldSlack: 100 } } }, 'B', outfieldDefenders(state, 'B')).tasks;
    const freeMarks = free.filter((t) => t.kind === 'mark' && (t.markId === 9 || t.markId === 10));
    expect(freeMarks.length).toBeGreaterThanOrEqual(1);
    for (const t of freeMarks) expect(dir * t.point.x).toBeLessThan(floor - 5);
  });

  it('vitesses de tâche : zone et repli calmes près de leur point et au sprint au-delà de 20 m ; marquage 0,45 + 0,3·priorité ; contain 0,7', () => {
    const state = matchState(22, 6, v(0, 0));
    const d = outfieldDefenders(state, 'B')[0];
    const ts = P.defence.taskSpeed!;
    const near = (kind: 'recover' | 'zone') => ({ kind, point: { x: d.pos.x + 2, y: d.pos.y }, priority: 0, key: 'k', label: '' } as const);
    const far = (kind: 'recover' | 'zone') => ({ kind, point: { x: d.pos.x + 30, y: d.pos.y }, priority: 0, key: 'k', label: '' } as const);
    const rp = 0.5;
    expect(taskSpeed(near('recover'), d, rp, P.defence)).toBeCloseTo(d.maxSpeed * (ts.recoverBase + ts.recoverGain * rp), 9);
    expect(taskSpeed(far('recover'), d, rp, P.defence)).toBeCloseTo(d.maxSpeed, 9);
    expect(taskSpeed(near('zone'), d, rp, P.defence)).toBeCloseTo(d.maxSpeed * ts.zone, 9);
    expect(taskSpeed(far('zone'), d, rp, P.defence)).toBeCloseTo(d.maxSpeed, 9);
    const mid = { kind: 'recover' as const, point: { x: d.pos.x + 13, y: d.pos.y }, priority: 0, key: 'k', label: '' };
    const base = ts.recoverBase + ts.recoverGain * rp;
    expect(taskSpeed(mid, d, rp, P.defence)).toBeCloseTo(d.maxSpeed * (base + (1 - base) * 0.5), 6);
    expect(taskSpeed({ kind: 'mark', point: far('zone').point, priority: 1, key: 'k', label: '' }, d, rp, P.defence)).toBeCloseTo(d.maxSpeed * Math.min(1, ts.markBase + ts.markGain), 9);
    expect(taskSpeed({ kind: 'contain', point: far('zone').point, priority: 0.5, key: 'k', label: '' }, d, rp, P.defence)).toBeCloseTo(d.maxSpeed * ts.contain, 9);
    expect(taskSpeed({ kind: 'press', point: far('zone').point, priority: 1, key: 'k', label: '' }, d, rp, P.defence)).toBeCloseTo(d.maxSpeed, 9);
  });

  it('zone tenue sur place : la clé de tâche précédente vient du point de la tâche (successPoint), pas de la position tenue', () => {
    const base: Decision = { playerId: 15, time: 0, chosen: { action: { type: 'move', target: { x: 10, y: 4 }, intent: 'zone', speed: 3 }, score: 0, probability: 1, valueIfSuccess: 0, valueIfFailure: 0, components: [], reason: '', successPoint: { x: 30, y: -20 } }, candidates: [], context: { phase: 'defence', style: 'balanced', formation: '4-4-2', pressure: 0, availableTeammates: 0, localSuperiority: 0 }, explanation: '', computeMs: 0 };
    const atPoint: Decision = { ...base, chosen: { ...base.chosen, action: { type: 'move', target: { x: 30, y: -20 }, intent: 'zone', speed: 3 }, successPoint: undefined } };
    expect(previousTaskKey(base, 15)).toBe(previousTaskKey(atPoint, 15));
    expect(previousTaskKey(base, 15)).toMatch(/^zone:/);
  });

  it('bloc tactique (simulation 3 × 120 s) : la ligne défensive d’un pressing haut est nettement plus haute que celle d’un bloc bas, et proche de son poste', () => {
    // Trois graines : sur 120 s, la hauteur mesurée dépend surtout de la position du ballon pendant les rares phases
    // défensives du pressing haut (une graine isolée peut donner un écart de 3 m comme de 25 m) ; la moyenne sur
    // trois matchs courts mesure l’effet tactique et non la trajectoire.
    const line: Record<TeamId, number[]> = { A: [], B: [] };
    const lag: Record<TeamId, number[]> = { A: [], B: [] };
    for (const seed of [21, 22, 23]) {
      const cfg = { seed, tactics: { A: makeTactic('4-3-3', 'high_press'), B: makeTactic('4-4-2', 'low_block') }, params: P, durationSec: 120 };
      const sim = createSimulation(cfg);
      sim.advance(120, {
        onDecisions: (_d, s) => {
          for (const team of ['A', 'B'] as TeamId[]) {
            if (!s.possession || s.possession === team) continue;
            const dir = attackDir(team);
            const dfs = s.players.filter((p) => p.team === team && p.role === 'DF');
            const h = dfs.reduce((acc, p) => acc + dir * p.pos.x, 0) / dfs.length;
            const slot = dfs.reduce((acc, p) => acc + dir * teamSlot(s, p).x, 0) / dfs.length;
            line[team].push(h);
            lag[team].push(slot - h);
          }
        },
      });
    }
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(line.A.length).toBeGreaterThan(150);
    expect(line.B.length).toBeGreaterThan(150);
    console.log(`ligne défensive (repère équipe) : pressing haut ${mean(line.A).toFixed(1)} m (retard sur le poste ${mean(lag.A).toFixed(1)} m), bloc bas ${mean(line.B).toFixed(1)} m (retard ${mean(lag.B).toFixed(1)} m)`);
    expect(mean(line.A)).toBeGreaterThan(mean(line.B) + 4);
    // Les défenseurs suivent leur ligne (tenue de ligne + repli accéléré) ; le retard restant est transitoire (remontée après un dégagement).
    expect(mean(lag.A)).toBeLessThan(15);
    expect(mean(lag.B)).toBeLessThan(8);
  });
});
