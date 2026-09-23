/**
 * Rendu des joueurs (disques colorés, numéro, ombre, vecteur vitesse, anneaux de sélection)
 * et du ballon (avec ombre dépendant de la hauteur et trace).
 */
import type { MatchState, Player } from '@/core/types';
import { TEAM_COLORS } from './colors';
import { toScreen, px, type Transform } from './pitch';
import { ROLE_LABELS } from '../format';
import type { TrailPoint } from '../app';

export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

export interface PlayerRenderOptions {
  selectedId: number | null;
  hoveredId: number | null;
  labels: boolean;
  /** Temps réel (s) pour l'animation de pulsation. */
  now: number;
}

export const playerColor = (p: Player): string => (p.role === 'GK' ? TEAM_COLORS[p.team].gk : TEAM_COLORS[p.team].main);

export function drawPlayers(ctx: CanvasRenderingContext2D, t: Transform, state: MatchState, opt: PlayerRenderOptions): void {
  const r = Math.max(6, px(t, 1.15));
  const ownerId = state.ball.ownerId;
  // Tri : le joueur sélectionné et le porteur au-dessus
  const order = [...state.players].sort((a, b) => Number(a.id === ownerId || a.id === opt.selectedId) - Number(b.id === ownerId || b.id === opt.selectedId));
  ctx.save();
  ctx.font = `700 ${Math.round(r * 1.05)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const p of order) {
    const s = toScreen(t, p.pos);
    const color = playerColor(p);
    // Ombre
    ctx.beginPath();
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.ellipse(s.x + r * 0.15, s.y + r * 0.35, r * 1.02, r * 0.75, 0, 0, Math.PI * 2);
    ctx.fill();
    // Vecteur vitesse
    const sp = Math.hypot(p.vel.x, p.vel.y);
    if (sp > 0.3) {
      const nx = p.vel.x / sp, ny = p.vel.y / sp;
      const l = r + px(t, Math.min(3, sp * 0.45));
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = Math.max(1.5, r * 0.22);
      ctx.lineCap = 'round';
      ctx.moveTo(s.x + nx * r * 0.9, s.y + ny * r * 0.9);
      ctx.lineTo(s.x + nx * l, s.y + ny * l);
      ctx.stroke();
    }
    // Anneau de sélection (pulsation)
    if (p.id === opt.selectedId) {
      const pulse = 0.5 + 0.5 * Math.sin(opt.now * 5);
      ctx.beginPath();
      ctx.strokeStyle = `rgba(253, 224, 71, ${0.55 + 0.45 * pulse})`;
      ctx.lineWidth = Math.max(2, r * 0.3);
      ctx.arc(s.x, s.y, r * (1.55 + 0.25 * pulse), 0, Math.PI * 2);
      ctx.stroke();
    } else if (p.id === opt.hoveredId) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = Math.max(1.5, r * 0.2);
      ctx.arc(s.x, s.y, r * 1.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Anneau du porteur
    if (p.id === ownerId) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = Math.max(2, r * 0.28);
      ctx.arc(s.x, s.y, r * 1.35, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Disque
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.14);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();
    // Numéro
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(p.number), s.x, s.y + r * 0.05);
    // Étiquette
    if (opt.labels) {
      const label = `${p.name} · ${ROLE_LABELS[p.role]}`;
      ctx.font = `600 ${Math.max(9, Math.round(r * 0.85))}px ${FONT}`;
      const w = ctx.measureText(label).width + 8;
      const h = Math.max(12, r * 1.1);
      const y = s.y + r * 1.7;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
      roundRect(ctx, s.x - w / 2, y, w, h, 3);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fillText(label, s.x, y + h / 2 + 0.5);
      ctx.font = `700 ${Math.round(r * 1.05)}px ${FONT}`;
    }
  }
  ctx.restore();
}

export function drawBallTrail(ctx: CanvasRenderingContext2D, t: Transform, trail: TrailPoint[], now: number): void {
  if (trail.length < 2) return;
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1], b = trail[i];
    const age = Math.max(0, Math.min(1, (now - b.t) / 1.5));
    const alpha = (1 - age) * 0.7;
    const sa = toScreen(t, a), sb = toScreen(t, b);
    ctx.beginPath();
    ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
    ctx.lineWidth = Math.max(1, px(t, 0.45) * (1 - age * 0.6));
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawBall(ctx: CanvasRenderingContext2D, t: Transform, state: MatchState): void {
  const b = state.ball;
  const s = toScreen(t, b.pos);
  const r = Math.max(3.5, px(t, 0.55));
  const lift = px(t, b.z * 1.2);
  ctx.save();
  // Ombre au sol, décalée selon la hauteur
  ctx.beginPath();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.ellipse(s.x + lift * 0.4, s.y + r * 0.6 + lift * 0.3, r * (1 + b.z * 0.4), r * 0.6 * (1 + b.z * 0.4), 0, 0, Math.PI * 2);
  ctx.fill();
  // Ballon
  ctx.beginPath();
  ctx.fillStyle = '#ffffff';
  ctx.arc(s.x, s.y - lift, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = Math.max(1, r * 0.3);
  ctx.strokeStyle = '#111827';
  ctx.stroke();
  // Motif : petit pentagone
  ctx.beginPath();
  ctx.fillStyle = '#111827';
  ctx.arc(s.x, s.y - lift, r * 0.32, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}
