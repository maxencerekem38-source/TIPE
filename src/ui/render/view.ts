/**
 * Vue Canvas : gestion du DPR et du redimensionnement, composition des couches à chaque image
 * (terrain → cartes de chaleur → calques → joueurs → ballon → légende) et interactions souris.
 */
import type { AppState } from '../app';
import { TEAM_COLORS } from './colors';
import { drawAttackHints, drawPitch, makeTransform, toWorld, px, type Transform } from './pitch';
import { drawBall, drawBallTrail, drawPlayers, FONT } from './players';
import {
  HeatmapCache, RAMP_FOR_OVERLAY, attackingTeam, drawDefence, drawFlight, drawLegend, drawMoves, drawPassLines, drawSpaces,
  findSpaces, pressureAgainst, threatField, type SpaceSpot,
} from './overlays';
import { controlRamp, pressureRamp, threatRamp } from './colors';
import { roundRect } from './players';
import { fmtNumber } from '../format';

export class PitchView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private transform: Transform = makeTransform(1, 1);
  private heat = new HeatmapCache();
  private spacesCache: { key: string; spots: SpaceSpot[] } = { key: '', spots: [] };
  private cssWidth = 1;
  private cssHeight = 1;
  private dpr = 1;
  private mouse: { x: number; y: number } | null = null;

  constructor(container: HTMLElement, private app: AppState) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pitch-canvas';
    this.canvas.setAttribute('aria-label', 'Terrain de simulation');
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    const ro = new ResizeObserver(() => this.resize(container));
    ro.observe(container);
    this.resize(container);
    this.bindInteraction();
  }

  private resize(container: HTMLElement): void {
    const rect = container.getBoundingClientRect();
    this.cssWidth = Math.max(1, Math.floor(rect.width));
    this.cssHeight = Math.max(1, Math.floor(rect.height));
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.cssWidth * this.dpr);
    this.canvas.height = Math.round(this.cssHeight * this.dpr);
    this.canvas.style.width = `${this.cssWidth}px`;
    this.canvas.style.height = `${this.cssHeight}px`;
    this.transform = makeTransform(this.cssWidth, this.cssHeight);
    this.render(performance.now() / 1000);
  }

  get currentTransform(): Transform { return this.transform; }

  private bindInteraction(): void {
    const c = this.canvas;
    const worldAt = (ev: MouseEvent) => {
      const r = c.getBoundingClientRect();
      return toWorld(this.transform, { x: ev.clientX - r.left, y: ev.clientY - r.top });
    };
    c.addEventListener('mousemove', (ev) => {
      const r = c.getBoundingClientRect();
      this.mouse = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      const id = this.app.playerAt(worldAt(ev), 2);
      this.app.hoveredPlayerId = id;
      c.style.cursor = id !== null ? 'pointer' : 'default';
    });
    c.addEventListener('mouseleave', () => { this.mouse = null; this.app.hoveredPlayerId = null; });
    c.addEventListener('click', (ev) => {
      const id = this.app.playerAt(worldAt(ev), 2);
      this.app.selectPlayer(id);
    });
  }

  /** Rendu complet d'une image ; `now` en secondes (temps réel, pour les animations). */
  render(now: number): void {
    const { ctx, transform: t, app } = this;
    const state = app.state;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    drawPitch(ctx, t);
    drawAttackHints(ctx, t, TEAM_COLORS.A.light, TEAM_COLORS.B.light);

    const f = state.fields;
    const att = attackingTeam(state);
    let legend: keyof typeof RAMP_FOR_OVERLAY | null = null;
    if (f) {
      if (app.overlays.control) { this.heat.draw(ctx, t, f.controlA, controlRamp, `control:${f.time}`, 0.45); legend = 'control'; }
      else if (app.overlays.threat) { this.heat.draw(ctx, t, threatField(f, att), threatRamp, `threat:${att}:${f.time}`, 0.5); legend = 'threat'; }
      else if (app.overlays.pressure) { this.heat.draw(ctx, t, pressureAgainst(f, att), pressureRamp, `pressure:${att}:${f.time}`, 0.5); legend = 'pressure'; }
      if (app.overlays.spaces) {
        const key = `${att}:${f.time}`;
        if (this.spacesCache.key !== key) this.spacesCache = { key, spots: findSpaces(f, att) };
        drawSpaces(ctx, t, this.spacesCache.spots);
      }
    }
    const labelSize = Math.max(10, Math.min(13, Math.round(px(t, 1.3))));
    if (app.overlays.moves) drawMoves(ctx, t, state, app.sim.decisions, labelSize);
    if (app.overlays.defence) drawDefence(ctx, t, state, app.sim.decisions);
    if (app.overlays.trajectories) {
      drawBallTrail(ctx, t, app.ballTrail, state.time);
      drawFlight(ctx, t, state);
    }
    if (app.overlays.passLines) {
      const d = app.focusDecision;
      if (d && d.chosen.action.type !== 'move') drawPassLines(ctx, t, state, d, { hovered: app.hoveredCandidate, labelSize });
    }
    drawPlayers(ctx, t, state, { selectedId: app.selectedPlayerId, hoveredId: app.hoveredPlayerId, labels: app.overlays.labels, now });
    drawBall(ctx, t, state);
    if (legend) drawLegend(ctx, t, RAMP_FOR_OVERLAY[legend]);
    this.drawCursorReadout(f ? att : null);
  }

  /** Petit affichage des valeurs des champs sous le curseur (coin supérieur droit). */
  private drawCursorReadout(att: 'A' | 'B' | null): void {
    const f = this.app.state.fields;
    if (!this.mouse || !f || !att) return;
    const w = toWorld(this.transform, this.mouse);
    if (Math.abs(w.x) > 52.5 || Math.abs(w.y) > 34) return;
    const ctx = this.ctx;
    const lines = [
      `x = ${fmtNumber(w.x, 1)} m · y = ${fmtNumber(w.y, 1)} m`,
      `Contrôle A : ${fmtNumber(f.controlA.sample(w), 2)}`,
      `Menace (${att}) : ${fmtNumber(threatField(f, att).sample(w), 2)}`,
      `Pression : ${fmtNumber(pressureAgainst(f, att).sample(w), 2)}`,
    ];
    ctx.save();
    ctx.font = `500 11px ${FONT}`;
    const width = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20;
    const height = lines.length * 15 + 12;
    const x = this.cssWidth - width - 12, y = 12;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
    roundRect(ctx, x, y, width, height, 8);
    ctx.fill();
    ctx.fillStyle = '#e2e8f0';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, x + 10, y + 8 + i * 15));
    ctx.restore();
  }
}
