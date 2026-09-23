/**
 * Tests de la décision du porteur (src/decision/onball, evaluate, candidates, explain) :
 * décomposition additive exacte, propriétés de classement (coéquipier libre vs marqué, ligne fermée),
 * choix attendus sur des situations construites (tir ouvert, impasse, dilemme tactique), hystérésis,
 * déterminisme, réponse quantale, bornes du lookahead, symétrie miroir A/B, explications, performance.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_PARAMS, cloneParams } from '@/core/params';
import { buildState, buildFullState, type PlayerSpec } from '@/core/state-builder';
import { Rng } from '@/core/rng';
import { PITCH, isInsidePitch } from '@/core/pitch';
import type { Candidate, Decision, MatchState, SimParams, StyleId, TeamId } from '@/core/types';
import type { Vec2 } from '@/core/vec2';
import { computeFields } from '@/models/fields';
import { isOffsidePosition } from '@/models/structure';
import { makeTactic } from '@/tactics/styles';
import type { DecisionInput } from '@/decision/policy';
import { decideOnBall, evaluateCandidates, selectCandidate, sameAction } from '@/decision/onball';
import { modulatedWeights } from '@/decision/evaluate';
import { actionLabel, explainDecision, whyNot, directionLabel } from '@/decision/explain';

const P: SimParams = DEFAULT_PARAMS;
const v = (x: number, y: number): Vec2 => ({ x, y });
const mirror = (p: Vec2): Vec2 => ({ x: -p.x, y: -p.y });

/** Paramètres déterministes (argmax pur). */
const P0: SimParams = cloneParams(P);
P0.decision.softmaxTemperature = 0;

/** État « équipe A attaque vers +x » : le porteur est le joueur `ownerId` (rôle MF sauf mention). */
function simple(players: PlayerSpec[], ownerId = 0, style: StyleId = 'balanced'): MatchState {
  const specs = players.map((p) => ({ ...p, role: p.role ?? 'MF' }));
  return buildState({
    players: specs,
    ball: { pos: specs[ownerId].pos, ownerId },
    tactics: { A: makeTactic('4-3-3', style), B: makeTactic('4-4-2', style) },
  });
}

function mkInput(state: MatchState, seed = 1, params: SimParams = P0): DecisionInput {
  const owner = state.players[state.ball.ownerId ?? 0];
  return { state, fields: computeFields(state, params), params, tactic: state.tactics[owner.team], rng: new Rng(seed) };
}

const sumContrib = (c: Candidate): number => c.components.reduce((s, k) => s + k.contribution, 0);
const isPass = (c: Candidate, kind: 'ground' | 'through' | 'lob', targetId?: number): boolean =>
  c.action.type === 'pass' && c.action.kind === kind && (targetId === undefined || c.action.targetId === targetId);

/** Ligne défensive B standard : gardien + deux défenseurs profonds (les coéquipiers restent en jeu). */
const B_LINE: PlayerSpec[] = [
  { team: 'B', pos: v(52, 0), role: 'GK' },
  { team: 'B', pos: v(40, 15) },
  { team: 'B', pos: v(40, -15) },
];

/** État complet 11 contre 11, porteur = milieu gauche de A (id 6). */
const fullState = (): MatchState => buildFullState({ ownerId: 6, ballPos: v(-6, -12) });

