/**
 * Calques de visualisation : cartes de chaleur (contrôle, menace, pression), espaces disponibles,
 * lignes de passe du porteur, trajectoires, déplacements, affectations défensives, légende.
 */
import type { Candidate, Decision, FieldSet, MatchState, Player, TeamId } from '@/core/types';
import { attackDir, otherTeam } from '@/core/types';
import type { ScalarField } from '@/core/grid';
import { PITCH, goalPosts } from '@/core/pitch';
import { projectOnSegment, type Vec2 } from '@/core/vec2';
import { INTENT_COLORS, RAMP_SPECS, rgbaCss, scoreRamp, type RGBA, type RampSpec } from './colors';
import { toScreen, px, type Transform } from './pitch';
import { FONT, roundRect } from './players';
import { INTENT_LABELS, fmtNumber } from '../format';

// ---------------------------------------------------------------------------
// Cartes de chaleur : rastérisation à la résolution des cellules, mise en cache par temps
// ---------------------------------------------------------------------------
export class HeatmapCache {
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private key = '';

  private ensure(cols: number, rows: number): { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } {
    if (!this.canvas || this.canvas.width !== cols || this.canvas.height !== rows) {
      this.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(cols, rows) : Object.assign(document.createElement('canvas'), { width: cols, height: rows });
    }
    const ctx = (this.canvas as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D;
    return { canvas: this.canvas, ctx };
  }

  /** Dessine `field` sur le terrain avec la rampe donnée ; re-rastérise seulement si la clé change. */
  draw(ctx: CanvasRenderingContext2D, t: Transform, field: ScalarField, ramp: (v: number) => RGBA, key: string, alpha = 0.45): void {
    const { canvas, ctx: octx } = this.ensure(field.cols, field.rows);
    if (key !== this.key) {
      this.key = key;
      const img = octx.createImageData(field.cols, field.rows);
      const d = img.data;
      for (let k = 0; k < field.data.length; k++) {
        const c = ramp(field.data[k]);
        d[k * 4] = c[0]; d[k * 4 + 1] = c[1]; d[k * 4 + 2] = c[2]; d[k * 4 + 3] = c[3];
      }
      octx.putImageData(img, 0, 0);
    }
    const half = field.cellSize / 2;
    const tl = toScreen(t, { x: -PITCH.halfLength - half, y: -PITCH.halfWidth - half });
    const w = px(t, field.cols * field.cellSize), h = px(t, field.rows * field.cellSize);
    const ptl = toScreen(t, { x: -PITCH.halfLength, y: -PITCH.halfWidth });
    ctx.save();
    ctx.beginPath();
    ctx.rect(ptl.x, ptl.y, px(t, PITCH.length), px(t, PITCH.width));
    ctx.clip();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas as CanvasImageSource, tl.x, tl.y, w, h);
    ctx.restore();
  }
}

/** Équipe considérée en attaque (possession, sinon A). */
export const attackingTeam = (state: MatchState): TeamId => state.possession ?? 'A';

export function threatField(f: FieldSet, team: TeamId): ScalarField { return team === 'A' ? f.threatA : f.threatB; }
export function pressureAgainst(f: FieldSet, team: TeamId): ScalarField { return team === 'A' ? f.pressureByB : f.pressureByA; }

// ---------------------------------------------------------------------------
// Espaces disponibles : maxima locaux de contrôle × menace × (1 − pression)
// ---------------------------------------------------------------------------
export interface SpaceSpot { pos: Vec2; value: number }

export function findSpaces(f: FieldSet, team: TeamId, n = 6, minSep = 9): SpaceSpot[] {
  const ctrl = f.controlA, thr = threatField(f, team), prs = pressureAgainst(f, team);
  const cols = ctrl.cols, rows = ctrl.rows;
  const val = new Float32Array(cols * rows);
  for (let k = 0; k < val.length; k++) {
    const c = team === 'A' ? ctrl.data[k] : 1 - ctrl.data[k];
    val[k] = c * thr.data[k] * (1 - prs.data[k]);
  }
  const spots: SpaceSpot[] = [];
  for (let j = 1; j < rows - 1; j++)
    for (let i = 1; i < cols - 1; i++) {
      const k = j * cols + i;
      const v = val[k];
      if (v < 0.02) continue;
      let isMax = true;
      for (let dj = -1; dj <= 1 && isMax; dj++)
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          if (val[(j + dj) * cols + (i + di)] > v) { isMax = false; break; }
        }
      if (isMax) spots.push({ pos: { x: ctrl.xOf(i), y: ctrl.yOf(j) }, value: v });
    }
  spots.sort((a, b) => b.value - a.value);
  const out: SpaceSpot[] = [];
  const floor = (spots[0]?.value ?? 0) * 0.2; // ignore les maxima négligeables
  for (const s of spots) {
    if (s.value < floor) break;
    if (out.every((o) => Math.hypot(o.pos.x - s.pos.x, o.pos.y - s.pos.y) >= minSep)) out.push(s);
    if (out.length >= n) break;
  }
  return out;
}

