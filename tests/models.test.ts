/**
 * Tests des modèles spatiaux et probabilistes (src/models) : propriétés mathématiques (limites,
 * monotonie, symétrie miroir A/B, conservation), ancrages de calibration de docs/CONCEPTION.md §4–5,
 * déterminisme et budget de performance.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_PARAMS, cloneParams } from '@/core/params';
import { buildState, buildFullState, type PlayerSpec } from '@/core/state-builder';
import { PITCH, goalAngle } from '@/core/pitch';
import type { MatchState, SimParams, TeamId } from '@/core/types';
import type { Vec2 } from '@/core/vec2';
import { timeToArrive, runTime, runTimeFrom, dribbleTime, launchSpeed, ballTravelTime, ballDistanceAt, ballSpeedAt, lobFlight, lobHeightAt, GRAVITY } from '@/models/motion';
import { executeAction } from '@/engine/actions';
import { stepPhysics } from '@/engine/physics';
import { Rng } from '@/core/rng';
import { computeFields, pitchControlAt, pressureAt, threatAt, geometricXG, availableSpace } from '@/models/fields';
import { analyseInterception, flightModel, passingLaneQuality, arrivalLogistic, lineBreaks, laneAngularMargin, interceptionFeatures, rescoreInterception, interceptionModelOf } from '@/models/interception';
import { passProbability, throughBallProbability, dribbleProbability, shotProbability, holdProbability, keeperCoverage, passLogit } from '@/models/probability';
import { anticipatedTarget, drivenArrivalSpeed, planPassVariants, longPassDistance } from '@/decision/candidates';
import { localSuperiority, compactness, offsideLine, isOffsidePosition, voronoiArea, convexHull, polygonArea } from '@/models/structure';

const P: SimParams = DEFAULT_PARAMS;
const M = P.models;
const PH = P.physics;
const v = (x: number, y: number): Vec2 => ({ x, y });
const mirror = (p: Vec2): Vec2 => ({ x: -p.x, y: -p.y });

/** État « équipe A attaque » : porteur A en 0, receveur A en 1, puis des B. */
function simple(players: PlayerSpec[], ownerId: number | null = 0): MatchState {
  // buildState attribue le rôle GK au numéro 1 (ids 0 et 11) : on force « joueur de champ » sauf mention explicite.
  const specs = players.map((p) => ({ ...p, role: p.role ?? 'MF' }));
  return buildState({ players: specs, ball: ownerId === null ? undefined : { pos: specs[ownerId].pos, ownerId } });
}

/** État miroir : (x, y) ↦ (−x, −y) pour positions et vitesses, équipes échangées (A ↔ B). */
function mirrorState(state: MatchState): MatchState {
  const players: PlayerSpec[] = state.players.map((p) => ({
    team: (p.team === 'A' ? 'B' : 'A') as TeamId,
    pos: mirror(p.pos),
    vel: mirror(p.vel),
    role: p.role,
    number: p.number,
    attrs: p.attrs,
  }));
  const owner = state.ball.ownerId;
  return buildState({ players, ball: { pos: mirror(state.ball.pos), ownerId: owner } });
}

/** Tir : tireur A en (x, y), gardien B centré sur sa ligne, un B lointain. */
function shotState(x: number, y: number, keeperPos: Vec2 = v(52.5, 0), extraB: Vec2[] = []): MatchState {
  return simple([
    { team: 'A', pos: v(x, y) },
    { team: 'B', pos: keeperPos, role: 'GK', number: 1 },
    { team: 'B', pos: v(-45, 30) },
    ...extraB.map((pos) => ({ team: 'B' as TeamId, pos })),
  ]);
}