// ---------------------------------------------------------------------------
describe('décomposition additive et structure des candidats', () => {
  it('Σ contributions = score pour tous les candidats (évaluation simple, lookahead, hystérésis)', () => {
    const state = fullState();
    const input = mkInput(state, 3, P);
    for (const c of evaluateCandidates(input, 6)) expect(Math.abs(sumContrib(c) - c.score)).toBeLessThan(1e-6);
    const d1 = decideOnBall(input, 6, null);
    for (const c of d1.candidates) expect(Math.abs(sumContrib(c) - c.score)).toBeLessThan(1e-6);
    const d2 = decideOnBall(mkInput(state, 3, P), 6, d1);
    for (const c of d2.candidates) expect(Math.abs(sumContrib(c) - c.score)).toBeLessThan(1e-6);
    // Les composantes de lookahead et d'hystérésis existent bien dans la décision complète.
    expect(d1.candidates.slice(0, P.decision.topK).some((c) => c.components.some((k) => k.key === 'lookahead'))).toBe(true);
    expect(d2.candidates.some((c) => c.components.some((k) => k.key === 'hysteresis'))).toBe(true);
  });

  it('candidats triés par score décroissant, action choisie présente, probabilités dans [0,1], raisons non vides', () => {
    const d = decideOnBall(mkInput(fullState(), 5, P), 6, null);
    expect(d.candidates.includes(d.chosen)).toBe(true);
    for (let i = 1; i < d.candidates.length; i++) expect(d.candidates[i - 1].score).toBeGreaterThanOrEqual(d.candidates[i].score);
    for (const c of d.candidates) {
      expect(c.probability).toBeGreaterThanOrEqual(0);
      expect(c.probability).toBeLessThanOrEqual(1);
      expect(c.reason.length).toBeGreaterThan(0);
      expect(c.reason.length).toBeLessThanOrEqual(140);
      expect(c.duration).toBeGreaterThan(0);
      expect(c.successPoint && isInsidePitch(c.successPoint, 1e-6)).toBe(true);
    }
    const types = new Set(d.candidates.map((c) => c.action.type));
    expect(types.has('pass')).toBe(true);
    expect(types.has('dribble')).toBe(true);
    expect(types.has('hold')).toBe(true);
    expect(d.candidates.filter((c) => c.action.type === 'hold')).toHaveLength(1);
  });

  it('génération : dribbles dans le terrain, profondeur seulement vers des receveurs en jeu, pas de tir au-delà de shotMaxDistance, dégagement seulement dans le tiers défensif sous pression', () => {
    // Porteur collé à la ligne de touche : aucun dribble ne doit sortir du terrain.
    const edge = simple([{ team: 'A', pos: v(0, 33.5) }, { team: 'A', pos: v(10, 20) }, ...B_LINE]);
    const cands = evaluateCandidates(mkInput(edge), 0);
    for (const c of cands) {
      if (c.action.type === 'dribble') {
        const q = { x: edge.ball.pos.x + c.action.direction.x * c.action.distance, y: edge.ball.pos.y + c.action.direction.y * c.action.distance };
        expect(isInsidePitch(q)).toBe(true);
      }
      expect(c.action.type).not.toBe('shoot'); // d_G ≈ 62 m > 35 m
      expect(c.action.type).not.toBe('clear'); // tiers médian
    }
    // Receveur hors-jeu (au-delà de l'avant-dernier défenseur) : ni passe au pied ni passe en profondeur vers lui.
    const off = simple([{ team: 'A', pos: v(20, 0) }, { team: 'A', pos: v(45, 5) }, { team: 'A', pos: v(30, -10) }, ...B_LINE]);
    expect(isOffsidePosition(off, off.players[1].pos, 'A')).toBe(true);
    const oc = evaluateCandidates(mkInput(off), 0);
    expect(oc.some((c) => c.action.type === 'pass' && c.action.targetId === 1)).toBe(false);
    expect(oc.some((c) => c.action.type === 'pass' && c.action.targetId === 2)).toBe(true);
    // Dégagement : tiers défensif ET pression Π(b) > 1,5.
    const deep = simple([{ team: 'A', pos: v(-40, 5) }, { team: 'A', pos: v(-30, 20) }, { team: 'B', pos: v(-38, 6) }, { team: 'B', pos: v(-39, 3) }, ...B_LINE]);
    expect(evaluateCandidates(mkInput(deep), 0).some((c) => c.action.type === 'clear')).toBe(true);
    const deepFree = simple([{ team: 'A', pos: v(-40, 5) }, { team: 'A', pos: v(-30, 20) }, ...B_LINE]);
    expect(evaluateCandidates(mkInput(deepFree), 0).some((c) => c.action.type === 'clear')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('propriétés de classement (§6.2)', () => {
  it('un coéquipier libre 12 m devant bat un coéquipier marqué', () => {
    const state = simple([
      { team: 'A', pos: v(0, 0) }, { team: 'A', pos: v(12, -10) }, { team: 'A', pos: v(12, 10) },
      { team: 'B', pos: v(13, 10.5) }, ...B_LINE,
    ]);
    const cands = evaluateCandidates(mkInput(state), 0);
    const free = cands.find((c) => isPass(c, 'ground', 1))!;
    const marked = cands.find((c) => isPass(c, 'ground', 2))!;
    expect(free).toBeDefined();
    expect(marked).toBeDefined();
    expect(free.probability).toBeGreaterThan(marked.probability + 0.2);
    expect(free.score).toBeGreaterThan(marked.score);
    expect(cands.indexOf(free)).toBeLessThan(cands.indexOf(marked));
    // Le marqueur apparaît dans les menaces de la passe vers le joueur marqué.
    expect(marked.threats).toContain(3);
  });

  it('un défenseur sur la ligne de passe fait chuter P et recule la passe dans le classement', () => {
    const open = simple([{ team: 'A', pos: v(0, 0) }, { team: 'A', pos: v(15, 0) }, ...B_LINE]);
    const blocked = simple([{ team: 'A', pos: v(0, 0) }, { team: 'A', pos: v(15, 0) }, { team: 'B', pos: v(7, 0.8) }, ...B_LINE]);
    const co = evaluateCandidates(mkInput(open), 0), cb = evaluateCandidates(mkInput(blocked), 0);
    const po = co.find((c) => isPass(c, 'ground', 1))!, pb = cb.find((c) => isPass(c, 'ground', 1))!;
    expect(po.probability).toBeGreaterThan(0.75);
    expect(pb.probability).toBeLessThan(po.probability - 0.2);
    expect(pb.score).toBeLessThan(po.score);
    // Recul dans le classement : le rang de la passe ne s'améliore pas et sa décomposition porte le risque d'interception.
    expect(cb.indexOf(pb)).toBeGreaterThanOrEqual(co.indexOf(po));
    const risk = (c: Candidate): number => c.components.find((k) => k.key === 'risk')!.contribution;
    expect(risk(pb)).toBeLessThan(risk(po));
    expect(pb.threats).toContain(2);
    // Explication : la contribution « risque » nomme l'intercepteur.
    expect(pb.reason).toMatch(/interception/);
  });

  it('tir ouvert depuis le point de penalty (gardien hors de position) : le tir est choisi', () => {
    const state = simple([
      { team: 'A', pos: v(41.5, 0) }, { team: 'A', pos: v(30, 10) },
      { team: 'B', pos: v(50, 18), role: 'GK' }, { team: 'B', pos: v(44, 2.6) }, { team: 'B', pos: v(44, -2.6) }, { team: 'B', pos: v(38, 6) },
    ]);
    const d = decideOnBall(mkInput(state), 0, null);
    expect(d.chosen.action.type).toBe('shoot');
    const shot = d.candidates.find((c) => c.action.type === 'shoot')!;
    expect(shot.valueIfSuccess).toBeCloseTo(1, 9); // un but vaut 1
    expect(shot.probability).toBeGreaterThan(0.2);
    if (shot.action.type === 'shoot') expect(shot.action.xg).toBeCloseTo(shot.probability, 9);
    expect(d.candidates.filter((c) => c.action.type === 'shoot')).toHaveLength(1); // trois visées, la meilleure retenue
    expect(d.explanation.split('\n')[0]).toBe('ACTION OPTIMALE : TIRER');
  });

  it('impasse : défenseurs côté but des coéquipiers, pas de tir possible ⇒ conservation ou dribble, jamais une passe', () => {
    const state = simple([
      { team: 'A', pos: v(-10, 0) }, { team: 'A', pos: v(0, 8) }, { team: 'A', pos: v(0, -8) },
      { team: 'B', pos: v(2, 8) }, { team: 'B', pos: v(-2, 6) }, { team: 'B', pos: v(2, -8) }, { team: 'B', pos: v(-2, -6) }, { team: 'B', pos: v(-4, 0) },
      { team: 'B', pos: v(52, 0), role: 'GK' },
    ]);
    const d = decideOnBall(mkInput(state), 0, null);
    expect(['hold', 'dribble']).toContain(d.chosen.action.type);
    expect(d.candidates.some((c) => c.action.type === 'shoot')).toBe(false);
    const bestPass = d.candidates.find((c) => c.action.type === 'pass')!;
    expect(bestPass.score).toBeLessThan(d.chosen.score);
    expect(d.context.availableTeammates).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('hystérésis, déterminisme, réponse quantale (§6.5)', () => {
  const symmetric = (): MatchState => simple([
    { team: 'A', pos: v(0, 0) }, { team: 'A', pos: v(12, 8) }, { team: 'A', pos: v(12, -8) },
    { team: 'B', pos: v(52, 0), role: 'GK' }, { team: 'B', pos: v(30, 12) }, { team: 'B', pos: v(30, -12) }, { team: 'B', pos: v(-6, 0) },
  ]);

  it('l’intention précédente est conservée quand le challenger reste dans la marge h, pas au-delà', () => {
    const d1 = decideOnBall(mkInput(symmetric()), 0, null);
    expect(d1.chosen.action.type).toBe('pass');
    const chosenTarget = d1.chosen.action.type === 'pass' ? d1.chosen.action.targetId : -1;
    const other = chosenTarget === 1 ? 2 : 1;
    // Le challenger devient légèrement meilleur (0,4 m plus avancé) : sans mémoire il gagne…
    const s2 = symmetric();
    s2.players[other].pos.x += 0.4;
    const dNone = decideOnBall(mkInput(s2), 0, null);
    expect(dNone.chosen.action.type === 'pass' && dNone.chosen.action.targetId).toBe(other);
    // … mais avec l'intention précédente l'action est conservée (écart < h = 0,02).
    const dPrev = decideOnBall(mkInput(s2), 0, d1);
    expect(sameAction(dPrev.chosen.action, d1.chosen.action)).toBe(true);
    expect(dPrev.keptByHysteresis).toBe(true);
    expect(dPrev.chosen.components.find((k) => k.key === 'hysteresis')!.contribution).toBeCloseTo(P.decision.hysteresis, 9);
    // L'intention précédente devient nettement pire (un défenseur se place sur sa trajectoire, écart ≫ h) : elle est abandonnée.
    const q = d1.chosen.successPoint!;
    const s3 = simple([
      { team: 'A', pos: v(0, 0) }, { team: 'A', pos: v(12, 8) }, { team: 'A', pos: v(12, -8) },
      { team: 'B', pos: v(52, 0), role: 'GK' }, { team: 'B', pos: v(30, 12) }, { team: 'B', pos: v(30, -12) }, { team: 'B', pos: v(-6, 0) },
      { team: 'B', pos: v(q.x * 0.6, q.y * 0.6) },
    ]);
    const dFar = decideOnBall(mkInput(s3), 0, d1);
    expect(dFar.keptByHysteresis).toBeFalsy();
    expect(sameAction(dFar.chosen.action, d1.chosen.action)).toBe(false);
  });

  it('déterminisme : même graine ⇒ même décision, mêmes scores', () => {
    const run = (seed: number): Decision => decideOnBall(mkInput(fullState(), seed, P), 6, null);
    const a = run(42), b = run(42);
    expect(JSON.stringify(a.chosen.action)).toBe(JSON.stringify(b.chosen.action));
    expect(a.candidates.map((c) => c.score)).toEqual(b.candidates.map((c) => c.score));
    expect(a.explanation).toBe(b.explanation);
  });

  it('température 0 ⇒ argmax ; température > 0 ⇒ choix toujours à ε du meilleur', () => {
    const state = symmetric();
    const d0 = decideOnBall(mkInput(state, 1, P0), 0, null);
    expect(d0.chosen).toBe(d0.candidates[0]);
    const hot = cloneParams(P);
    hot.decision.softmaxTemperature = 0.05;
    const picks = new Set<number>();
    for (let seed = 1; seed <= 20; seed++) {
      const d = decideOnBall(mkInput(state, seed, hot), 0, null);
      expect(d.chosen.score).toBeGreaterThanOrEqual(d.candidates[0].score - hot.decision.epsilonTie - 1e-12);
      picks.add(d.candidates.indexOf(d.chosen));
    }
    // Deux passes symétriques à égalité : la réponse quantale choisit tantôt l'une, tantôt l'autre.
    expect(picks.size).toBeGreaterThan(1);
    // Softmax sur une liste construite : T = 0 renvoie le premier, T → ∞ tire uniformément dans la zone ε.
    const fake = (score: number): Candidate => ({ action: { type: 'hold' }, score, probability: 1, valueIfSuccess: 0, valueIfFailure: 0, components: [], reason: '' });
    const list = [fake(0.10), fake(0.099), fake(0.05)];
    expect(selectCandidate(list, 0.005, 0, new Rng(1))).toBe(list[0]);
    const counts = [0, 0, 0];
    const rng = new Rng(7);
    for (let i = 0; i < 2000; i++) counts[list.indexOf(selectCandidate(list, 0.005, 1e6, rng))]++;
    expect(counts[2]).toBe(0);
    expect(Math.abs(counts[0] - counts[1])).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
describe('modulation tactique (§13.3)', () => {
  it('formules des poids modulés', () => {
    const t = makeTactic('4-3-3', 'balanced').params;
    const w = modulatedWeights(P, t, 'attack');
    expect(w.lambda).toBeCloseTo(P.decision.lambdaRisk * (1.6 - 1.2 * t.riskTolerance), 12);
    expect(w.wProgress).toBeCloseTo(P.decision.wProgress * t.progressionBias, 12);
    expect(w.wTime).toBeCloseTo(P.decision.wTime * (0.5 + t.tempo), 12);
    const wt = modulatedWeights(P, t, 'transition_attack');
    expect(wt.wProgress).toBeCloseTo(w.wProgress * (1 + 1.5 * t.counterAttackBias), 12);
    const poss = modulatedWeights(P, makeTactic('4-3-3', 'possession').params, 'attack');
    const counter = modulatedWeights(P, makeTactic('4-4-2', 'counter').params, 'attack');
    expect(poss.lambda).toBeGreaterThan(counter.lambda);
    expect(poss.directnessBonus).toBeLessThan(counter.directnessBonus);
    expect(poss.wProgress).toBeLessThan(counter.wProgress);
  });

  it('dilemme construit : la possession choisit la passe sûre, la contre-attaque la passe en profondeur', () => {
    const mk = (style: StyleId): MatchState => simple([
      { team: 'A', pos: v(-10, 0) }, { team: 'A', pos: v(-9, 9) }, { team: 'A', pos: v(10, 0), vel: v(6, 0) },
      { team: 'B', pos: v(-6.5, 2) }, { team: 'B', pos: v(11, 9) }, { team: 'B', pos: v(11, -9) }, { team: 'B', pos: v(52, 0), role: 'GK' }, { team: 'B', pos: v(-25, -20) },
    ], 0, style);
    const dp = decideOnBall(mkInput(mk('possession')), 0, null);
    const dc = decideOnBall(mkInput(mk('counter')), 0, null);
    expect(isPass(dp.chosen, 'ground', 1)).toBe(true);
    expect(isPass(dc.chosen, 'through', 2)).toBe(true);
    // Classement relatif des deux options inversé par le style.
    const best = (d: Decision, kind: 'ground' | 'through', id: number): Candidate => d.candidates.filter((c) => isPass(c, kind, id)).sort((a, b) => b.score - a.score)[0];
    expect(best(dp, 'ground', 1).score).toBeGreaterThan(best(dp, 'through', 2).score);
    expect(best(dc, 'through', 2).score).toBeGreaterThan(best(dc, 'ground', 1).score);
    expect(dp.context.style).toBe('possession');
    expect(dc.context.style).toBe('counter');
  });
});

// ---------------------------------------------------------------------------
describe('profondeur 2, contexte, symétrie, performance', () => {
  it('lookahead : Q borné dans [−2, 2], composante « lookahead » et réponse adverse sur les K meilleurs', () => {
    const d = decideOnBall(mkInput(fullState(), 2, P), 6, null);
    for (const c of d.candidates) {
      expect(c.score).toBeGreaterThanOrEqual(-2);
      expect(c.score).toBeLessThanOrEqual(2);
      expect(Number.isFinite(c.valueIfSuccess)).toBe(true);
    }
    const expanded = d.candidates.filter((c) => c.components.some((k) => k.key === 'lookahead'));
    expect(expanded.length).toBeGreaterThan(0);
    expect(expanded.length).toBeLessThanOrEqual(P.decision.topK);
    for (const c of expanded) {
      expect(c.response?.kind).toBe('press');
      expect(c.response!.delta).toBeGreaterThanOrEqual(-1e-9); // presser ne peut qu'abaisser le contrôle
      const la = c.components.find((k) => k.key === 'lookahead')!;
      expect(Math.abs(la.contribution - c.probability * P.decision.gamma * la.value)).toBeLessThan(1e-9);
    }
    // Sans lookahead (γ = 0 ou K = 0) : aucune composante lookahead.
    const noLA = cloneParams(P);
    noLA.decision.topK = 0;
    const d0 = decideOnBall(mkInput(fullState(), 2, noLA), 6, null);
    expect(d0.candidates.some((c) => c.components.some((k) => k.key === 'lookahead'))).toBe(false);
  });

  it('contexte : phase, style, formation, pression 0..1, coéquipiers disponibles = passes avec P ≥ 0,5, supériorité locale', () => {
    const state = fullState();
    const d = decideOnBall(mkInput(state, 1, P), 6, null);
    expect(d.context.phase).toBe(state.phase.A);
    expect(d.context.style).toBe(state.tactics.A.style);
    expect(d.context.formation).toBe(state.tactics.A.formation);
    expect(d.context.pressure).toBeGreaterThanOrEqual(0);
    expect(d.context.pressure).toBeLessThanOrEqual(1);
    const available = d.candidates.filter((c) => isPass(c, 'ground') && c.probability >= 0.5).length;
    expect(d.context.availableTeammates).toBe(available);
    expect(Number.isInteger(d.context.localSuperiority)).toBe(true);
    expect(d.playerId).toBe(6);
    expect(d.time).toBe(state.time);
    expect(d.computeMs).toBeGreaterThan(0);
    expect(d.committedUntil === undefined || d.committedUntil >= state.time).toBe(true);
  });

  it('symétrie miroir : l’état (x, y) ↦ (−x, −y) avec équipes échangées donne les mêmes candidats (cibles miroir, scores égaux)', () => {
    const mk = (m: 1 | -1): MatchState => {
      const t = (a: TeamId): TeamId => (m > 0 ? a : a === 'A' ? 'B' : 'A');
      return simple([
        { team: t('A'), pos: v(5 * m, 3 * m) }, { team: t('A'), pos: v(18 * m, -6 * m), vel: v(2 * m, 1 * m) }, { team: t('A'), pos: v(10 * m, 12 * m) },
        { team: t('B'), pos: v(52 * m, 0), role: 'GK' }, { team: t('B'), pos: v(30 * m, 10 * m) }, { team: t('B'), pos: v(12 * m, -2 * m), vel: v(-3 * m, 0) }, { team: t('B'), pos: v(28 * m, -14 * m) },
      ]);
    };
    const dA = decideOnBall(mkInput(mk(1), 7), 0, null), dB = decideOnBall(mkInput(mk(-1), 7), 0, null);
    expect(dA.candidates.length).toBe(dB.candidates.length);
    expect(dA.chosen.action.type).toBe(dB.chosen.action.type);
    expect(Math.abs(dA.chosen.score - dB.chosen.score)).toBeLessThan(1e-3);
    // Chaque candidat de A a son miroir dans B avec le même score (tolérance : fenêtre de cellules de la grille de pression).
    for (const a of dA.candidates) {
      const twin = dB.candidates.find((b) => {
        if (a.action.type !== b.action.type) return false;
        if (a.action.type === 'pass' && b.action.type === 'pass') return a.action.targetId === b.action.targetId && a.action.kind === b.action.kind && Math.abs(a.action.targetPoint.x + b.action.targetPoint.x) < 1e-6;
        if (a.action.type === 'dribble' && b.action.type === 'dribble') return a.action.distance === b.action.distance && Math.abs(a.action.direction.x + b.action.direction.x) < 1e-9 && Math.abs(a.action.direction.y + b.action.direction.y) < 1e-9;
        return true;
      });
      expect(twin, `miroir de ${JSON.stringify(a.action)}`).toBeDefined();
      expect(Math.abs(a.score - twin!.score)).toBeLessThan(1e-3);
      expect(Math.abs(a.successPoint!.x + twin!.successPoint!.x)).toBeLessThan(1e-6);
    }
    expect(mirror(dA.chosen.successPoint!).x).toBeCloseTo(dB.chosen.successPoint!.x, 6);
  });

  it('performance : une décision complète (22 joueurs, profondeur 2) en moins de 25 ms en moyenne', () => {
    const state = fullState();
    const input = mkInput(state, 1, P);
    for (let i = 0; i < 5; i++) decideOnBall(input, 6, null); // échauffement du JIT
    const N = 20;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) decideOnBall(input, 6, null);
    const avg = (performance.now() - t0) / N;
    expect(avg).toBeLessThan(25);
  });
});

// ---------------------------------------------------------------------------
describe('explications (§6.6)', () => {
  it('actionLabel : libellés français des actions', () => {
    const state = simple([{ team: 'A', pos: v(0, 0), number: 8 }, { team: 'A', pos: v(10, 0), number: 7 }, { team: 'A', pos: v(20, 0), number: 9 }, ...B_LINE]);
    const cand = (action: Candidate['action']): Candidate => ({ action, score: 0, probability: 0.5, valueIfSuccess: 0, valueIfFailure: 0, components: [], reason: '' });
    expect(actionLabel(cand({ type: 'pass', targetId: 1, targetPoint: v(10, 0), kind: 'ground', speed: 6 }), state)).toBe('PASSER → n°7');
    expect(actionLabel(cand({ type: 'pass', targetId: 2, targetPoint: v(26, 0), kind: 'through', speed: 9 }), state)).toBe('PASSE EN PROFONDEUR → n°9');
    expect(actionLabel(cand({ type: 'pass', targetId: 1, targetPoint: v(10, 0), kind: 'lob', speed: 6 }), state)).toBe('PASSE LOBÉE → n°7');
    expect(actionLabel(cand({ type: 'dribble', direction: v(1, 0), distance: 4 }), state, 0)).toBe('DRIBBLER (vers l’avant)');
    expect(actionLabel(cand({ type: 'shoot', targetPoint: v(52.5, 0), power: 1 }), state)).toBe('TIRER');
    expect(actionLabel(cand({ type: 'hold' }), state)).toBe('CONSERVER');
    expect(actionLabel(cand({ type: 'clear', targetPoint: v(30, 25) }), state)).toBe('DÉGAGER');
    expect(actionLabel(cand({ type: 'move', target: v(5, 5), intent: 'support', speed: 4 }), state)).toBe('SE DÉPLACER (soutien)');
    // Directions dans le repère équipe : « vers l'avant » = vers le but adverse pour les deux équipes.
    expect(directionLabel(v(1, 0), 'A')).toBe('vers l’avant');
    expect(directionLabel(v(-1, 0), 'B')).toBe('vers l’avant');
    expect(directionLabel(v(0, -1), 'A')).toBe('vers la gauche');
    expect(directionLabel(v(0, 1), 'B')).toBe('vers la gauche');
  });

  it('explainDecision : en-têtes obligatoires, ≤ 12 lignes, alternatives avec « pourquoi pas », menaces', () => {
    const state = simple([
      { team: 'A', pos: v(0, 0) }, { team: 'A', pos: v(12, -10) }, { team: 'A', pos: v(12, 10) },
      { team: 'B', pos: v(13, 10.5) }, { team: 'B', pos: v(6, 6) }, ...B_LINE,
    ]);
    const d = decideOnBall(mkInput(state, 1, P), 0, null);
    const lines = d.explanation.split('\n');
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines[0]).toMatch(/^ACTION OPTIMALE : /);
    expect(lines[1]).toMatch(/^CIBLE : /);
    expect(lines[2]).toMatch(/^SCORE : −?\d+,\d{2} — PROBABILITÉ : \d+ %$/);
    expect(lines[3]).toMatch(/^RAISON : .+/);
    const alt = lines.indexOf('Alternatives :');
    expect(alt).toBeGreaterThan(3);
    const altLines = lines.slice(alt + 1).filter((l) => l.startsWith('  – '));
    expect(altLines.length).toBe(3);
    for (const l of altLines) expect(l).toMatch(/^  – .+ \(−?\d+,\d{2}\) : .+/);
    // « Pourquoi pas » : terme de plus grand écart entre les décompositions.
    const why = whyNot(d.chosen, d.candidates.find((c) => c !== d.chosen)!);
    expect(why.length).toBeGreaterThan(0);
    // Une passe menacée porte ses menaces dans l'explication (n° de maillot).
    const marked = d.candidates.find((c) => isPass(c, 'ground', 2))!;
    const dMarked: Decision = { ...d, chosen: marked };
    expect(explainDecision(dMarked, state)).toMatch(/Menaces : n°/);
    expect(explainDecision(dMarked, state).split('\n').length).toBeLessThanOrEqual(12);
  });

  it('explainDecision accepte une décision de déplacement (sans ballon) et l’hystérésis', () => {
    const state = fullState();
    const move: Candidate = {
      action: { type: 'move', target: v(4, -8), intent: 'run', speed: 7 }, score: 0.12, probability: 0.6, valueIfSuccess: 0.2, valueIfFailure: 0,
      components: [{ key: 'receivable', label: 'Valeur recevable', value: 0.1, weight: 1, contribution: 0.1 }, { key: 'slot', label: 'Rappel au poste', value: 2, weight: -0.01, contribution: -0.02 }],
      reason: 'appel dans l’espace libre',
    };
    const alt: Candidate = { ...move, action: { type: 'move', target: v(-4, -8), intent: 'support', speed: 4 }, score: 0.05, components: [{ key: 'receivable', label: 'Valeur recevable', value: 0.03, weight: 1, contribution: 0.03 }] };
    const d: Decision = {
      playerId: 9, time: 12, chosen: move, candidates: [move, alt], explanation: '', computeMs: 0.1, keptByHysteresis: true,
      context: { phase: 'attack', style: 'balanced', formation: '4-3-3', pressure: 0.1, availableTeammates: 2, localSuperiority: 1 },
    };
    const text = explainDecision(d, state);
    const lines = text.split('\n');
    expect(lines[0]).toBe('ACTION OPTIMALE : SE DÉPLACER (appel en profondeur)');
    expect(lines[1]).toMatch(/^CIBLE : \(4,0 ; −8,0\) — appel en profondeur$/);
    expect(lines[2]).toBe('SCORE : 0,12 — PROBABILITÉ : 60 %');
    expect(lines[3]).toMatch(/hystérésis/);
    expect(text).toMatch(/Déplacement \(soutien\) \(0,05\) : moins recevable/);
  });

  it('la raison est construite à partir des plus grandes contributions (positives puis négative)', () => {
    const state = simple([{ team: 'A', pos: v(30, 0) }, { team: 'A', pos: v(36, 2) }, ...B_LINE]);
    const cands = evaluateCandidates(mkInput(state), 0);
    for (const c of cands) {
      const pos = c.components.filter((k) => k.contribution > 1e-4).sort((a, b) => b.contribution - a.contribution);
      const neg = c.components.filter((k) => k.contribution < -1e-4).sort((a, b) => a.contribution - b.contribution);
      if (pos.length > 0 && neg.length > 0) expect(c.reason).toMatch(/, mais /);
      if (pos.length >= 2) expect(c.reason).toMatch(/ \+ /);
    }
    const pass = cands.find((c) => isPass(c, 'ground', 1))!;
    expect(pass.reason).toMatch(/ligne de passe dégagée \(\d+ %\)/);
  });
});