export function drawSpaces(ctx: CanvasRenderingContext2D, t: Transform, spots: SpaceSpot[]): void {
  if (!spots.length) return;
  const vmax = spots[0].value || 1;
  ctx.save();
  ctx.font = `700 ${Math.max(10, Math.round(px(t, 1.4)))}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const s of spots) {
    const p = toScreen(t, s.pos);
    const r = px(t, 3 + 4 * (s.value / vmax));
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    g.addColorStop(0, 'rgba(253, 230, 138, 0.55)');
    g.addColorStop(1, 'rgba(253, 230, 138, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(253, 230, 138, 0.8)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 0.7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#fef3c7';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    const label = fmtNumber(s.value, 2);
    ctx.strokeText(label, p.x, p.y);
    ctx.fillText(label, p.x, p.y);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Lignes de passe et options du porteur
// ---------------------------------------------------------------------------
function arrowHead(ctx: CanvasRenderingContext2D, from: Vec2, to: Vec2, size: number): void {
  const a = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - size * Math.cos(a - 0.45), to.y - size * Math.sin(a - 0.45));
  ctx.lineTo(to.x - size * Math.cos(a + 0.45), to.y - size * Math.sin(a + 0.45));
  ctx.closePath();
  ctx.fill();
}

function pill(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, bg: string, fg = '#fff', size = 11): void {
  ctx.save();
  ctx.font = `700 ${size}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 10, h = size + 6;
  ctx.fillStyle = bg;
  roundRect(ctx, x - w / 2, y - h / 2, w, h, h / 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = fg;
  ctx.fillText(text, x, y + 0.5);
  ctx.restore();
}

/** Point d'arrivée d'un candidat (pour le tracé) ou null. */
export function candidateEndpoint(c: Candidate, owner: Player): Vec2 | null {
  const a = c.action;
  if (a.type === 'pass') return a.targetPoint;
  if (a.type === 'dribble') return { x: owner.pos.x + a.direction.x * a.distance, y: owner.pos.y + a.direction.y * a.distance };
  if (a.type === 'shoot' || a.type === 'clear') return a.targetPoint;
  if (a.type === 'move') return a.target;
  return null;
}

export interface PassLineOptions {
  hovered: Candidate | null;
  labelSize: number;
}

/** Probabilité en deçà de laquelle une ligne de passe non choisie ni survolée n'affiche pas d'étiquette. */
const PILL_MIN_PROBABILITY = 0.05;

export function drawPassLines(ctx: CanvasRenderingContext2D, t: Transform, state: MatchState, decision: Decision, opt: PassLineOptions): void {
  const owner = state.players[decision.playerId];
  if (!owner) return;
  const cands = decision.candidates.filter((c) => c.action.type !== 'move');
  if (!cands.length) return;
  const scores = cands.map((c) => c.score);
  const lo = Math.min(...scores), hi = Math.max(...scores);
  const norm = (s: number): number => (hi - lo < 1e-6 ? 1 : (s - lo) / (hi - lo));
  const o = toScreen(t, owner.pos);
  const dir = attackDir(owner.team);

  // Dessine d'abord les non choisis, puis le choisi au-dessus
  const ordered = [...cands].reverse().sort((a, b) => Number(a === decision.chosen) - Number(b === decision.chosen));
  for (const c of ordered) {
    const chosen = c === decision.chosen;
    const hovered = c === opt.hovered;
    const color = rgbaCss(scoreRamp(norm(c.score)));
    const width = (1.2 + 4.5 * c.probability) * (chosen ? 1.4 : 1);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = hovered ? '#ffffff' : color;
    ctx.fillStyle = hovered ? '#ffffff' : color;
    ctx.lineWidth = hovered ? width + 1.5 : width;
    ctx.globalAlpha = chosen || hovered ? 1 : 0.8;
    if (chosen || hovered) { ctx.shadowColor = hovered ? 'rgba(255,255,255,0.9)' : color; ctx.shadowBlur = 12; }
    const a = c.action;
    if (a.type === 'pass') {
      const e = toScreen(t, a.targetPoint);
      if (a.kind === 'through') ctx.setLineDash([px(t, 1.2), px(t, 0.9)]);
      if (a.kind === 'lob') ctx.setLineDash([px(t, 0.4), px(t, 0.6)]);
      // Raccourcit légèrement pour ne pas couvrir les disques
      const dx = e.x - o.x, dy = e.y - o.y, l = Math.hypot(dx, dy) || 1;
      const r = px(t, 1.5);
      const s = { x: o.x + (dx / l) * r, y: o.y + (dy / l) * r };
      const f = { x: e.x - (dx / l) * r * (chosen ? 1.2 : 1), y: e.y - (dy / l) * r * (chosen ? 1.2 : 1) };
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(f.x, f.y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (chosen) arrowHead(ctx, s, { x: f.x + (dx / l) * r * 0.5, y: f.y + (dy / l) * r * 0.5 }, Math.max(8, px(t, 1.8)));
      ctx.shadowBlur = 0;
      // Étiquette de probabilité au bout de la ligne, décalée perpendiculairement (les passes quasi impossibles
      // non choisies ni survolées n'en ont pas : leurs étiquettes « 0,00 » s'empilaient autour du porteur)
      if (chosen || hovered || c.probability >= PILL_MIN_PROBABILITY) {
        const lx = e.x - (dx / l) * px(t, 3.2) - (dy / l) * px(t, 1.8);
        const ly = e.y - (dy / l) * px(t, 3.2) + (dx / l) * px(t, 1.8);
        pill(ctx, lx, ly, fmtNumber(c.probability, 2), hovered ? '#ffffff' : color, hovered ? '#111827' : '#ffffff', opt.labelSize);
      }
    } else if (a.type === 'dribble') {
      const e = toScreen(t, { x: owner.pos.x + a.direction.x * a.distance, y: owner.pos.y + a.direction.y * a.distance });
      const dx = e.x - o.x, dy = e.y - o.y, l = Math.hypot(dx, dy) || 1;
      const s = { x: o.x + (dx / l) * px(t, 1.5), y: o.y + (dy / l) * px(t, 1.5) };
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(e.x, e.y);
      ctx.stroke();
      arrowHead(ctx, s, { x: e.x + (dx / l) * 4, y: e.y + (dy / l) * 4 }, Math.max(7, px(t, 1.4)));
      ctx.shadowBlur = 0;
      if (chosen || hovered) pill(ctx, e.x + (dx / l) * px(t, 2.5), e.y + (dy / l) * px(t, 2.5), fmtNumber(c.probability, 2), hovered ? '#fff' : color, hovered ? '#111827' : '#fff', opt.labelSize);
    } else if (a.type === 'shoot') {
      const [p1, p2] = goalPosts(dir).map((p) => toScreen(t, p));
      ctx.beginPath();
      ctx.moveTo(o.x, o.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.closePath();
      ctx.globalAlpha = chosen || hovered ? 0.35 : 0.18;
      ctx.fill();
      ctx.globalAlpha = chosen || hovered ? 0.9 : 0.5;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.shadowBlur = 0;
      if (chosen || hovered) {
        const m = toScreen(t, a.targetPoint);
        pill(ctx, (o.x + m.x) / 2, (o.y + m.y) / 2, `tir ${fmtNumber(c.probability, 2)}`, hovered ? '#fff' : color, hovered ? '#111827' : '#fff', opt.labelSize);
      }
    } else if (a.type === 'hold') {
      ctx.beginPath();
      ctx.arc(o.x, o.y, px(t, 2.4), 0, Math.PI * 2);
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = Math.max(1.5, width * 0.6);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (a.type === 'clear') {
      const e = toScreen(t, a.targetPoint);
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(o.x, o.y);
      ctx.lineTo(e.x, e.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();

    // Menaces : anneau d'alerte sur les adversaires susceptibles d'intercepter
    if (c.threats?.length && (chosen || hovered)) {
      const end = candidateEndpoint(c, owner);
      for (const id of c.threats) {
        const th = state.players[id];
        if (!th) continue;
        const s = toScreen(t, th.pos);
        ctx.save();
        ctx.strokeStyle = hovered ? '#fbbf24' : 'rgba(251,191,36,0.85)';
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(s.x, s.y, px(t, 1.9), 0, Math.PI * 2);
        ctx.stroke();
        if (hovered && end) {
          const proj = projectOnSegment(th.pos, owner.pos, end);
          const ps = toScreen(t, proj.point);
          ctx.setLineDash([2, 3]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(ps.x, ps.y);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Trajectoire prévue du ballon
// ---------------------------------------------------------------------------
export function drawFlight(ctx: CanvasRenderingContext2D, t: Transform, state: MatchState): void {
  const fl = state.ball.flight;
  if (!fl) return;
  const a = toScreen(t, fl.origin), b = toScreen(t, fl.targetPoint);
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(b.x, b.y, px(t, 0.8), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Déplacements (décisions « move ») et affectations défensives
// ---------------------------------------------------------------------------
export function drawMoves(ctx: CanvasRenderingContext2D, t: Transform, state: MatchState, decisions: Map<number, Decision>, labelSize: number): void {
  ctx.save();
  for (const p of state.players) {
    const d = decisions.get(p.id) ?? p.decision;
    if (!d || d.chosen.action.type !== 'move') continue;
    const a = d.chosen.action;
    const s = toScreen(t, p.pos), e = toScreen(t, a.target);
    const l = Math.hypot(e.x - s.x, e.y - s.y);
    if (l < px(t, 1.2)) continue;
    const color = INTENT_COLORS[a.intent] ?? '#cbd5e1';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(e.x, e.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(e.x, e.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    pill(ctx, e.x, e.y - labelSize * 1.2, INTENT_LABELS[a.intent], 'rgba(15,23,42,0.78)', color, labelSize - 1);
  }
  ctx.restore();
}

export function drawDefence(ctx: CanvasRenderingContext2D, t: Transform, state: MatchState, decisions: Map<number, Decision>): void {
  const def = otherTeam(attackingTeam(state));
  ctx.save();
  for (const p of state.players) {
    if (p.team !== def) continue;
    const d = decisions.get(p.id) ?? p.decision;
    if (!d || d.chosen.action.type !== 'move') continue;
    const a = d.chosen.action;
    let target: Vec2 | null = null;
    if (a.intent === 'press' || a.intent === 'chase' || a.intent === 'intercept') target = state.ball.pos;
    else if (a.markId !== undefined && state.players[a.markId]) target = state.players[a.markId].pos;
    else if (a.intent === 'mark') target = a.target;
    if (!target) continue;
    const s = toScreen(t, p.pos), e = toScreen(t, target);
    const color = INTENT_COLORS[a.intent] ?? '#fb7185';
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(e.x, e.y);
    ctx.stroke();
    ctx.fillStyle = color;
    arrowHead(ctx, s, e, 8);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Légende de la carte de chaleur active
// ---------------------------------------------------------------------------
export function drawLegend(ctx: CanvasRenderingContext2D, t: Transform, spec: RampSpec): void {
  const w = Math.min(220, t.width * 0.3), h = 12, pad = 10;
  const x = pad + 6, y = t.height - pad - h - 26;
  ctx.save();
  ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
  roundRect(ctx, x - 8, y - 22, w + 16, h + 44, 8);
  ctx.fill();
  ctx.font = `600 11px ${FONT}`;
  ctx.fillStyle = '#e2e8f0';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(spec.title, x, y - 8);
  const g = ctx.createLinearGradient(x, 0, x + w, 0);
  for (let i = 0; i <= 10; i++) g.addColorStop(i / 10, rgbaCss(spec.ramp(i / 10), 1 / Math.max(0.15, spec.ramp(i / 10)[3] / 255) * 0.9));
  ctx.fillStyle = g;
  roundRect(ctx, x, y, w, h, 3);
  ctx.fill();
  ctx.font = `500 10px ${FONT}`;
  ctx.fillStyle = '#cbd5e1';
  ctx.fillText(spec.low, x, y + h + 13);
  ctx.textAlign = 'right';
  ctx.fillText(spec.high, x + w, y + h + 13);
  ctx.restore();
}

export const RAMP_FOR_OVERLAY = { control: RAMP_SPECS.control, threat: RAMP_SPECS.threat, pressure: RAMP_SPECS.pressure } as const;
