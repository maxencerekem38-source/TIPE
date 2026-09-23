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
import { timeToArrive, runTime, launchSpeed, ballTravelTime, ballDistanceAt, ballSpeedAt } from '@/models/motion';
import { computeFields, pitchControlAt, pressureAt, threatAt, geometricXG, availableSpace } from '@/models/fields';
import { analyseInterception, passingLaneQuality, arrivalLogistic, lineBreaks, laneAngularMargin } from '@/models/interception';
import { passProbability, throughBallProbability, dribbleProbability, shotProbability, holdProbability, keeperCoverage } from '@/models/probability';
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
    expect(g.pIntercept).toBeGreaterThanOrEqual(0.3);
    expect(g.threats).toEqual([2]);
    expect(g.weakOpponentId).toBe(2);
    expect(g.weakPhi).toBeGreaterThan(0.4);
    // borne : P_int(η = 1) ≥ W
    const p1 = cloneParams(P); p1.models.interceptEfficiency = 1;
    expect(analyseInterception(guarded, from, to, 'pass', 'A', p1).pIntercept).toBeGreaterThanOrEqual(g.weakPhi - 1e-9);
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

  it('lob : interceptable seulement dans les 20 % initiaux/finaux ; tir : ligne droite rapide', () => {
    const mid = simple([{ team: 'A', pos: from }, { team: 'A', pos: v(40, 0) }, { team: 'B', pos: v(20, 1) }]);
    const lobMid = analyseInterception(mid, from, v(40, 0), 'lob', 'A', P);
    const passMid = analyseInterception(mid, from, v(40, 0), 'pass', 'A', P);
    // le défenseur au milieu ne peut jouer que la zone de chute : P_int faible mais non nulle (course vers 32–40 m)
    expect(lobMid.pIntercept).toBeLessThan(0.15);
    expect(passMid.pIntercept).toBeGreaterThan(0.5);
    expect(lobMid.pIntercept).toBeLessThan(0.25 * passMid.pIntercept);
    for (const s of lobMid.samples) if (s.point.x > 8.01 && s.point.x < 31.99) expect(s.phi).toBe(0);
    // un défenseur dans la zone de chute (20 % finaux) intercepte le lob
    const landing = simple([{ team: 'A', pos: from }, { team: 'A', pos: v(40, 0) }, { team: 'B', pos: v(37, 1) }]);
    expect(analyseInterception(landing, from, v(40, 0), 'lob', 'A', P).pIntercept).toBeGreaterThan(0.5);
    const shot = analyseInterception(mid, from, v(40, 0), 'shot', 'A', P);
    expect(shot.initialSpeed).toBe(PH.shotSpeed);
    expect(shot.travelTime).toBeCloseTo(40 / PH.shotSpeed, 9);
    expect(shot.pIntercept).toBeLessThan(analyseInterception(mid, from, v(40, 0), 'pass', 'A', P).pIntercept);
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
    expect(po.p).toBeLessThan(pf.p * 0.5);
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
    const base: PlayerSpec[] = [{ team: 'A', pos: v(0, 0) }, { team: 'A', pos: v(8, 6) }];
    // défenseurs : ligne à x = 10 ; receveur (8, 6) en jeu
    const onside = simple([...base, { team: 'B', pos: v(10, -14) }, { team: 'B', pos: v(10, 20) }, gk]);
    const target = v(22, 8);
    const r1 = throughBallProbability(onside, computeFields(onside, P), 0, 1, target, P);
    expect(r1.p).toBeGreaterThan(0.3);
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
