import { describe, it, expect } from 'vitest';
import { fmtNumber, fmtPercent, fmtClock, fmtMs, actionLabel, INTENT_LABELS } from '@/ui/format';
import { controlRamp, threatRamp, pressureRamp, scoreRamp, rgbaCss } from '@/ui/render/colors';
import { makeTransform, toScreen, toWorld, px } from '@/ui/render/pitch';
import { createMockSimulation } from '@/ui/mock';
import { findSpaces } from '@/ui/render/overlays';
import { DEFAULT_PARAMS, cloneParams } from '@/core/params';
import { makeTactic } from '@/tactics/styles';
import { PITCH } from '@/core/pitch';
import type { MatchConfig } from '@/core/types';

const config = (): MatchConfig => ({
  seed: 7,
  tactics: { A: makeTactic('4-3-3', 'balanced'), B: makeTactic('4-4-2', 'low_block') },
  params: cloneParams(DEFAULT_PARAMS),
  durationSec: 600,
});

describe('format', () => {
  it('formate les nombres à la française', () => {
    expect(fmtNumber(0.8712, 2)).toBe('0,87');
    expect(fmtNumber(-1.5, 1)).toBe('−1,5');
    expect(fmtNumber(2, 1, true)).toBe('+2,0');
    expect(fmtNumber(NaN)).toBe('—');
  });
  it('formate pourcentages, chrono et millisecondes', () => {
    expect(fmtPercent(0.81)).toBe('81 %');
    expect(fmtClock(65)).toBe('01:05');
    expect(fmtClock(600)).toBe('10:00');
    expect(fmtMs(1.234)).toBe('1,23 ms');
  });
  it('libelle les actions et intentions en français', () => {
    expect(actionLabel({ type: 'pass', targetId: 1, targetPoint: { x: 0, y: 0 }, kind: 'through', speed: 10 })).toBe('Passe en profondeur');
    expect(actionLabel({ type: 'hold' })).toBe('Conserver');
    expect(INTENT_LABELS.press).toBe('pressing');
    expect(Object.keys(INTENT_LABELS)).toHaveLength(15);
  });
});

describe('rampes de couleurs', () => {
  it('sont bornées et monotones aux extrémités', () => {
    for (const ramp of [controlRamp, threatRamp, pressureRamp, scoreRamp]) {
      for (const t of [-1, 0, 0.25, 0.5, 0.75, 1, 2]) {
        const c = ramp(t);
        expect(c).toHaveLength(4);
        for (const v of c) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(255); }
      }
      expect(ramp(-1)).toEqual(ramp(0));
      expect(ramp(2)).toEqual(ramp(1));
    }
    // Contrôle : rouge côté B (t = 0), bleu côté A (t = 1)
    expect(controlRamp(0)[0]).toBeGreaterThan(controlRamp(0)[2]);
    expect(controlRamp(1)[2]).toBeGreaterThan(controlRamp(1)[0]);
    // Menace : alpha croissant
    expect(threatRamp(1)[3]).toBeGreaterThan(threatRamp(0)[3]);
  });
  it('produit une chaîne CSS rgba', () => {
    expect(rgbaCss([255, 0, 0, 255])).toBe('rgba(255, 0, 0, 1.000)');
    expect(rgbaCss([0, 0, 0, 0])).toBe('rgba(0, 0, 0, 0.000)');
  });
});

describe('transformation monde ↔ écran', () => {
  it('conserve le ratio 105:68 et fait l’aller-retour', () => {
    const t = makeTransform(1600, 1000);
    const w = { x: 12.3, y: -20.5 };
    const s = toScreen(t, w);
    const back = toWorld(t, s);
    expect(back.x).toBeCloseTo(w.x, 6);
    expect(back.y).toBeCloseTo(w.y, 6);
    // Le terrain entier tient dans le canvas
    const tl = toScreen(t, { x: -PITCH.halfLength, y: -PITCH.halfWidth });
    const br = toScreen(t, { x: PITCH.halfLength, y: PITCH.halfWidth });
    expect(tl.x).toBeGreaterThanOrEqual(0);
    expect(tl.y).toBeGreaterThanOrEqual(0);
    expect(br.x).toBeLessThanOrEqual(1600);
    expect(br.y).toBeLessThanOrEqual(1000);
    expect((br.x - tl.x) / (br.y - tl.y)).toBeCloseTo(105 / 68, 6);
    // Orientation : +x vers la droite, +y vers le bas
    expect(toScreen(t, { x: 10, y: 0 }).x).toBeGreaterThan(toScreen(t, { x: 0, y: 0 }).x);
    expect(toScreen(t, { x: 0, y: 10 }).y).toBeGreaterThan(toScreen(t, { x: 0, y: 0 }).y);
    expect(px(t, 1)).toBeCloseTo(t.scale, 9);
  });
  it('centre le terrain en mode portrait (letterboxing)', () => {
    const t = makeTransform(500, 1000);
    const c = toScreen(t, { x: 0, y: 0 });
    expect(c.x).toBe(250);
    expect(c.y).toBe(500);
  });
});

