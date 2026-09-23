/**
 * Panneau « Statistiques » : tableau à deux colonnes (équipes) et courbes de possession / xG.
 */
import type { TeamStats } from '@/core/types';
import type { AppState } from '../app';
import { el } from '../dom';
import { fmtMs, fmtNumber, fmtPercent } from '../format';
import { TEAM_COLORS } from '../render/colors';

interface Row { label: string; value: (s: TeamStats, other: TeamStats) => string }

const ROWS: Row[] = [
  { label: 'Buts', value: (s) => String(s.goals) },
  { label: 'Tirs (cadrés)', value: (s) => `${s.shots} (${s.shotsOnTarget})` },
  { label: 'xG', value: (s) => fmtNumber(s.xG, 2) },
  { label: 'Passes (réussies, %)', value: (s) => `${s.passes} (${s.passesCompleted}, ${s.passes ? fmtPercent(s.passesCompleted / s.passes) : '—'})` },
  { label: 'Passes en profondeur', value: (s) => String(s.throughBalls) },
  { label: 'Dribbles (réussis)', value: (s) => `${s.dribbles} (${s.dribblesWon})` },
  { label: 'Tacles', value: (s) => String(s.tackles) },
  { label: 'Interceptions', value: (s) => String(s.interceptions) },
  { label: 'Pertes de balle', value: (s) => String(s.turnovers) },
  { label: 'Possession', value: (s, o) => (s.possessionTime + o.possessionTime > 0 ? fmtPercent(s.possessionTime / (s.possessionTime + o.possessionTime)) : '—') },
  { label: 'Menace créée', value: (s) => fmtNumber(s.threatCreated, 2) },
  { label: 'Décisions (latence)', value: (s) => `${s.decisions} (${s.decisions ? fmtMs(s.decisionMs / s.decisions) : '—'})` },
  { label: 'Regret cumulé', value: (s) => fmtNumber(s.regret, 3) },
];

export function createStatsPanel(app: AppState): HTMLElement {
  const cells: { a: HTMLElement; b: HTMLElement }[] = [];
  const table = el('table', { class: 'stats-table' },
    el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', { class: 'team-a' }, 'Équipe A'), el('th', { class: 'team-b' }, 'Équipe B'))),
    el('tbody', {}, ...ROWS.map((r) => {
      const a = el('td', { class: 'mono' }), b = el('td', { class: 'mono' });
      cells.push({ a, b });
      return el('tr', {}, el('td', {}, r.label), a, b);
    })),
  );
  const possCanvas = el('canvas', { class: 'sparkline', width: 360, height: 70 }) as HTMLCanvasElement;
  const xgCanvas = el('canvas', { class: 'sparkline', width: 360, height: 70 }) as HTMLCanvasElement;
  const root = el('div', { class: 'panel stats-panel' },
    table,
    el('section', { class: 'section' }, el('h3', { class: 'section-title' }, 'Part de possession (équipe A) au fil du temps'), possCanvas),
    el('section', { class: 'section' }, el('h3', { class: 'section-title' }, 'xG cumulés au fil du temps'), xgCanvas),
  );

  const refresh = (): void => {
    const st = app.state.stats;
    ROWS.forEach((r, i) => {
      cells[i].a.textContent = r.value(st.A, st.B);
      cells[i].b.textContent = r.value(st.B, st.A);
    });
    drawPossession(possCanvas, app);
    drawXg(xgCanvas, app);
  };
  app.on('sim', refresh);
  app.on('reset', refresh);
  refresh();
  return root;
}

function setupSpark(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 360, h = 70;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(148,163,184,0.08)';
  ctx.fillRect(0, 0, w, h);
  return ctx;
}

function drawPossession(c: HTMLCanvasElement, app: AppState): void {
  const ctx = setupSpark(c);
  const w = c.clientWidth || 360, h = 70;
  const data = app.timeline;
  ctx.strokeStyle = 'rgba(148,163,184,0.35)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
  ctx.setLineDash([]);
  if (data.length < 2) return;
  const t0 = data[0].t, t1 = data[data.length - 1].t || 1;
  ctx.beginPath();
  data.forEach((p, i) => {
    const x = ((p.t - t0) / Math.max(1, t1 - t0)) * w, y = h - p.possA * (h - 6) - 3;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  const last = data[data.length - 1];
  ctx.lineWidth = 2;
  ctx.strokeStyle = TEAM_COLORS.A.main;
  ctx.stroke();
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  ctx.fillStyle = 'rgba(59,130,246,0.15)';
  ctx.fill();
  ctx.fillStyle = '#e2e8f0';
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(fmtPercent(last.possA), w - 4, 12);
}

function drawXg(c: HTMLCanvasElement, app: AppState): void {
  const ctx = setupSpark(c);
  const w = c.clientWidth || 360, h = 70;
  const data = app.timeline;
  if (data.length < 2) return;
  const t0 = data[0].t, t1 = data[data.length - 1].t || 1;
  const max = Math.max(0.1, ...data.map((p) => Math.max(p.xgA, p.xgB)));
  for (const [key, color] of [['xgA', TEAM_COLORS.A.main], ['xgB', TEAM_COLORS.B.main]] as const) {
    ctx.beginPath();
    data.forEach((p, i) => {
      const x = ((p.t - t0) / Math.max(1, t1 - t0)) * w, y = h - (p[key] / max) * (h - 8) - 3;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  const last = data[data.length - 1];
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillStyle = TEAM_COLORS.A.light;
  ctx.fillText(`A ${fmtNumber(last.xgA, 2)}`, w - 4, 12);
  ctx.fillStyle = TEAM_COLORS.B.light;
  ctx.fillText(`B ${fmtNumber(last.xgB, 2)}`, w - 4, 26);
}