// ---------------------------------------------------------------------------
describe('motion — modèle cinématique (§3.2, §4.1)', () => {
  const vmax = 8, amax = 5;
  it('T(p′) = τ_r, croissant en la distance et continu en d_acc', () => {
    const t0 = timeToArrive(v(0, 0), v(0, 0), v(0, 0), vmax, amax, M);
    expect(t0).toBeCloseTo(M.reactionTime, 9);
    const dAcc = (vmax * vmax) / (2 * amax);
    let prev = 0;
    for (let d = 0; d <= 60; d += 0.25) {
      const t = timeToArrive(v(0, 0), v(0, 0), v(d, 0), vmax, amax, M);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
    const left = runTime(dAcc - 1e-6, vmax, amax), right = runTime(dAcc + 1e-6, vmax, amax);
    expect(Math.abs(left - right)).toBeLessThan(1e-5);
    // Sprint de 40 m départ arrêté : τ + v/a + (40 − v²/2a)/v ≈ 0,3 + 1,6 + 4,2 = 6,1 s (§3.1)
    expect(timeToArrive(v(0, 0), v(0, 0), v(40, 0), vmax, amax, M)).toBeCloseTo(6.1, 2);
  });

  it('forme fermée = intégration numérique du mouvement à accélération bornée', () => {
    const dt = 1e-4;
    for (const d of [1, 3, 6.4, 10, 25, 50]) {
      let x = 0, s = 0, t = 0;
      while (x < d) {
        s = Math.min(vmax, s + amax * dt);
        x += s * dt;
        t += dt;
      }
      expect(Math.abs(runTime(d, vmax, amax) - t)).toBeLessThan(2e-3);
    }
  });

  it('la vitesse courante déplace le point de départ de τ_r·v', () => {
    const still = timeToArrive(v(0, 0), v(0, 0), v(20, 0), vmax, amax, M);
    const towards = timeToArrive(v(0, 0), v(6, 0), v(20, 0), vmax, amax, M);
    const away = timeToArrive(v(0, 0), v(-6, 0), v(20, 0), vmax, amax, M);
    expect(towards).toBeLessThan(still);
    expect(away).toBeGreaterThan(still);
    expect(towards).toBeCloseTo(timeToArrive(v(6 * M.reactionTime, 0), v(0, 0), v(20, 0), vmax, amax, M), 9);
  });

  it('launchSpeed / ballTravelTime : aller-retour et exemple du §3.2 (20 m, 6 m/s ⇒ 9,8 m/s, 2,5 s)', () => {
    const s0 = launchSpeed(20, 6, PH);
    expect(s0).toBeCloseTo(9.8, 1);
    const T = ballTravelTime(20, s0, PH);
    expect(T).toBeCloseTo(2.5, 1);
    expect(ballDistanceAt(s0, T, PH)).toBeCloseTo(20, 6);
    expect(ballSpeedAt(s0, T, PH)).toBeCloseTo(6, 6);
    for (const d of [3, 12, 40]) for (const sArr of [4, 6, 9]) {
      const s = launchSpeed(d, sArr, PH);
      expect(ballDistanceAt(s, ballTravelTime(d, s, PH), PH)).toBeCloseTo(d, 6);
    }
  });

  it('runTimeFrom : v0 = 0 ⇔ runTime, décroissant en v0, continu en d_acc ; dribbleTime plafonné à v_drib et sans réaction', () => {
    for (const d of [1, 3, 6.4, 10, 30]) expect(runTimeFrom(d, 0, 8, 5)).toBeCloseTo(runTime(d, 8, 5), 12);
    let prev = Infinity;
    for (const v0 of [0, 2, 4, 6, 8]) { const t = runTimeFrom(10, v0, 8, 5); expect(t).toBeLessThan(prev); prev = t; }
    expect(runTimeFrom(10, 8, 8, 5)).toBeCloseTo(10 / 8, 12); // déjà à vitesse max : vitesse constante
    expect(runTimeFrom(10, 12, 8, 5)).toBeCloseTo(10 / 8, 12); // v0 borné à v_max
    const dAcc = (64 - 16) / (2 * 5);
    expect(runTimeFrom(dAcc + 1e-9, 4, 8, 5)).toBeCloseTo(runTimeFrom(dAcc - 1e-9, 4, 8, 5), 6);
    // dribble : 4 m départ arrêté à v_drib = 6 m/s, a = 5 (d_acc = 3,6 m) ⇒ 1,27 s (et non d/v_drib = 0,67 s)
    const t4 = dribbleTime(v(0, 0), v(0, 0), v(4, 0), 8, 5, PH);
    expect(t4).toBeCloseTo(runTimeFrom(4, 0, 6, 5), 9);
    expect(t4).toBeCloseTo(6 / 5 + (4 - 3.6) / 6, 6);
    expect(t4).toBeGreaterThan(4 / 6);
    // lancé à 6 m/s dans la direction du dribble : d/v_drib exactement ; vers l'arrière : comme à l'arrêt
    expect(dribbleTime(v(0, 0), v(6, 0), v(4, 0), 8, 5, PH)).toBeCloseTo(4 / 6, 6);
    expect(dribbleTime(v(0, 0), v(-6, 0), v(4, 0), 8, 5, PH)).toBeCloseTo(t4, 6);
    expect(dribbleTime(v(3, 2), v(0, 0), v(3, 2), 8, 5, PH)).toBe(0);
  });

  it('lobFlight : portée exacte sous la pesanteur, apogée g T²/8, hauteur nulle aux extrémités', () => {
    for (const d of [10, 25, 40, 60]) {
      const lf = lobFlight(d, PH);
      expect(lf.horizontalSpeed * lf.travelTime).toBeCloseTo(d, 9);
      expect(lf.vz * lf.travelTime - 0.5 * GRAVITY * lf.travelTime * lf.travelTime).toBeCloseTo(0, 9); // retombe à z = 0 en T
      expect(lf.apex).toBeCloseTo((GRAVITY * lf.travelTime * lf.travelTime) / 8, 9);
      expect(lobHeightAt(lf.apex, 0)).toBe(0);
      expect(lobHeightAt(lf.apex, 1)).toBe(0);
      expect(lobHeightAt(lf.apex, 0.5)).toBeCloseTo(lf.apex, 9);
    }
    expect(lobFlight(25, PH).travelTime).toBeGreaterThan(lobFlight(10, PH).travelTime);
  });

  it('ballTravelTime = Infinity au-delà de la portée, distance bornée à la portée, vitesse bornée à s₀ᵐᵃˣ', () => {
    const s0 = 6; // portée s₀²/2μ = 12 m
    expect(ballTravelTime(11.9, s0, PH)).toBeLessThan(Infinity);
    expect(ballTravelTime(12.1, s0, PH)).toBe(Infinity);
    expect(ballDistanceAt(s0, 100, PH)).toBeCloseTo(12, 9);
    expect(launchSpeed(500, 9, PH)).toBe(PH.passSpeedMax);
    expect(ballTravelTime(0, s0, PH)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('fields — contrôle du terrain (§4.2)', () => {
  it('PC_A + PC_B = 1 et le champ coïncide avec la version ponctuelle aux nœuds', () => {
    const st = buildFullState({ ballPos: v(0, 0), ownerId: 9 });
    const f = computeFields(st, P);
    for (const q of [v(0, 0), v(20.5, 10), v(-30, -20), v(45, 0)]) {
      const a = pitchControlAt(st, q, 'A', P), b = pitchControlAt(st, q, 'B', P);
      expect(a + b).toBeCloseTo(1, 9);
    }
    // nœuds de la grille : xOf(i) = −52,5 + 2i, yOf(j) = −34 + 2j
    for (const q of [v(-0.5, 0), v(19.5, 10), v(-30.5, -20), v(41.5, 4)]) {
      expect(f.controlA.sample(q)).toBeCloseTo(pitchControlAt(st, q, 'A', P), 4);
    }
  });

  it('limite Voronoï : β → 0 ⇒ contrôle = 1 pour les cellules de l’équipe la plus rapide (joueurs immobiles)', () => {
    const params = cloneParams(P);
    params.models.controlBeta = 0.01;
    const st = simple([
      { team: 'A', pos: v(-20, 0) }, { team: 'A', pos: v(-10, 15) },
      { team: 'B', pos: v(20, 0) }, { team: 'B', pos: v(10, -15) },
    ], null);
    const f = computeFields(st, params);
    let checked = 0;
    f.controlA.forEach((val, x, y) => {
      if (Math.abs(x) > PITCH.halfLength) return;
      let best = Infinity, bestTeam: TeamId = 'A';
      for (const p of st.players) {
        const d = Math.hypot(p.pos.x - x, p.pos.y - y);
        if (d < best - 1e-6) { best = d; bestTeam = p.team; }
      }
      // on ignore les cellules équidistantes (frontière)
      const second = Math.min(...st.players.filter((p) => p.team !== bestTeam).map((p) => Math.hypot(p.pos.x - x, p.pos.y - y)));
      if (second - best < 1.0) return;
      expect(Math.abs(val - (bestTeam === 'A' ? 1 : 0))).toBeLessThan(1e-3);
      checked++;
    });
    expect(checked).toBeGreaterThan(1000);
    expect(Number.isNaN(f.controlA.sample(v(50, 30)))).toBe(false);
  });

  it('symétrie miroir : état miroir ⇒ champs miroir (contrôle, pression, menace)', () => {
    const st = buildFullState({ ballPos: v(12, -5), ownerId: 7, shift: { A: v(8, 0), B: v(4, 3) } });
    const ms = mirrorState(st);
    const f = computeFields(st, P), g = computeFields(ms, P);
    for (const q of [v(0, 0), v(15, 8), v(-22, -12), v(40, 3), v(-45, 20)]) {
      expect(pitchControlAt(st, q, 'A', P)).toBeCloseTo(pitchControlAt(ms, mirror(q), 'B', P), 9);
      expect(pressureAt(st, q, 'A', P)).toBeCloseTo(pressureAt(ms, mirror(q), 'B', P), 9);
      expect(threatAt(q, 'A', P)).toBeCloseTo(threatAt(mirror(q), 'B', P), 12);
      // grilles (interpolation bilinéaire sur des nœuds non miroir en x : tolérance)
      expect(Math.abs(f.controlA.sample(q) - (1 - g.controlA.sample(mirror(q))))).toBeLessThan(0.05);
      expect(Math.abs(f.pressureByB.sample(q) - g.pressureByA.sample(mirror(q)))).toBeLessThan(0.05);
      expect(Math.abs(f.threatA.sample(q) - g.threatB.sample(mirror(q)))).toBeLessThan(0.01);
    }
  });

  it('le gardien ne participe au contrôle que dans sa surface', () => {
    const st = simple([
      { team: 'A', pos: v(-48, 0), role: 'GK', number: 1 },
      { team: 'B', pos: v(0, 0), number: 5 },
    ], null);
    // Dans la surface de A (x < −36) : le gardien (2 m) domine largement le B (48 m)
    expect(pitchControlAt(st, v(-46, 0), 'A', P)).toBeGreaterThan(0.9);
    // Hors de sa surface : le gardien est ignoré, B a tout le contrôle même loin
    expect(pitchControlAt(st, v(-30, 0), 'A', P)).toBeCloseTo(0, 9);
  });

  it('déterminisme : deux calculs sur le même état donnent des champs identiques', () => {
    const st = buildFullState({ ballPos: v(5, 5), ownerId: 6 });
    const f = computeFields(st, P), g = computeFields(st, P);
    expect(f.controlA.data).toEqual(g.controlA.data);
    expect(f.pressureByA.data).toEqual(g.pressureByA.data);
    expect(f.threatB.data).toEqual(g.threatB.data);
    expect(f.argminPlayer).toEqual(g.argminPlayer);
    expect(f.exposureA).toBe(g.exposureA);
  });

  it('argmin et espace disponible : un joueur isolé possède ≈ π R_s² autour de lui', () => {
    const st = simple([{ team: 'A', pos: v(0, 0) }, { team: 'B', pos: v(40, 20) }], null);
    const f = computeFields(st, P);
    const space = availableSpace(f, 0, v(0, 0), 8);
    expect(Math.abs(space - Math.PI * 64)).toBeLessThan(40);
    expect(availableSpace(f, 1, v(0, 0), 8)).toBe(0);
  });

  it('arrivalTime n’est alloué que sur demande ; les tampons réutilisés donnent les mêmes champs (états différents à la suite)', () => {
    const a = buildFullState({ ballPos: v(0, 0), ownerId: 9 });
    const b = simple([{ team: 'A', pos: v(-30, 10) }, { team: 'B', pos: v(20, -5) }, { team: 'B', pos: v(0, 0) }], null);
    const fa1 = computeFields(a, P);
    expect(fa1.arrivalTime).toBeUndefined();
    computeFields(b, P); // état plus petit entre deux calculs : les tampons ne doivent rien laisser fuir
    const fa2 = computeFields(a, P);
    expect(Array.from(fa2.controlA.data)).toEqual(Array.from(fa1.controlA.data));
    expect(fa2.exposureA).toBe(fa1.exposureA);
    const withT = computeFields(a, P, true);
    expect(withT.arrivalTime).toHaveLength(a.players.length);
    const p = a.players[3];
    const q = v(withT.controlA.xOf(10), withT.controlA.yOf(7));
    expect(withT.arrivalTime![3].get(10, 7)).toBeCloseTo(timeToArrive(p.pos, p.vel, q, p.maxSpeed, p.maxAccel, M), 4);
  });

  it('budget de performance : computeFields < 8 ms (22 joueurs, grille 2 m)', () => {
    const st = buildFullState({ ballPos: v(0, 0), ownerId: 9 });
    for (let i = 0; i < 5; i++) computeFields(st, P);
    const t0 = performance.now();
    const N = 20;
    for (let i = 0; i < N; i++) computeFields(st, P);
    const ms = (performance.now() - t0) / N;
    expect(ms).toBeLessThan(8);
  });
});

// ---------------------------------------------------------------------------
describe('fields — menace et xG géométrique (§4.3)', () => {
  it('ancrages du xG géométrique : penalty ≈ 0,29, 18 m ≈ 0,10, 30 m ≈ 0,03, propre camp ≈ 0', () => {
    expect(geometricXG(v(52.5 - 11, 0), 'A', P)).toBeCloseTo(0.29, 1);
    expect(Math.abs(geometricXG(v(52.5 - 18, 0), 'A', P) - 0.10)).toBeLessThan(0.03);
    expect(Math.abs(geometricXG(v(52.5 - 30, 0), 'A', P) - 0.03)).toBeLessThan(0.015);
    expect(geometricXG(v(-10, 0), 'A', P)).toBeLessThan(0.005);
  });

  it('derrière la ligne de but, xG et menace valent ceux du point de la ligne (pas de menace hors du terrain)', () => {
    // sans garde, l'angle de tir reste grand derrière le but : threatA(60, 0) ≈ 0,62 et le nœud x = 53,5 ≈ 1
    const onLine = threatAt(v(PITCH.halfLength, 0), 'A', P);
    expect(threatAt(v(60, 0), 'A', P)).toBeCloseTo(onLine, 12);
    expect(threatAt(v(53.5, 0), 'A', P)).toBeCloseTo(onLine, 12);
    expect(geometricXG(v(53.5, 0), 'A', P)).toBeCloseTo(geometricXG(v(PITCH.halfLength, 0), 'A', P), 12);
    expect(threatAt(v(0, 40), 'A', P)).toBeCloseTo(threatAt(v(0, PITCH.halfWidth), 'A', P), 12);
    // le nœud hors terrain (x = 53,5 m) ne dépasse jamais la valeur sur la ligne de but
    const f = computeFields(buildFullState({ ballPos: v(0, 0), ownerId: 9 }), P);
    const last = f.threatA.cols - 1;
    expect(f.threatA.xOf(last)).toBeGreaterThan(PITCH.halfLength);
    for (let j = 0; j < f.threatA.rows; j++) expect(f.threatA.get(last, j)).toBeLessThanOrEqual(onLine + 1e-6);
  });

  it('exposition : A et B sont exactement miroir (les nœuds hors du terrain sont exclus de la somme)', () => {
    const st = buildFullState({ ballPos: v(0, 0), ownerId: 9 });
    const f = computeFields(st, P);
    const fm = computeFields(mirrorState(st), P);
    // la grille elle-même n'est pas miroir (nœuds −52,5 … 51,5 | 53,5 avec Δ = 2 m) : tolérance 1 % (2 % avant l'exclusion)
    expect(Math.abs(f.exposureA! - fm.exposureB!)).toBeLessThan(0.01 * f.exposureA!);
    expect(Math.abs(f.exposureB! - fm.exposureA!)).toBeLessThan(0.01 * f.exposureB!);
    // état symétrique (positions miroir, équipes échangées) ⇒ exposition égale des deux côtés
    const sym = simple([{ team: 'A', pos: v(-20, 5) }, { team: 'A', pos: v(-5, -10) }, { team: 'B', pos: v(20, -5) }, { team: 'B', pos: v(5, 10) }], null);
    const fs = computeFields(sym, P);
    expect(Math.abs(fs.exposureA! - fs.exposureB!)).toBeLessThan(0.01 * fs.exposureA!);
  });

  it('xG géométrique décroît avec la distance et croît avec l’angle', () => {
    let prev = 1;
    for (let d = 5; d <= 60; d += 1) {
      const xg = geometricXG(v(52.5 - d, 0), 'A', P);
      expect(xg).toBeLessThan(prev);
      prev = xg;
    }
    // même distance au but, angle plus ouvert dans l'axe qu'excentré
    const central = geometricXG(v(52.5 - 15, 0), 'A', P);
    const wide = geometricXG(v(52.5 - 15 * Math.cos(0.9), 15 * Math.sin(0.9)), 'A', P);
    expect(goalAngle(v(52.5 - 15, 0), 1)).toBeGreaterThan(goalAngle(v(52.5 - 15 * Math.cos(0.9), 15 * Math.sin(0.9)), 1));
    expect(central).toBeGreaterThan(wide);
  });

  it('ancrages de la menace xT : propre surface ≈ 0,005, rond central ≈ 0,03, entrée de surface ≈ 0,22 ; xT_B = miroir', () => {
    expect(Math.abs(threatAt(v(-40, 0), 'A', P) - 0.005)).toBeLessThan(0.005);
    expect(Math.abs(threatAt(v(0, 0), 'A', P) - 0.034)).toBeLessThan(0.01);
    expect(Math.abs(threatAt(v(36, 0), 'A', P) - 0.22)).toBeLessThan(0.02);
    const st = buildFullState();
    const f = computeFields(st, P);
    expect(f.threatB.sample(v(-36, 0))).toBeCloseTo(threatAt(v(36, 0), 'A', P), 2);
    expect(f.threatA.sample(v(36, 0))).toBeGreaterThan(f.threatA.sample(v(0, 0)));
  });
});

// ---------------------------------------------------------------------------
describe('fields — pression (§4.4)', () => {
  it('un défenseur côté but pèse plus qu’un défenseur dans le dos, un défenseur qui ferme pèse plus', () => {
    const q = v(0, 0);
    const goalSide = simple([{ team: 'A', pos: q }, { team: 'B', pos: v(3, 0) }]);
    const behind = simple([{ team: 'A', pos: q }, { team: 'B', pos: v(-3, 0) }]);
    const closing = simple([{ team: 'A', pos: q }, { team: 'B', pos: v(3, 0), vel: v(-8, 0) }]);
    const g = Math.exp(-9 / (2 * M.pressureRadius ** 2));
    expect(pressureAt(goalSide, q, 'A', P)).toBeCloseTo(g * (1 + M.pressureDirectional), 9);
    expect(pressureAt(behind, q, 'A', P)).toBeCloseTo(g * (1 - M.pressureDirectional), 9);
    expect(pressureAt(closing, q, 'A', P)).toBeCloseTo(g * (1 + M.pressureDirectional) * (1 + (M.pressureClosing ?? 0.5)), 9);
    // les coéquipiers n'exercent aucune pression sur leur propre équipe
    expect(pressureAt(goalSide, q, 'B', P)).toBeCloseTo(1, 9); // le joueur A en q pèse exactement 1 sur B
  });

  it('la pression décroît avec la distance et le champ coïncide avec la version ponctuelle', () => {
    let prev = Infinity;
    for (let d = 0; d <= 12; d += 0.5) {
      const st = simple([{ team: 'A', pos: v(0, 0) }, { team: 'B', pos: v(0, d) }]);
      const pi = pressureAt(st, v(0, 0), 'A', P);
      expect(pi).toBeLessThanOrEqual(prev + 1e-12);
      prev = pi;
    }
    const st = buildFullState({ ballPos: v(10, 4), ownerId: 9 });
    const f = computeFields(st, P);
    for (const q of [v(9.5, 4), v(-30.5, -20), v(41.5, 4)]) {
      expect(f.pressureByB.sample(q)).toBeCloseTo(pressureAt(st, q, 'A', P), 3);
      expect(f.pressureByA.sample(q)).toBeCloseTo(pressureAt(st, q, 'B', P), 3);
    }
  });
});

// ---------------------------------------------------------------------------
describe('interception (§4.6)', () => {
  const from = v(0, 0), to = v(20, 0);
  it('logit⁻¹ à l’échelle logistique : 0,5 en 0, symétrique', () => {
    expect(arrivalLogistic(0)).toBeCloseTo(0.5, 12);
    expect(arrivalLogistic(1) + arrivalLogistic(-1)).toBeCloseTo(1, 12);
    expect(arrivalLogistic(5)).toBeGreaterThan(0.99);
  });

  it('couloir vide ⇒ P_int ≈ 0 ; défenseur à 2 m d’une passe de 20 m ⇒ P_int ≥ 0,3 (cas de calibration)', () => {
    const empty = simple([{ team: 'A', pos: from }, { team: 'A', pos: to }, { team: 'B', pos: v(10, 25) }, { team: 'B', pos: v(-40, 20) }]);
    const e = analyseInterception(empty, from, to, 'pass', 'A', P);
    expect(e.pIntercept).toBeLessThan(0.01);
    expect(e.threats).toEqual([]);
    expect(e.samples).toHaveLength(M.interceptSamples);
    expect(e.initialSpeed).toBeCloseTo(9.8, 1);
    expect(e.travelTime).toBeCloseTo(2.5, 1);

    const guarded = simple([{ team: 'A', pos: from }, { team: 'A', pos: to }, { team: 'B', pos: v(10, 2) }, { team: 'B', pos: v(-40, 20) }]);
    const g = analyseInterception(guarded, from, to, 'pass', 'A', P);
    // Une chance par défenseur : P_int = η·Φ_j pour un seul défenseur menaçant (Φ_j = max_m φ_{j,m}), donc ≤ η.
    expect(g.pIntercept).toBeGreaterThanOrEqual(0.7 * M.interceptEfficiency);
    expect(g.pIntercept).toBeLessThanOrEqual(M.interceptEfficiency + 1e-9);
    expect(g.pIntercept).toBeCloseTo(M.interceptEfficiency * g.defenderPhi[g.defenderIds.indexOf(2)], 9);
    expect(g.threats).toEqual([2]);
    expect(g.weakOpponentId).toBe(2);
    expect(g.weakPhi).toBeGreaterThan(0.4);
    expect(g.defenderPhi[g.defenderIds.indexOf(2)]).toBeCloseTo(g.weakPhi, 12);
    // borne : P_int(η = 1) ≥ W
    const p1 = cloneParams(P); p1.models.interceptEfficiency = 1;
    expect(analyseInterception(guarded, from, to, 'pass', 'A', p1).pIntercept).toBeGreaterThanOrEqual(g.weakPhi - 1e-9);
    // Un défenseur qui couvre toute la ligne (course parallèle à 1 m d'une passe lente) n'a qu'une tentative : P_int = η, pas 1 − (1 − η)¹².
    const alongside = simple([{ team: 'A', pos: from }, { team: 'A', pos: to }, { team: 'B', pos: v(10, 1), vel: v(0, 0) }]);
    const a = analyseInterception(alongside, from, to, 'pass', 'A', P, 4);
    expect(a.weakPhi).toBeGreaterThan(0.98);
    expect(a.pIntercept).toBeLessThanOrEqual(M.interceptEfficiency + 1e-9);
    expect(a.pIntercept).toBeGreaterThan(0.95 * M.interceptEfficiency);
    // Deux défenseurs indépendants se combinent : 1 − (1 − ηΦ₁)(1 − ηΦ₂).
    const two = simple([{ team: 'A', pos: from }, { team: 'A', pos: to }, { team: 'B', pos: v(6, 1) }, { team: 'B', pos: v(14, -1) }]);
    const t2 = analyseInterception(two, from, to, 'pass', 'A', P);
    const eta = M.interceptEfficiency;
    expect(t2.pIntercept).toBeCloseTo(1 - (1 - eta * t2.defenderPhi[0]) * (1 - eta * t2.defenderPhi[1]), 9);
    // Fenêtre w = 1 : chance élargie aux échantillons voisins, jamais inférieure au meilleur point seul.
    const pw = cloneParams(P); pw.models.interceptWindow = 1;
    expect(analyseInterception(guarded, from, to, 'pass', 'A', pw).pIntercept).toBeGreaterThanOrEqual(g.pIntercept - 1e-12);
    // le dernier échantillon est la cible, les temps balle sont croissants
    expect(g.samples[g.samples.length - 1].point.x).toBeCloseTo(20, 9);
    for (let i = 1; i < g.samples.length; i++) expect(g.samples[i].ballTime).toBeGreaterThan(g.samples[i - 1].ballTime);
  });

  it('P_int décroît quand le défenseur s’éloigne de la ligne et croît avec la lenteur de la passe', () => {
    let prev = 1;
    for (const off of [1, 2, 4, 6, 9, 13]) {
      const st = simple([{ team: 'A', pos: from }, { team: 'A', pos: to }, { team: 'B', pos: v(10, off) }]);
      const p = analyseInterception(st, from, to, 'pass', 'A', P).pIntercept;
      expect(p).toBeLessThan(prev);
      prev = p;
    }
    const st = simple([{ team: 'A', pos: from }, { team: 'A', pos: to }, { team: 'B', pos: v(10, 4) }]);
    const slow = analyseInterception(st, from, to, 'pass', 'A', P, 4).pIntercept;
    const fast = analyseInterception(st, from, to, 'pass', 'A', P, 9).pIntercept;
    expect(fast).toBeLessThan(slow);
  });

  it('lob : vol du moteur (45°), interceptable seulement sous la hauteur de contrôle et à l’atterrissage ; tir : ligne droite rapide', () => {
    const target = v(40, 0);
    const lf = lobFlight(40, PH);
    const model = flightModel('lob', 40, P);
    expect(model.travelTime).toBeCloseTo(lf.travelTime, 12);
    expect(model.initialSpeed).toBeCloseTo(lf.initialSpeed, 12);
    expect(model.heightAt(0.5)).toBeCloseTo(lf.apex, 12);
    const mid = simple([{ team: 'A', pos: from }, { team: 'A', pos: target }, { team: 'B', pos: v(20, 1) }]);
    const lobMid = analyseInterception(mid, from, target, 'lob', 'A', P);
    const passMid = analyseInterception(mid, from, target, 'pass', 'A', P);
    expect(lobMid.travelTime).toBeCloseTo(lf.travelTime, 12);
    // le défenseur au milieu ne peut jouer que la zone de chute : P_int faible mais non nulle (course vers 40 m) ;
    // au sol il est sur la ligne (φ ≈ 1) : P_int = η (une chance par défenseur)
    expect(lobMid.pIntercept).toBeLessThan(0.2);
    expect(passMid.pIntercept).toBeGreaterThan(0.9 * M.interceptEfficiency);
    expect(lobMid.pIntercept).toBeLessThan(0.5 * passMid.pIntercept); // (P_int au sol bornée par η : ratio 0,3 → 0,5)
    // en vol au-dessus de physics.controlMaxHeight : aucune chance (même condition que la prise de balle du moteur)
    for (let i = 0; i < lobMid.samples.length; i++) {
      const f = (i + 1) / lobMid.samples.length;
      if (f < 1 && lobHeightAt(lf.apex, f) >= PH.controlMaxHeight) expect(lobMid.samples[i].phi).toBe(0);
    }
    expect(lobMid.samples[lobMid.samples.length - 1].phi).toBeGreaterThan(0);
    // un défenseur dans la zone de chute dispute le ballon retombé : P_int = η_land · Φ_land
    const landing = simple([{ team: 'A', pos: from }, { team: 'A', pos: target }, { team: 'B', pos: v(37, 1) }]);
    const pl = analyseInterception(landing, from, target, 'lob', 'A', P).pIntercept;
    expect(pl).toBeGreaterThan(0.5);
    expect(pl).toBeLessThanOrEqual(M.interceptLandingEfficiency! + 1e-9);
    // la fenêtre d'atterrissage : un défenseur qui arrive juste après le ballon garde une chance
    const p0 = cloneParams(P); p0.models.interceptLandingWindow = 0;
    const p1 = cloneParams(P); p1.models.interceptLandingWindow = 1;
    const late = simple([{ team: 'A', pos: from }, { team: 'A', pos: target }, { team: 'B', pos: v(24, 0) }]);
    expect(analyseInterception(late, from, target, 'lob', 'A', p1).pIntercept).toBeGreaterThan(analyseInterception(late, from, target, 'lob', 'A', p0).pIntercept);
    // un lob court vole bas : le début et la fin du vol sont interceptables (hauteur < 1,6 m)
    const short = flightModel('lob', 8, P);
    expect(short.heightAt(1 / 12)).toBeLessThan(PH.controlMaxHeight);
    const shot = analyseInterception(mid, from, target, 'shot', 'A', P);
    expect(shot.initialSpeed).toBe(PH.shotSpeed);
    expect(shot.travelTime).toBeCloseTo(40 / PH.shotSpeed, 9);
    expect(shot.pIntercept).toBeLessThan(analyseInterception(mid, from, target, 'pass', 'A', P).pIntercept);
  });

  it('lob : la durée prévue par le modèle est celle du ballon du moteur (executeAction sans bruit, retour à z = 0)', () => {
    for (const d of [15, 25, 40]) {
      const params = cloneParams(P);
      params.physics.speedNoise = 0;
      params.physics.executionNoiseDeg = 0;
      params.physics.executionNoisePressure = 0;
      const st = simple([{ team: 'A', pos: v(-20, 0) }, { team: 'A', pos: v(-20 + d, 0) }, { team: 'B', pos: v(40, 30) }]);
      st.players[0].lastKickTime = -10;
      const origin = { ...st.ball.pos };
      const ok = executeAction(st, 0, { type: 'pass', targetId: 1, targetPoint: v(origin.x + d, origin.y), kind: 'lob', speed: 6 }, params, new Rng(1));
      expect(ok).toBe(true);
      const dt = params.physics.dt;
      let t = 0, landed = -1;
      // vol seul (le receveur est écarté pour ne pas prendre le ballon) : on cherche le premier retour au sol
      st.players[1].pos = v(0, 30);
      while (t < 6 && landed < 0) {
        stepPhysics(st, params, new Rng(2), dt);
        t += dt;
        if (st.ball.z <= 0 && t > 2 * dt) landed = t;
      }
      const predicted = flightModel('lob', d, params).travelTime;
      expect(landed).toBeGreaterThan(0);
      expect(Math.abs(landed - predicted)).toBeLessThan(2.5 * dt);
      // point de chute au tick près (le ballon avance de hs·dt par tick)
      expect(Math.abs(Math.hypot(st.ball.pos.x - origin.x, st.ball.pos.y - origin.y) - d)).toBeLessThan(2 * lobFlight(d, params.physics).horizontalSpeed * dt);
    }
  });

  it('trajectoire en cours (live) : temps balle mesurés depuis maintenant, points dépassés non interceptables', () => {
    const to = v(24, 0);
    const st = simple([{ team: 'A', pos: from }, { team: 'A', pos: to }, { team: 'B', pos: v(12, 1) }]);
    const fresh = analyseInterception(st, from, to, 'pass', 'A', P);
    expect(fresh.pIntercept).toBeGreaterThan(0.8 * M.interceptEfficiency); // défenseur à 1 m de la ligne, à mi-course : φ ≈ 1, P_int ≈ η
    // 1,6 s après la frappe le ballon a dépassé 12 m (T_b(12) ≈ 1,3 s) : le défenseur ne peut plus le couper
    const live = analyseInterception(st, from, to, 'pass', 'A', P, undefined, { elapsed: 1.6, initialSpeed: fresh.initialSpeed });
    expect(live.travelTime).toBeCloseTo(fresh.travelTime - 1.6, 9);
    for (let i = 0; i < live.samples.length; i++) {
      expect(live.samples[i].ballTime).toBeCloseTo(fresh.samples[i].ballTime - 1.6, 9);
      if (live.samples[i].ballTime < 0) expect(live.samples[i].phi).toBe(0);
    }
    expect(live.samples.some((s) => s.ballTime < 0)).toBe(true);
    expect(live.pIntercept).toBeLessThan(fresh.pIntercept); // le ballon a déjà passé le défenseur
    // vitesse réellement imprimée (bruit) : une balle plus rapide arrive plus tôt
    const fast = analyseInterception(st, from, to, 'pass', 'A', P, undefined, { elapsed: 0, initialSpeed: fresh.initialSpeed * 1.2 });
    expect(fast.travelTime).toBeLessThan(fresh.travelTime);
  });

  it('calibration : le recalcul de P_int depuis les caractéristiques brutes reproduit analyseInterception (sol, profondeur, lob)', () => {
    const st = simple([
      { team: 'A', pos: from }, { team: 'A', pos: v(30, 4) },
      { team: 'B', pos: v(12, 3), vel: v(2, -1) }, { team: 'B', pos: v(26, -2) }, { team: 'B', pos: v(-10, 10) }, { team: 'B', pos: v(50, 0), role: 'GK' },
    ]);
    const target = v(30, 4);
    for (const kind of ['pass', 'through', 'lob'] as const) {
      for (const model of [P, (() => { const q = cloneParams(P); q.models.interceptEfficiency = 0.7; q.models.arrivalSigma = 0.3; q.models.interceptWindow = 1; return q; })()]) {
        const a = analyseInterception(st, from, target, kind, 'A', model, 9);
        const f = interceptionFeatures(st, from, target, kind, 'A', model, 9);
        expect(f.defenderIds).toEqual(a.defenderIds);
        expect(f.deltas.length).toBe(f.defenderIds.length * f.samples);
        expect(rescoreInterception(f, interceptionModelOf(model))).toBeCloseTo(a.pIntercept, 12);
        expect(f.travelTime).toBeCloseTo(a.travelTime, 12);
      }
    }
    // Les caractéristiques sont indépendantes de η et σ_T : re-tarifer avec η = 1 donne P_int ≥ W.
    const a = analyseInterception(st, from, target, 'pass', 'A', P, 6);
    const f = interceptionFeatures(st, from, target, 'pass', 'A', P, 6);
    const m1 = { ...interceptionModelOf(P), eta: 1 };
    expect(rescoreInterception(f, m1)).toBeGreaterThanOrEqual(a.weakPhi - 1e-9);
    expect(rescoreInterception(f, { ...m1, eta: 0.2 })).toBeLessThan(rescoreInterception(f, m1));
  });

  it('passingLaneQuality : ≈ 0 pour un défenseur sur la ligne, croissante avec la distance, extrémités', () => {
    const on = simple([{ team: 'A', pos: from }, { team: 'A', pos: to }, { team: 'B', pos: v(10, 0) }]);
    expect(passingLaneQuality(on, from, to, 'A')).toBeLessThan(1e-9);
    let prev = 0;
    for (const off of [1, 2, 4, 8]) {
      const st = simple([{ team: 'A', pos: from }, { team: 'A', pos: to }, { team: 'B', pos: v(10, off) }]);
      const q = passingLaneQuality(st, from, to, 'A');
      expect(q).toBeGreaterThan(prev);
      prev = q;
    }
    // projection hors du segment : distance euclidienne à l'extrémité (× facteur angulaire)
    const beyond = simple([{ team: 'A', pos: from }, { team: 'A', pos: to }, { team: 'B', pos: v(24, 3) }]);
    expect(passingLaneQuality(beyond, from, to, 'A')).toBeGreaterThanOrEqual(5);
    expect(laneAngularMargin(on, from, to, 'A')).toBeCloseTo(0, 9);
    expect(laneAngularMargin(beyond, from, to, 'A')).toBe(180);
  });

  it('lignes franchies : groupes de défenseurs séparés de plus de 6 m', () => {
    const st = simple([
      { team: 'A', pos: v(-30, 0) }, { team: 'A', pos: v(30, 0) },
      { team: 'B', pos: v(-10, -5) }, { team: 'B', pos: v(-8, 5) }, // ligne 1 (x ≈ −9)
      { team: 'B', pos: v(10, 0) }, { team: 'B', pos: v(12, 8) }, // ligne 2 (x ≈ 11)
      { team: 'B', pos: v(48, 0), role: 'GK', number: 1 },
    ]);
    expect(lineBreaks(st, v(-30, 0), v(30, 0), 'A')).toBe(2);
    expect(lineBreaks(st, v(-30, 0), v(0, 0), 'A')).toBe(1);
    expect(lineBreaks(st, v(30, 0), v(-30, 0), 'A')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('candidats de passe (§6.1) : cibles longues, passe appuyée, lob, cible anticipée', () => {
  const speeds = [P.physics.passArrivalSpeed, ...P.decision.passArrivalSpeeds.filter((s) => s !== P.physics.passArrivalSpeed)];

  it('vitesse appuyée = plus grande des vitesses candidates, sous la porte de contrôle du moteur (12 m/s strict)', () => {
    expect(drivenArrivalSpeed(P)).toBe(Math.max(...P.decision.passArrivalSpeeds));
    expect(drivenArrivalSpeed(P)).toBeLessThan(P.physics.controlMaxRelSpeed);
    expect(longPassDistance(P)).toBe(25);
  });

  it('plan des variantes : cible longue ⇒ passe appuyée ET lob quelle que soit la ligne ; cible courte ⇒ vitesses ou lob selon la ligne ; jeu réduit ⇒ rien', () => {
    const long = longPassDistance(P) + 5;
    const openLong = planPassVariants(long, false, speeds, P);
    expect(openLong.lob).toBe(true);
    expect(openLong.speeds).toEqual(speeds.slice(1));
    expect(openLong.speeds).toContain(drivenArrivalSpeed(P));
    const blockedLong = planPassVariants(long, true, speeds, P);
    expect(blockedLong.lob).toBe(true);
    expect(blockedLong.speeds).toEqual([drivenArrivalSpeed(P)]);
    const openShort = planPassVariants(12, false, speeds, P);
    expect(openShort).toEqual({ speeds: speeds.slice(1), lob: false });
    const blockedShort = planPassVariants(12, true, speeds, P);
    expect(blockedShort).toEqual({ speeds: [], lob: false });
    expect(planPassVariants(long, false, speeds, P, true)).toEqual({ speeds: [], lob: false });
    // Nombre de candidats borné : ≤ 1 passe + 1 lob par coéquipier (10), 8 profondeurs, 16 dribbles, tir, conservation, dégagement.
    expect(10 * 2 + 8 + 16 + 3).toBeLessThanOrEqual(55);
  });

  it('cible anticipée : un receveur lancé n’est pas extrapolé au-delà de sa cible de déplacement', () => {
    const st = simple([{ team: 'A', pos: v(0, 0) }, { team: 'A', pos: v(10, 0), vel: v(6, 0) }, { team: 'B', pos: v(45, 30) }]);
    const runner = st.players[1];
    const free = anticipatedTarget(v(0, 0), runner, 6, P);
    expect(free.x).toBeGreaterThan(16); // T_b(10 m) ≈ 1,3 s à 6 m/s ⇒ ≈ +8 m
    runner.target = v(12, 0); // il s'arrête 2 m plus loin
    const capped = anticipatedTarget(v(0, 0), runner, 6, P);
    expect(capped.x).toBeCloseTo(12, 6);
    expect(capped.y).toBeCloseTo(0, 6);
    runner.target = v(10, 8); // cible perpendiculaire à sa course : projection nulle ⇒ position courante
    expect(anticipatedTarget(v(0, 0), runner, 6, P).x).toBeCloseTo(10, 6);
    runner.target = v(40, 0); // cible plus loin que le ballon : extrapolation complète
    expect(anticipatedTarget(v(0, 0), runner, 6, P).x).toBeCloseTo(free.x, 6);
  });

  it('logit de passe : pénalité de vitesse au-delà de 9 m/s et pénalité de réception aérienne (lob)', () => {
    const st = simple([{ team: 'A', pos: v(0, 0) }, { team: 'A', pos: v(20, 0) }, { team: 'B', pos: v(45, 30) }]);
    const fields = computeFields(st, P);
    const at = (speed: number, aerial = false) => passLogit(st, fields, st.players[0], v(0, 0), v(20, 0), P, speed, aerial);
    expect(at(9).logit).toBeCloseTo(at(6).logit, 12);
    expect(at(10).logit).toBeCloseTo(at(9).logit + (P.models.pass.arrivalSpeed ?? -0.1), 12);
    expect(at(10).features.find((f) => f.key === 'arrivalSpeed')!.value).toBeCloseTo(1, 12);
    const lob = at(6, true);
    expect(lob.logit).toBeCloseTo(at(6).logit + (P.models.pass.lobPenalty ?? -1.5), 12);
    expect(lob.features.find((f) => f.key === 'lob')).toBeDefined();
    // passProbability = (1 − P_int) · σ(passLogit) avec la vitesse demandée.
    const pr = passProbability(st, fields, 0, 1, v(20, 0), P, 10);
    expect(pr.p).toBeCloseTo((1 - pr.interception!.pIntercept) / (1 + Math.exp(-at(10).logit)), 12);
  });
});

// ---------------------------------------------------------------------------
describe('probability — passes (§5.1, §5.2)', () => {
  it('P_pass décroît avec la distance (couloir libre) ; ancrage 15 m libre ≈ 0,82–0,86', () => {
    let prev = 1;
    for (const d of [5, 10, 15, 20, 30, 40, 50]) {
      const st = simple([{ team: 'A', pos: v(-40, 0) }, { team: 'A', pos: v(-40 + d, 0) }, { team: 'B', pos: v(45, 30) }]);
      const r = passProbability(st, computeFields(st, P), 0, 1, st.players[1].pos, P);
      expect(r.p).toBeLessThan(prev);
      prev = r.p;
      if (d === 15) expect(Math.abs(r.p - 0.84)).toBeLessThan(0.05);
    }
  });

  it('un défenseur sur la ligne de passe et la pression sur le passeur réduisent P_pass', () => {
    const free = simple([{ team: 'A', pos: v(0, 0) }, { team: 'A', pos: v(20, 0) }, { team: 'B', pos: v(45, 30) }]);
    const onLine = simple([{ team: 'A', pos: v(0, 0) }, { team: 'A', pos: v(20, 0) }, { team: 'B', pos: v(10, 1) }]);
    const pressed = simple([{ team: 'A', pos: v(0, 0) }, { team: 'A', pos: v(20, 0) }, { team: 'B', pos: v(1.5, -1.5) }]);
    const pf = passProbability(free, computeFields(free, P), 0, 1, v(20, 0), P);
    const po = passProbability(onLine, computeFields(onLine, P), 0, 1, v(20, 0), P);
    const pp = passProbability(pressed, computeFields(pressed, P), 0, 1, v(20, 0), P);
    // Un défenseur sur la ligne (φ ≈ 1) coûte le facteur (1 − η) : une chance par défenseur (§4.6).
    expect(po.p).toBeLessThan(pf.p * (1 - 0.9 * M.interceptEfficiency));
    expect(po.p).toBeGreaterThan(pf.p * (1 - M.interceptEfficiency) * 0.97); // (le défenseur pèse aussi un peu sur Π(q_r))
    expect(pp.p).toBeLessThan(pf.p);
    expect(po.interception?.threats).toEqual([2]);
    const comp = (r: typeof pf, k: string) => r.features.find((f) => f.key === k)!;
    expect(comp(pp, 'passerPressure').value).toBeGreaterThan(comp(pf, 'passerPressure').value);
    // Σ contributions logistiques = logit(p / (1 − P_int)) : décomposition additive exacte
    const logit = pf.features.filter((f) => f.key !== 'interception').reduce((s, f) => s + f.contribution, 0);
    expect(1 / (1 + Math.exp(-logit)) * (1 - pf.interception!.pIntercept)).toBeCloseTo(pf.p, 9);
    for (const f of pf.features) expect(f.contribution).toBeCloseTo(f.key === 'interception' ? Math.log(1 - f.value) : f.weight * f.value, 9);
  });

  it('les attributs modulent mildement : un meilleur passeur a une P_pass plus élevée', () => {
    const mk = (passing: number) => simple([{ team: 'A', pos: v(0, 0), attrs: { passing } }, { team: 'A', pos: v(20, 0) }, { team: 'B', pos: v(45, 30) }]);
    const lo = mk(0.2), hi = mk(0.9);
    const plo = passProbability(lo, computeFields(lo, P), 0, 1, v(20, 0), P).p;
    const phi = passProbability(hi, computeFields(hi, P), 0, 1, v(20, 0), P).p;
    expect(phi).toBeGreaterThan(plo);
    expect(phi - plo).toBeLessThan(0.15);
  });

  it('symétrie miroir des probabilités (passe, tir, dribble, conservation)', () => {
    const st = buildFullState({ ballPos: v(20, 6), ownerId: 9, shift: { A: v(10, 0), B: v(5, 2) } });
    const ms = mirrorState(st);
    const f = computeFields(st, P), g = computeFields(ms, P);
    // le miroir échange les équipes : le joueur i garde son indice/id
    expect(passProbability(st, f, 9, 8, st.players[8].pos, P).p).toBeCloseTo(passProbability(ms, g, 9, 8, ms.players[8].pos, P).p, 3);
    expect(shotProbability(st, f, 9, v(52.5, 0), P).p).toBeCloseTo(shotProbability(ms, g, 9, v(-52.5, 0), P).p, 6);
    expect(dribbleProbability(st, f, 9, v(26, 6), P).p).toBeCloseTo(dribbleProbability(ms, g, 9, v(-26, -6), P).p, 3);
    expect(holdProbability(st, f, 9, P).p).toBeCloseTo(holdProbability(ms, g, 9, P).p, 6);
  });

  it('passe en profondeur : hors-jeu ⇒ 0, receveur devancé ⇒ faible, receveur en avance ⇒ élevée', () => {
    const gk: PlayerSpec = { team: 'B', pos: v(50, 0), role: 'GK', number: 1 };
    const base: PlayerSpec[] = [{ team: 'A', pos: v(0, 0) }, { team: 'A', pos: v(8, 6), vel: v(6, 1) }];
    // défenseurs : ligne à x = 10 ; receveur (8, 6) en jeu, lancé vers la cible
    const onside = simple([...base, { team: 'B', pos: v(10, -14) }, { team: 'B', pos: v(10, 20) }, gk]);
    const target = v(22, 8);
    const r1 = throughBallProbability(onside, computeFields(onside, P), 0, 1, target, P);
    expect(r1.p).toBeGreaterThan(0.3);
    // receveur au rendez-vous : lancé vers la cible il rejoint le ballon (facteur ≈ 1) ; à l'arrêt, 14 m à parcourir
    // pendant les 2,2 s de trajet du ballon (9 m/s à l'arrivée) : il risque de le manquer (facteur < 0,6) ; un
    // receveur très loin de la cible le manque sûrement, même sans défenseur
    expect(r1.features.find((f) => f.key === 'receiverReach')!.value).toBeGreaterThan(0);
    const still = simple([base[0], { team: 'A', pos: v(8, 6) }, { team: 'B', pos: v(10, -14) }, { team: 'B', pos: v(10, 20) }, gk]);
    const rs = throughBallProbability(still, computeFields(still, P), 0, 1, target, P);
    expect(rs.p).toBeLessThan(r1.p);
    expect(Math.exp(rs.features.find((f) => f.key === 'receiverReach')!.contribution)).toBeLessThan(0.6);
    const far = simple([base[0], { team: 'A', pos: v(-10, -20) }, { team: 'B', pos: v(10, -14) }, { team: 'B', pos: v(10, 20) }, gk]);
    expect(throughBallProbability(far, computeFields(far, P), 0, 1, target, P).p).toBeLessThan(0.05);
    const noSlack = cloneParams(P); noSlack.models.through.reachSlack = 0;
    expect(throughBallProbability(still, computeFields(still, P), 0, 1, target, noSlack).p).toBeLessThan(rs.p);
    // même situation, receveur au-delà de la ligne (x = 14 > 10 + 0,5) ⇒ hors-jeu
    const offside = simple([base[0], { team: 'A', pos: v(14, 6) }, { team: 'B', pos: v(10, -14) }, { team: 'B', pos: v(10, 20) }, gk]);
    const r2 = throughBallProbability(offside, computeFields(offside, P), 0, 1, target, P);
    expect(r2.p).toBe(0);
    expect(r2.features.find((f) => f.key === 'offside')!.value).toBe(1);
    // défenseur plus proche de la cible que le receveur ⇒ facteur « receveur en premier » faible
    const beaten = simple([...base, { team: 'B', pos: v(20, 8) }, gk]);
    const r3 = throughBallProbability(beaten, computeFields(beaten, P), 0, 1, target, P);
    expect(r3.p).toBeLessThan(0.1);
    expect(r3.features.find((f) => f.key === 'receiverFirst')!.value).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('probability — tir (§5.4)', () => {
  const xg = (st: MatchState) => shotProbability(st, computeFields(st, P), 0, v(52.5, 0), P);
  it('ancrages (gardien centré sur sa ligne) : 6 m ≈ 0,72, penalty ≈ 0,29, 18 m ≈ 0,10, 25 m ≈ 0,04, 30 m ≈ 0,03', () => {
    expect(Math.abs(xg(shotState(52.5 - 6, 0)).p - 0.72)).toBeLessThan(0.06);
    expect(Math.abs(xg(shotState(52.5 - 11, 0)).p - 0.29)).toBeLessThan(0.05);
    expect(Math.abs(xg(shotState(52.5 - 18, 0)).p - 0.10)).toBeLessThan(0.05);
    expect(Math.abs(xg(shotState(52.5 - 25, 0)).p - 0.04)).toBeLessThan(0.03);
    expect(Math.abs(xg(shotState(52.5 - 30, 0)).p - 0.03)).toBeLessThan(0.02);
    expect(Math.abs(xg(shotState(52.5 - 12.8 * Math.cos(0.3665), 12.8 * Math.sin(0.3665))).p - 0.13)).toBeLessThan(0.07);
  });

  it('xG décroît avec la distance, croît avec l’angle, décroît avec un contreur dans le cône', () => {
    let prev = 1;
    for (let d = 6; d <= 35; d += 3) {
      const p = xg(shotState(52.5 - d, 0)).p;
      expect(p).toBeLessThan(prev);
      prev = p;
    }
    expect(xg(shotState(52.5 - 15, 0)).p).toBeGreaterThan(xg(shotState(52.5 - 15 * Math.cos(1.0), 15 * Math.sin(1.0))).p);
    const clear = xg(shotState(52.5 - 18, 0));
    const blocked = xg(shotState(52.5 - 18, 0, v(52.5, 0), [v(52.5 - 12, 0.5)]));
    expect(blocked.p).toBeLessThan(clear.p);
    expect(blocked.features.find((f) => f.key === 'blockers')!.value).toBe(1);
  });

  it('couverture du gardien : centré > décalé > hors du cône ; rayon d’action croissant avec le temps de vol', () => {
    const centred = xg(shotState(52.5 - 16, 0, v(52.5 - 3, 0)));
    const shifted = xg(shotState(52.5 - 16, 0, v(52.5 - 3, 3)));
    const away = xg(shotState(52.5 - 16, 0, v(52.5 - 3, 15)));
    expect(centred.p).toBeLessThan(shifted.p);
    expect(shifted.p).toBeLessThan(away.p);
    expect(away.features.find((f) => f.key === 'keeperCoverage')!.value).toBeCloseTo(0, 9);
    const cNear = keeperCoverage(v(52.5 - 8, 0), v(52.5 - 1, 0), 'A', 0.1, P);
    const cFar = keeperCoverage(v(52.5 - 8, 0), v(52.5 - 1, 0), 'A', 0.5, P);
    expect(cFar).toBeGreaterThan(cNear);
    expect(cFar).toBeLessThanOrEqual(1);
    // le gardien de l'équipe B couvre le but de B pour un tireur A ; miroir exact
    expect(keeperCoverage(v(-40, 2), v(-51, 0.5), 'B', 0.4, P)).toBeCloseTo(keeperCoverage(v(40, -2), v(51, -0.5), 'A', 0.4, P), 12);
  });
});

// ---------------------------------------------------------------------------
describe('probability — dribble et conservation (§5.3, §5.5)', () => {
  it('dribble : 4 m libre ≈ 0,89 ; contesté nettement plus bas ; décroît avec la distance', () => {
    const free = simple([{ team: 'A', pos: v(0, 0) }, { team: 'B', pos: v(45, 30) }]);
    const ff = computeFields(free, P);
    const r4 = dribbleProbability(free, ff, 0, v(4, 0), P);
    expect(Math.abs(r4.p - 0.89)).toBeLessThan(0.05);
    expect(dribbleProbability(free, ff, 0, v(8, 0), P).p).toBeLessThan(r4.p);
    // défenseur posté sur la cible (course perdue) et un second près du trajet
    const contested = simple([{ team: 'A', pos: v(0, 0) }, { team: 'B', pos: v(4, 0.2) }, { team: 'B', pos: v(2, -1.5) }]);
    const rc = dribbleProbability(contested, computeFields(contested, P), 0, v(4, 0), P);
    expect(rc.p).toBeLessThan(0.5);
    expect(rc.features.find((f) => f.key === 'pathPressure')!.value).toBeGreaterThan(0.5);
    expect(rc.features.find((f) => f.key === 'race')!.value).toBeLessThan(0);
    const logit = r4.features.reduce((s, f) => s + f.contribution, 0);
    expect(1 / (1 + Math.exp(-logit))).toBeCloseTo(r4.p, 9);
    // course : le porteur paie la même cinématique que le défenseur (départ arrêté : 1,26 s pour 4 m, pas 0,67 s).
    // Porteur à l'arrêt, défenseur à 3 m de la cible : T_j = 0,3 + √(6/5) = 1,40 s ⇒ marge +0,13 s (et non +0,73 s)
    const raceSt = simple([{ team: 'A', pos: v(0, 0) }, { team: 'B', pos: v(4, 3) }]);
    const rr = dribbleProbability(raceSt, computeFields(raceSt, P), 0, v(4, 0), P);
    const margin = Math.atanh(rr.features.find((f) => f.key === 'race')!.value);
    expect(margin).toBeCloseTo(0.3 + Math.sqrt(6 / 5) - runTimeFrom(4, 0, PH.dribbleSpeedFactor * 8, 5), 6);
    expect(margin).toBeLessThan(0.3);
    // porteur déjà lancé vers la cible : marge plus grande, P plus élevée
    const moving = simple([{ team: 'A', pos: v(0, 0), vel: v(6, 0) }, { team: 'B', pos: v(4, 3) }]);
    expect(dribbleProbability(moving, computeFields(moving, P), 0, v(4, 0), P).p).toBeGreaterThan(rr.p);
  });

  it('conservation : décroissante en la pression et au nombre d’adversaires à 2 m', () => {
    const alone = simple([{ team: 'A', pos: v(0, 0) }, { team: 'B', pos: v(45, 30) }]);
    const one = simple([{ team: 'A', pos: v(0, 0) }, { team: 'B', pos: v(1.5, 0) }]);
    const two = simple([{ team: 'A', pos: v(0, 0) }, { team: 'B', pos: v(1.5, 0) }, { team: 'B', pos: v(-1, 1) }]);
    const pa = holdProbability(alone, computeFields(alone, P), 0, P).p;
    const p1 = holdProbability(one, computeFields(one, P), 0, P);
    const p2 = holdProbability(two, computeFields(two, P), 0, P);
    expect(pa).toBeCloseTo(1 / (1 + Math.exp(-M.hold.base)), 2);
    expect(p1.p).toBeLessThan(pa);
    expect(p2.p).toBeLessThan(p1.p);
    expect(p2.features.find((f) => f.key === 'closeOpponents')!.value).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('structure (§4.5, §4.7, §3.4)', () => {
  it('supériorité locale : compte les joueurs à moins de t★', () => {
    const st = simple([
      { team: 'A', pos: v(0, 0) }, { team: 'A', pos: v(5, 0) }, { team: 'A', pos: v(40, 0) },
      { team: 'B', pos: v(-4, 0) }, { team: 'B', pos: v(-45, 0) },
    ]);
    expect(localSuperiority(st, v(0, 0), 'A', P)).toBe(1); // 2 A − 1 B en 2,5 s
    expect(localSuperiority(st, v(0, 0), 'B', P)).toBe(-1);
    expect(localSuperiority(st, v(0, 0), 'A', P, 10)).toBe(3 - 2);
    expect(localSuperiority(st, v(0, 0), 'A', P, 0.5)).toBe(1); // seul le joueur déjà en q (T = τ_r = 0,3 s)
    expect(localSuperiority(st, v(0, 0), 'A', P, 0.29)).toBe(0);
  });

  it('compacité : enveloppe convexe (chaîne monotone) d’un carré 20 × 20 avec points intérieurs', () => {
    const square = [v(-10, -10), v(10, -10), v(10, 10), v(-10, 10)];
    const hull = convexHull([...square, v(0, 0), v(3, -2), v(-5, 5)]);
    expect(hull).toHaveLength(4);
    expect(polygonArea(hull)).toBeCloseTo(400, 9);
    const players: PlayerSpec[] = [
      { team: 'A', pos: v(-48, 0), role: 'GK', number: 1 },
      ...square.map((pos) => ({ team: 'A' as TeamId, pos, role: 'MF' as const })),
      { team: 'A', pos: v(0, 0), role: 'MF' }, { team: 'A', pos: v(2, 2), role: 'MF' },
      { team: 'B', pos: v(30, 0) },
    ];
    const c = compactness(simple(players, null), 'A');
    expect(c.hullArea).toBeCloseTo(400, 9); // le gardien est exclu
    expect(c.spanX).toBeCloseTo(20, 9);
    expect(c.spanY).toBeCloseTo(20, 9);
  });

  it('ligne de hors-jeu : avant-dernier défenseur ou ballon, direction d’attaque prise en compte', () => {
    const players: PlayerSpec[] = [
      { team: 'A', pos: v(0, 0) },
      { team: 'B', pos: v(50, 0), role: 'GK', number: 1 }, { team: 'B', pos: v(20, 5) }, { team: 'B', pos: v(15, -5) },
    ];
    const st = buildState({ players, ball: { pos: v(0, 0), ownerId: 0 } });
    expect(offsideLine(st, 'A')).toBeCloseTo(20, 9); // gardien = dernier, 20 = avant-dernier
    const ballAhead = buildState({ players, ball: { pos: v(30, 0), ownerId: null } });
    expect(offsideLine(ballAhead, 'A')).toBeCloseTo(30, 9);
    // équipe B attaque vers −x : défenseurs A en −x
    const playersB: PlayerSpec[] = [
      { team: 'A', pos: v(-50, 0), role: 'GK', number: 1 }, { team: 'A', pos: v(-25, 3) }, { team: 'A', pos: v(-18, -3) },
      { team: 'B', pos: v(0, 0) },
    ];
    const stB = buildState({ players: playersB, ball: { pos: v(0, 0), ownerId: 3 } });
    expect(offsideLine(stB, 'B')).toBeCloseTo(-25, 9);
    // sans défenseur (scénario réduit) : ligne = ligne de but adverse, aucun attaquant n'est hors-jeu
    const none = buildState({ players: [{ team: 'A', pos: v(0, 0) }, { team: 'A', pos: v(10, 0) }], ball: { pos: v(0, 0), ownerId: 0 } });
    expect(offsideLine(none, 'A')).toBeCloseTo(PITCH.halfLength, 9);
    expect(isOffsidePosition(none, v(10, 0), 'A')).toBe(false);
    expect(isOffsidePosition(none, v(50, 0), 'A')).toBe(false);
    const noneB = buildState({ players: [{ team: 'B', pos: v(0, 0) }, { team: 'B', pos: v(-10, 0) }], ball: { pos: v(0, 0), ownerId: 0 } });
    expect(offsideLine(noneB, 'B')).toBeCloseTo(-PITCH.halfLength, 9);
    expect(isOffsidePosition(noneB, v(-30, 0), 'B')).toBe(false);
    // un seul défenseur : sa ligne (inchangé)
    const one = buildState({ players: [{ team: 'A', pos: v(0, 0) }, { team: 'B', pos: v(20, 0) }], ball: { pos: v(0, 0), ownerId: 0 } });
    expect(offsideLine(one, 'A')).toBeCloseTo(20, 9);
  });

  it('position de hors-jeu : jamais dans son camp, tolérance 0,5 m, miroir pour B', () => {
    const players: PlayerSpec[] = [
      { team: 'A', pos: v(0, 0) },
      { team: 'B', pos: v(50, 0), role: 'GK', number: 1 }, { team: 'B', pos: v(20, 5) }, { team: 'B', pos: v(15, -5) },
    ];
    const st = buildState({ players, ball: { pos: v(0, 0), ownerId: 0 } });
    expect(isOffsidePosition(st, v(25, 0), 'A')).toBe(true);
    expect(isOffsidePosition(st, v(20.3, 0), 'A')).toBe(false); // dans la tolérance
    expect(isOffsidePosition(st, v(20.8, 0), 'A')).toBe(true);
    expect(isOffsidePosition(st, v(18, 0), 'A')).toBe(false);
    // ligne dans le camp adverse impossible à franchir depuis son propre camp
    const deep = buildState({ players: [{ team: 'A', pos: v(-30, 0) }, { team: 'B', pos: v(-40, 0), role: 'GK', number: 1 }, { team: 'B', pos: v(-35, 0) }], ball: { pos: v(-30, 0), ownerId: 0 } });
    expect(isOffsidePosition(deep, v(-10, 0), 'A')).toBe(false);
    // miroir : équipe B
    const ms = mirrorState(st);
    expect(isOffsidePosition(ms, v(-25, 0), 'B')).toBe(true);
    expect(isOffsidePosition(ms, v(-18, 0), 'B')).toBe(false);
  });

  it('aire de Voronoï : deux joueurs symétriques se partagent le terrain, somme = L·W', () => {
    const st = simple([{ team: 'A', pos: v(-10, 0) }, { team: 'B', pos: v(10, 0) }], null);
    const a = voronoiArea(st, 0), b = voronoiArea(st, 1);
    // la colonne médiane (x = 0, équidistante) est attribuée au plus petit id : écart d'au plus une colonne
    expect(Math.abs(a - b)).toBeLessThanOrEqual(PITCH.width * 2 + 1e-6);
    expect(a + b).toBeCloseTo(PITCH.length * PITCH.width, 6);
    const fine = voronoiArea(st, 0, 0.5) + voronoiArea(st, 1, 0.5);
    expect(fine).toBeCloseTo(PITCH.length * PITCH.width, 6);
    expect(Math.abs(voronoiArea(st, 0, 0.5) - voronoiArea(st, 1, 0.5))).toBeLessThanOrEqual(PITCH.width * 0.5 + 1e-6);
    const full = buildFullState();
    const total = full.players.reduce((s, p) => s + voronoiArea(full, p.id), 0);
    expect(total).toBeCloseTo(PITCH.length * PITCH.width, 6);
    // rayon optionnel : borné par π R²
    expect(voronoiArea(st, 0, 1, 8)).toBeLessThanOrEqual(Math.PI * 64 + 5);
    expect(voronoiArea(st, 0, 1, 8)).toBeGreaterThan(Math.PI * 64 - 10);
  });
});
