/**
 * Tests du jeu 2×2 à somme nulle (§6.4, src/decision/game2x2.ts) et de l'ensemble de réponses défensives
 * (§6.3, src/decision/responses.ts) : résolution (matching pennies, point-selle, dominance), tirage à l'équilibre,
 * réponses bornées par le modèle de mouvement, déclenchement au niveau de la décision (Decision.game, engagement),
 * lignes d'explication.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_PARAMS, cloneParams } from '@/core/params';
import { buildState, buildFullState, type PlayerSpec } from '@/core/state-builder';
import { Rng } from '@/core/rng';
import type { Candidate, MatchState, SimParams } from '@/core/types';
import type { Vec2 } from '@/core/vec2';
import { computeFields } from '@/models/fields';
import { pitchControlAt } from '@/models/fields';
import { makeTactic } from '@/tactics/styles';
import type { DecisionInput } from '@/decision/policy';
import { decideOnBall } from '@/decision/onball';
import { drawAction, gameClass, solve2x2, type GameMatrix } from '@/decision/game2x2';
import { applyResponse, displaceToward, predictHoldState, responseThreat, runDistance, RESPONSES, bestOnwardLane } from '@/decision/responses';
import { explainDecision } from '@/decision/explain';

const P: SimParams = DEFAULT_PARAMS;
const v = (x: number, y: number): Vec2 => ({ x, y });

function simple(players: PlayerSpec[], ownerId = 0): MatchState {
  const specs = players.map((p) => ({ ...p, role: p.role ?? 'MF' }));
  return buildState({ players: specs, ball: { pos: specs[ownerId].pos, ownerId }, tactics: { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-4-2', 'balanced') } });
}
function mkInput(state: MatchState, seed = 1, params: SimParams = P): DecisionInput {
  const owner = state.players[state.ball.ownerId ?? 0];
  return { state, fields: computeFields(state, params), params, tactic: state.tactics[owner.team], rng: new Rng(seed) };
}
const sumContrib = (c: Candidate): number => c.components.reduce((s, k) => s + k.contribution, 0);

// ---------------------------------------------------------------------------
describe('solve2x2 (§6.4)', () => {
  it('matching pennies [[1, −1], [−1, 1]] ⇒ stratégie mixte π₁ = 0,5, valeur 0', () => {
    const s = solve2x2([[1, -1], [-1, 1]]);
    expect(s.pure).toBe(false);
    expect(s.pi1).toBeCloseTo(0.5, 12);
    expect(s.value).toBeCloseTo(0, 12);
  });

  it('point-selle ⇒ action pure minimax (max_k min_l = min_l max_k)', () => {
    // Ligne 2 : min = 2 ; ligne 1 : min = 1 ; colonnes : max = 3, 2 ⇒ maximin = minimax = 2 (M₂₂).
    const s = solve2x2([[3, 1], [2, 2]]);
    expect(s.pure).toBe(true);
    expect(s.pi1).toBe(0);
    expect(s.value).toBe(2);
    // Point-selle sur la première ligne.
    // Ligne 1 : min = 0,4 ; ligne 2 : min = 0,2 ; colonnes : max = 0,5 et 0,4 ⇒ maximin = minimax = 0,4 (M₁₂).
    const t = solve2x2([[0.5, 0.4], [0.3, 0.2]]);
    expect(t.pure).toBe(true);
    expect(t.pi1).toBe(1);
    expect(t.value).toBeCloseTo(0.4, 12);
    // Sans point-selle (croisement) : mixte.
    expect(solve2x2([[0.5, 0.4], [0.3, 0.6]]).pure).toBe(false);
  });

  it('dominance : une ligne qui domine l’autre est jouée en pur ; une matrice constante est un point-selle', () => {
    const s = solve2x2([[0.3, 0.2], [0.1, 0.0]]);
    expect(s.pure).toBe(true);
    expect(s.pi1).toBe(1);
    expect(s.value).toBeCloseTo(0.2, 12);
    const c = solve2x2([[0.1, 0.1], [0.1, 0.1]]);
    expect(c.pure).toBe(true);
    expect(c.value).toBeCloseTo(0.1, 12);
  });

  it('stratégie mixte générale : π₁ = (M₂₂ − M₂₁)/(M₁₁ − M₁₂ − M₂₁ + M₂₂), valeur = (M₁₁M₂₂ − M₁₂M₂₁)/(même dénominateur), bornée à [0, 1]', () => {
    const m: GameMatrix = [[0.2, 0.05], [0.08, 0.15]];
    const s = solve2x2(m);
    expect(s.pure).toBe(false);
    const den = 0.2 - 0.05 - 0.08 + 0.15;
    expect(s.pi1).toBeCloseTo((0.15 - 0.08) / den, 12);
    expect(s.value).toBeCloseTo((0.2 * 0.15 - 0.05 * 0.08) / den, 12);
    expect(s.pi1).toBeGreaterThanOrEqual(0);
    expect(s.pi1).toBeLessThanOrEqual(1);
    // La valeur d'un jeu mixte est entre le maximin et le minimax.
    expect(s.value).toBeGreaterThanOrEqual(Math.max(Math.min(0.2, 0.05), Math.min(0.08, 0.15)) - 1e-12);
    expect(s.value).toBeLessThanOrEqual(Math.min(Math.max(0.2, 0.08), Math.max(0.05, 0.15)) + 1e-12);
  });

  it('drawAction : pur ⇒ déterministe ; mixte ⇒ fréquence de la première action ≈ π₁ avec le RNG à graine', () => {
    const rng = new Rng(3);
    expect(drawAction({ pure: true, pi1: 1, value: 0 }, rng)).toBe(0);
    expect(drawAction({ pure: true, pi1: 0, value: 0 }, rng)).toBe(1);
    let first = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) if (drawAction({ pure: false, pi1: 0.3, value: 0 }, rng) === 0) first++;
    expect(first / N).toBeGreaterThan(0.26);
    expect(first / N).toBeLessThan(0.34);
    // Même graine ⇒ même suite de tirages.
    const a = new Rng(11), b = new Rng(11);
    for (let i = 0; i < 50; i++) expect(drawAction({ pure: false, pi1: 0.5, value: 0 }, a)).toBe(drawAction({ pure: false, pi1: 0.5, value: 0 }, b));
  });

  it('gameClass : tir, passe (toute variante), dribble ; conservation et dégagement hors dilemme', () => {
    expect(gameClass({ type: 'shoot', targetPoint: v(52.5, 0), power: 1 })).toBe('shoot');
    expect(gameClass({ type: 'pass', targetId: 1, targetPoint: v(0, 0), kind: 'through', speed: 9 })).toBe('pass');
    expect(gameClass({ type: 'dribble', direction: v(1, 0), distance: 4 })).toBe('dribble');
    expect(gameClass({ type: 'hold' })).toBeNull();
    expect(gameClass({ type: 'clear', targetPoint: v(30, 20) })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('réponses défensives (§6.3)', () => {
  it('runDistance / displaceToward : rien pendant la réaction, puis accélération bornée ; arrêt au rayon de duel', () => {
    const tau = P.models.reactionTime;
    expect(runDistance(tau / 2, 8, 3, tau)).toBe(0);
    expect(runDistance(tau + 1, 8, 3, tau)).toBeCloseTo(0.5 * 3 * 1, 12);
    expect(runDistance(tau + 10, 8, 3, tau)).toBeCloseTo((8 * 8) / (2 * 3) + 8 * (10 - 8 / 3), 12);
    const state = simple([{ team: 'A', pos: v(0, 0) }, { team: 'B', pos: v(10, 0) }]);
    const d = { ...state.players[1], pos: v(10, 0), vel: v(0, 0) };
    displaceToward(d, v(0, 0), tau + 1, tau, 1.2);
    const covered = runDistance(tau + 1, d.maxSpeed, d.maxAccel, tau);
    expect(covered).toBeGreaterThan(0);
    expect(d.pos.x).toBeCloseTo(10 - covered, 9); // distance couvrable en 1 s après réaction, vers la cible
    expect(d.vel.x).toBeLessThan(0);
    expect(Math.hypot(d.vel.x, d.vel.y)).toBeLessThanOrEqual(d.maxSpeed + 1e-9);
    const e = { ...state.players[1], pos: v(2, 0), vel: v(0, 0) };
    displaceToward(e, v(0, 0), tau + 10, tau, 1.2);
    expect(e.pos.x).toBeCloseTo(1.2, 9); // ne dépasse pas le rayon de duel
  });

  it('press : les deux adversaires les plus proches de q⁺ s’en rapprochent (les autres ne bougent pas) et le contrôle en q⁺ baisse', () => {
    const state = simple([
      { team: 'A', pos: v(0, 0) }, { team: 'A', pos: v(15, 0) },
      { team: 'B', pos: v(52, 0), role: 'GK' }, { team: 'B', pos: v(22, 3), role: 'DF' }, { team: 'B', pos: v(18, -8), role: 'DF' }, { team: 'B', pos: v(40, 20), role: 'MF' },
    ]);
    const c: Candidate = { action: { type: 'pass', targetId: 1, targetPoint: v(15, 0), kind: 'ground', speed: 6 }, score: 0, probability: 1, valueIfSuccess: 0, valueIfFailure: 0, components: [], reason: '', duration: 2, successPoint: v(15, 0) };
    const base = predictHoldState(state, c, 0, 1, P);
    expect(base.ball.ownerId).toBe(1);
    expect(base.players[1].pos).toEqual(v(15, 0));
    const pressed = applyResponse('press', base, v(15, 0), 'A', 2, P, null)!;
    expect(pressed).not.toBeNull();
    expect(pressed.players[3].pos.x).toBeLessThan(22); // n°3 (à 7,6 m) court vers q⁺
    expect(pressed.players[4].pos.x).toBeLessThan(18); // n°4 (à 8,5 m) aussi
    expect(pressed.players[5].pos).toEqual(base.players[5].pos); // le troisième ne bouge pas
    expect(pressed.players[2]).toBe(base.players[2]); // objets non déplacés partagés (pas de copie profonde)
    expect(pitchControlAt(pressed, v(15, 0), 'A', P)).toBeLessThan(pitchControlAt(base, v(15, 0), 'A', P));
    expect(responseThreat(pressed, v(15, 0), 'A', P)).toBeLessThan(responseThreat(base, v(15, 0), 'A', P));
    // hold : l'état de base lui-même.
    expect(applyResponse('hold', base, v(15, 0), 'A', 2, P, null)).toBe(base);
  });

  it('cover : l’adversaire le plus proche de la ligne de passe se place vers son point faible ; sans ligne ⇒ null (identique à hold)', () => {
    const state = simple([
      { team: 'A', pos: v(0, 0) }, { team: 'A', pos: v(15, 0) }, { team: 'A', pos: v(30, 10) },
      { team: 'B', pos: v(52, 0), role: 'GK' }, { team: 'B', pos: v(24, 12), role: 'DF' }, { team: 'B', pos: v(10, -14), role: 'DF' },
    ]);
    const c: Candidate = { action: { type: 'pass', targetId: 1, targetPoint: v(15, 0), kind: 'ground', speed: 6 }, score: 0, probability: 1, valueIfSuccess: 0, valueIfFailure: 0, components: [], reason: '', duration: 2, successPoint: v(15, 0) };
    const base = predictHoldState(state, c, 0, 1, P);
    expect(applyResponse('cover', base, v(15, 0), 'A', 2, P, null)).toBeNull();
    const lane = { from: v(15, 0), to: v(30, 10), weakPoint: v(22.5, 5) };
    const covered = applyResponse('cover', base, v(15, 0), 'A', 2, P, lane)!;
    // n°4 (24, 12) est le plus proche de la ligne : il se rapproche du point faible ; n°5 ne bouge pas.
    const before = Math.hypot(24 - 22.5, 12 - 5), after = Math.hypot(covered.players[4].pos.x - 22.5, covered.players[4].pos.y - 5);
    expect(after).toBeLessThan(before);
    expect(covered.players[5]).toBe(base.players[5]);
    // bestOnwardLane : première passe de la suite, point faible = failurePoint.
    const cont: Candidate[] = [
      { action: { type: 'dribble', direction: v(1, 0), distance: 4 }, score: 1, probability: 1, valueIfSuccess: 0, valueIfFailure: 0, components: [], reason: '' },
      { action: { type: 'pass', targetId: 2, targetPoint: v(30, 10), kind: 'ground', speed: 6 }, score: 0.5, probability: 1, valueIfSuccess: 0, valueIfFailure: 0, components: [], reason: '', successPoint: v(30, 10), failurePoint: v(20, 6) },
    ];
    expect(bestOnwardLane(cont, v(15, 0))).toEqual({ from: v(15, 0), to: v(30, 10), weakPoint: v(20, 6) });
    expect(bestOnwardLane([cont[0]], v(15, 0))).toBeNull();
  });

  it('drop : les défenseurs (DF) reculent vers leur but d’au plus 5 m, bornés par la distance couvrable ; sans DF ⇒ null', () => {
    const state = simple([
      { team: 'A', pos: v(0, 0) }, { team: 'A', pos: v(15, 0) },
      { team: 'B', pos: v(52, 0), role: 'GK' }, { team: 'B', pos: v(30, 8), role: 'DF' }, { team: 'B', pos: v(30, -8), role: 'DF' }, { team: 'B', pos: v(20, 0), role: 'MF' },
    ]);
    const c: Candidate = { action: { type: 'pass', targetId: 1, targetPoint: v(15, 0), kind: 'ground', speed: 6 }, score: 0, probability: 1, valueIfSuccess: 0, valueIfFailure: 0, components: [], reason: '', duration: 1, successPoint: v(15, 0) };
    const base = predictHoldState(state, c, 0, 1, P);
    const dropped = applyResponse('drop', base, v(15, 0), 'A', 1, P, null)!;
    const tau = P.models.reactionTime;
    const covered = runDistance(1, state.players[3].maxSpeed, state.players[3].maxAccel, tau);
    expect(covered).toBeGreaterThan(0);
    expect(covered).toBeLessThan(5);
    expect(dropped.players[3].pos.x).toBeCloseTo(30 + covered, 9); // recul vers +x (but de B)
    expect(dropped.players[4].pos.x).toBeCloseTo(30 + covered, 9);
    expect(dropped.players[5]).toBe(base.players[5]); // le milieu ne recule pas
    expect(dropped.players[2]).toBe(base.players[2]); // ni le gardien
    // Avec une longue durée, le recul est plafonné à 5 m.
    const far = applyResponse('drop', base, v(15, 0), 'A', 6, P, null)!;
    expect(far.players[3].pos.x).toBeCloseTo(35, 9);
    // Sans défenseur de champ : aucune réponse.
    const noDF = simple([{ team: 'A', pos: v(0, 0) }, { team: 'A', pos: v(15, 0) }, { team: 'B', pos: v(52, 0), role: 'GK' }, { team: 'B', pos: v(20, 0), role: 'MF' }]);
    const b2 = predictHoldState(noDF, c, 0, 1, P);
    expect(applyResponse('drop', b2, v(15, 0), 'A', 1, P, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('décision du porteur : minimax sur R, jeu 2×2, engagement, explication', () => {
  const full = (): MatchState => buildFullState({ ownerId: 6, ballPos: v(-6, -12) });

  it('profondeur 2 : réponse argmin dans R, Σ composantes = score, Q ≤ EV₁ + P·γ·G_hold, et hold+press ⊂ réponses évaluées', () => {
    for (const seed of [1, 2, 3]) {
      const d = decideOnBall(mkInput(full(), seed, P), 6, null);
      const expanded = d.candidates.filter((c) => c.response);
      expect(expanded.length).toBeGreaterThan(0);
      for (const c of expanded) {
        expect(RESPONSES).toContain(c.response!.kind);
        expect(Math.abs(sumContrib(c) - c.score)).toBeLessThan(1e-9);
        const rp = c.components.find((k) => k.key === 'response');
        const la = c.components.find((k) => k.key === 'lookahead')!;
        expect(la).toBeDefined();
        if (rp) expect(rp.contribution).toBeCloseTo(-c.probability * c.response!.delta, 9);
        else expect(Math.abs(c.response!.delta)).toBeLessThan(1e-9);
        expect(la.value).toBeGreaterThanOrEqual(0);
      }
    }
    // responseCount = 2 (hold + press) : seules ces deux réponses peuvent être argmin.
    const two = cloneParams(P);
    two.decision.responseCount = 2;
    const d2 = decideOnBall(mkInput(full(), 1, two), 6, null);
    for (const c of d2.candidates) if (c.response) expect(['hold', 'press']).toContain(c.response.kind);
    // responseCount < 2 est ramené à 2 ; > 4 à 4.
    const one = cloneParams(P);
    one.decision.responseCount = 1;
    expect(decideOnBall(mkInput(full(), 1, one), 6, null).candidates.some((c) => c.response)).toBe(true);
  });

  it('minimax : Q(a) sous 4 réponses ≤ Q(a) sous {hold, press} pour chaque candidat développé (le min sur un sur-ensemble ne peut qu’être plus petit)', () => {
    const two = cloneParams(P);
    two.decision.responseCount = 2;
    two.decision.softmaxTemperature = 0;
    const four = cloneParams(two);
    four.decision.responseCount = 4;
    const state = full();
    const d2 = decideOnBall(mkInput(state, 1, two), 6, null);
    const d4 = decideOnBall(mkInput(state, 1, four), 6, null);
    const key = (c: Candidate): string => JSON.stringify(c.action);
    const by2 = new Map(d2.candidates.map((c) => [key(c), c]));
    let compared = 0;
    for (const c of d4.candidates) {
      if (!c.response) continue;
      const o = by2.get(key(c));
      if (!o || !o.response) continue;
      expect(c.score).toBeLessThanOrEqual(o.score + 1e-9);
      compared++;
    }
    expect(compared).toBeGreaterThan(0);
  });

  /** Quasi-égalité construite : passe au pied vers n°1 (marqué de loin) contre dribble vers l'avant, à ≈ 0,011 l'une de l'autre. */
  const dilemma = (): MatchState => simple([
    { team: 'A', pos: v(10, 0) }, { team: 'A', pos: v(22, 6) }, { team: 'A', pos: v(4, -10) },
    { team: 'B', pos: v(52, 0), role: 'GK' }, { team: 'B', pos: v(26, 8), role: 'DF' }, { team: 'B', pos: v(16, -4), role: 'DF' }, { team: 'B', pos: v(30, -10), role: 'DF' },
  ]);

  it('jeu 2×2 : une quasi-égalité passe/dribble (|Q₁ − Q₂| < ε_game) déclenche Decision.game ; l’action choisie est l’une des deux ; matrice cohérente', () => {
    const d0 = decideOnBall(mkInput(dilemma(), 1, P), 0, null);
    const c0 = gameClass(d0.candidates[0].action), c1 = gameClass(d0.candidates[1].action);
    expect(c0).not.toBe(c1); // la situation construite est bien un dilemme de classes différentes
    expect(Math.abs(d0.candidates[0].score - d0.candidates[1].score)).toBeLessThan(P.decision.epsilonGame);
    expect(d0.game).toBeDefined();
    expect([d0.candidates[0], d0.candidates[1]]).toContain(d0.chosen);
    // Sur des états variés (ε_game large : tout couple de classes différentes est un dilemme), propriétés du jeu joué.
    const wide = cloneParams(P);
    wide.decision.epsilonGame = 10;
    let games = 0;
    const states: MatchState[] = [dilemma(), ...[1, 2, 3, 4, 5].map((s) => buildFullState({ ownerId: 6, ballPos: v(-6 + 4 * s, -12 + 3 * s) }))];
    for (let i = 0; i < states.length; i++) {
      const state = states[i];
      const d = decideOnBall(mkInput(state, i + 1, wide), state.ball.ownerId!, null);
      if (!d.game) continue;
      games++;
      const g = d.game;
      expect(g.responses).toEqual(['press', 'cover']);
      expect(g.actions.length).toBe(2);
      expect([d.candidates[0], d.candidates[1]]).toContain(d.chosen);
      expect(g.pi1).toBeGreaterThanOrEqual(0);
      expect(g.pi1).toBeLessThanOrEqual(1);
      for (const row of g.matrix) for (const x of row) expect(Number.isFinite(x)).toBe(true);
      // Stratégie pure ⇒ l'action jouée est la ligne du maximin ; valeur = maximin.
      const rowMin = g.matrix.map((r) => Math.min(r[0], r[1]));
      if (g.pure) {
        expect(d.chosen).toBe(rowMin[0] >= rowMin[1] ? d.candidates[0] : d.candidates[1]);
        expect(g.value).toBeCloseTo(Math.max(rowMin[0], rowMin[1]), 12);
      } else {
        expect(solve2x2(g.matrix).pi1).toBeCloseTo(g.pi1, 12);
      }
      // Les deux actions sont de classes différentes parmi {tir, passe, dribble}.
      const k0 = gameClass(d.candidates[0].action), k1 = gameClass(d.candidates[1].action);
      expect(k0).not.toBeNull();
      expect(k1).not.toBeNull();
      expect(k0).not.toBe(k1);
      // Engagement pour la durée de l'action (au moins gameCommitMin pour un dribble / une conservation).
      expect(d.committedUntil).toBeDefined();
      const minCommit = d.chosen.action.type === 'dribble' || d.chosen.action.type === 'hold' ? Math.max(d.chosen.duration!, wide.decision.gameCommitMin!) : d.chosen.duration!;
      expect(d.committedUntil!).toBeCloseTo(state.time + minCommit, 9);
      // Explication : ligne « JEU 2×2 » avec matrice, π₁ et valeur.
      const text = explainDecision(d, state);
      expect(text).toMatch(/JEU 2×2 : matrice \[\[.+\] ; \[.+\]\], π₁ = \d,\d\d, valeur /);
      expect(text.split('\n').length).toBeLessThanOrEqual(12);
    }
    expect(games).toBeGreaterThan(0);
    // ε_game = 0 : jamais de jeu, et la sélection §6.5 s'applique (argmax).
    const none = cloneParams(P);
    none.decision.epsilonGame = 0;
    none.decision.softmaxTemperature = 0;
    const dn = decideOnBall(mkInput(dilemma(), 1, none), 0, null);
    expect(dn.game).toBeUndefined();
    expect(dn.chosen).toBe(dn.candidates[0]);
    for (const seed of [1, 2, 3]) expect(decideOnBall(mkInput(full(), seed, none), 6, null).game).toBeUndefined();
    // Déterminisme : même graine ⇒ même jeu, même action.
    const a = decideOnBall(mkInput(dilemma(), 5, P), 0, null), b = decideOnBall(mkInput(dilemma(), 5, P), 0, null);
    expect(a.game).toEqual(b.game);
    expect(a.chosen.action).toEqual(b.chosen.action);
  });

  it('jeu 2×2 : le tirage à l’équilibre mixte est reproductible (même graine ⇒ même action) et suit π₁ sur les graines', () => {
    // Deux candidats fictifs de classes différentes avec des valeurs croisées sous {press, cover} : on force le dilemme en
    // rendant la matrice « matching pennies » via une résolution directe, puis on vérifie le tirage avec le RNG de la décision.
    const sol = solve2x2([[0.2, 0.1], [0.1, 0.2]]);
    expect(sol.pure).toBe(false);
    expect(sol.pi1).toBeCloseTo(0.5, 12);
    let first = 0;
    for (let seed = 1; seed <= 200; seed++) if (drawAction(sol, new Rng(seed)) === 0) first++;
    expect(first).toBeGreaterThan(70);
    expect(first).toBeLessThan(130);
    expect(drawAction(sol, new Rng(7))).toBe(drawAction(sol, new Rng(7)));
  });

  it('explication : ligne « RÉPONSE ADVERSE : <réponse> (dégrade de x) » pour un candidat développé avec dégradation', () => {
    let shown = 0;
    for (const seed of [1, 2, 3, 4]) {
      const state = buildFullState({ ownerId: 6, ballPos: v(-6 + 3 * seed, -12) });
      const d = decideOnBall(mkInput(state, seed, P), 6, null);
      const r = d.chosen.response;
      if (!r || (r.kind === 'hold' && Math.abs(r.delta) <= 1e-4)) continue;
      const line = d.explanation.split('\n').find((l) => l.startsWith('RÉPONSE ADVERSE : '));
      expect(line).toBeDefined();
      const name = { hold: 'tenir la forme', press: 'presser le receveur', cover: 'couvrir la ligne de passe', drop: 'reculer la ligne' }[r.kind];
      expect(line).toContain(name);
      if (r.delta >= 0) expect(line).toMatch(/\(dégrade de \d,\d{3}\)/);
      shown++;
    }
    expect(shown).toBeGreaterThan(0);
  });
});