describe('simulation factice', () => {
  it('construit un état valide : 22 joueurs, identifiants, équipes, champs', () => {
    const sim = createMockSimulation(config());
    const st = sim.state;
    expect(st.players).toHaveLength(22);
    st.players.forEach((p, i) => {
      expect(p.id).toBe(i);
      expect(p.team).toBe(i < 11 ? 'A' : 'B');
      expect(p.number).toBe((i % 11) + 1);
      expect(Math.abs(p.pos.x)).toBeLessThanOrEqual(PITCH.halfLength);
      expect(Math.abs(p.pos.y)).toBeLessThanOrEqual(PITCH.halfWidth);
    });
    expect(st.players.filter((p) => p.role === 'GK')).toHaveLength(2);
    expect(st.ball.ownerId).not.toBeNull();
    expect(st.players[st.ball.ownerId!].team).toBe('A');
    expect(st.fields).not.toBeNull();
    const f = st.fields!;
    const cell = config().params.fieldCellSize;
    const cols = Math.ceil(PITCH.length / cell) + 1, rows = Math.ceil(PITCH.width / cell) + 1;
    for (const field of [f.controlA, f.threatA, f.threatB, f.pressureByA, f.pressureByB]) {
      expect(field.cols).toBe(cols);
      expect(field.rows).toBe(rows);
      expect(field.data).toHaveLength(cols * rows);
      for (const v of field.data) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    }
    // Orientation de la menace : A attaque vers +x
    expect(f.threatA.sample({ x: 40, y: 0 })).toBeGreaterThan(f.threatA.sample({ x: -40, y: 0 }));
    expect(f.threatB.sample({ x: -40, y: 0 })).toBeGreaterThan(f.threatB.sample({ x: 40, y: 0 }));
  });
  it('produit une décision de porteur avec candidats triés et des décisions de déplacement', () => {
    const sim = createMockSimulation(config());
    const owner = sim.state.ball.ownerId!;
    const d = sim.decisions.get(owner)!;
    expect(d).toBeDefined();
    expect(d.candidates.length).toBeGreaterThanOrEqual(8);
    expect(d.chosen).toBe(d.candidates[0]);
    for (let i = 1; i < d.candidates.length; i++) expect(d.candidates[i - 1].score).toBeGreaterThanOrEqual(d.candidates[i].score);
    const types = new Set(d.candidates.map((c) => c.action.type));
    expect(types.has('pass') && types.has('dribble') && types.has('shoot') && types.has('hold')).toBe(true);
    for (const c of d.candidates) {
      expect(c.probability).toBeGreaterThanOrEqual(0);
      expect(c.probability).toBeLessThanOrEqual(1);
      expect(c.components.length).toBeGreaterThan(0);
    }
    expect(sim.decisions.size).toBe(22);
    for (const p of sim.state.players) if (p.id !== owner) expect(sim.decisions.get(p.id)!.chosen.action.type).toBe('move');
  });
  it('avance dans le temps et reste cohérente', () => {
    const sim = createMockSimulation(config());
    sim.advance(5);
    expect(sim.state.time).toBeCloseTo(5, 1);
    expect(sim.state.tick).toBeGreaterThan(100);
    for (const p of sim.state.players) {
      expect(Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y)).toBe(true);
      expect(Math.abs(p.pos.x)).toBeLessThanOrEqual(PITCH.halfLength + 1);
    }
    expect(sim.state.stats.A.possessionTime + sim.state.stats.B.possessionTime).toBeGreaterThan(4);
  });
  it('trouve des espaces disponibles séparés', () => {
    const sim = createMockSimulation(config());
    const spots = findSpaces(sim.state.fields!, 'A', 6, 9);
    expect(spots.length).toBeGreaterThan(0);
    expect(spots.length).toBeLessThanOrEqual(6);
    for (let i = 0; i < spots.length; i++)
      for (let j = i + 1; j < spots.length; j++)
        expect(Math.hypot(spots[i].pos.x - spots[j].pos.x, spots[i].pos.y - spots[j].pos.y)).toBeGreaterThanOrEqual(9);
    for (let i = 1; i < spots.length; i++) expect(spots[i - 1].value).toBeGreaterThanOrEqual(spots[i].value);
  });
});
