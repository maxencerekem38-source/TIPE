/**
 * Transformation monde (mètres, origine au centre) → écran (pixels) avec letterboxing,
 * et dessin du terrain (pelouse rayée, marquages, buts).
 */
import { PITCH } from '@/core/pitch';
import type { Vec2 } from '@/core/vec2';

/** Marge (m) autour du terrain pour laisser respirer les buts et les étiquettes. */
export const PITCH_MARGIN_M = 4;

export interface Transform {
  /** Pixels par mètre. */
  scale: number;
  /** Décalage écran (px) du centre du terrain. */
  cx: number;
  cy: number;
  width: number;
  height: number;
}

/** Calcule la transformation qui inscrit le terrain (avec marge) dans width×height en conservant le ratio. */
export function makeTransform(width: number, height: number): Transform {
  const wm = PITCH.length + 2 * PITCH_MARGIN_M;
  const hm = PITCH.width + 2 * PITCH_MARGIN_M;
  const scale = Math.max(1e-6, Math.min(width / wm, height / hm));
  return { scale, cx: width / 2, cy: height / 2, width, height };
}

/** Monde → écran. L'axe y du monde pointe vers le bas de l'écran (y > 0 = côté droit vu de A). */
export const toScreen = (t: Transform, p: Vec2): Vec2 => ({ x: t.cx + p.x * t.scale, y: t.cy + p.y * t.scale });
/** Écran → monde. */
export const toWorld = (t: Transform, s: Vec2): Vec2 => ({ x: (s.x - t.cx) / t.scale, y: (s.y - t.cy) / t.scale });
/** Longueur en mètres → pixels. */
export const px = (t: Transform, metres: number): number => metres * t.scale;

/** Dessine la pelouse et les marquages dans un contexte déjà mis à l'échelle en unités écran. */
export function drawPitch(ctx: CanvasRenderingContext2D, t: Transform): void {
  const { halfLength: L, halfWidth: W } = PITCH;
  const tl = toScreen(t, { x: -L, y: -W });
  const br = toScreen(t, { x: L, y: W });
  const pw = br.x - tl.x, ph = br.y - tl.y;

  // Environnement (hors terrain)
  ctx.fillStyle = '#0f1a14';
  ctx.fillRect(0, 0, t.width, t.height);

  // Pelouse avec un léger dégradé et des bandes
  const grad = ctx.createLinearGradient(tl.x, tl.y, br.x, br.y);
  grad.addColorStop(0, '#2c8a4a');
  grad.addColorStop(1, '#23753d');
  ctx.fillStyle = grad;
  ctx.fillRect(tl.x - px(t, PITCH_MARGIN_M), tl.y - px(t, PITCH_MARGIN_M), pw + 2 * px(t, PITCH_MARGIN_M), ph + 2 * px(t, PITCH_MARGIN_M));
  const bands = 14;
  const bw = pw / bands;
  ctx.fillStyle = 'rgba(255,255,255,0.045)';
  for (let i = 0; i < bands; i += 2) ctx.fillRect(tl.x + i * bw, tl.y - px(t, PITCH_MARGIN_M), bw, ph + 2 * px(t, PITCH_MARGIN_M));

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = Math.max(1, px(t, 0.12));
  ctx.lineJoin = 'round';

  // Lignes de touche et de but
  ctx.strokeRect(tl.x, tl.y, pw, ph);
  // Ligne médiane
  const c = toScreen(t, { x: 0, y: 0 });
  ctx.beginPath();
  ctx.moveTo(c.x, tl.y);
  ctx.lineTo(c.x, br.y);
  ctx.stroke();
  // Rond central + point
  ctx.beginPath();
  ctx.arc(c.x, c.y, px(t, PITCH.centreCircleRadius), 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.arc(c.x, c.y, Math.max(1.5, px(t, 0.25)), 0, Math.PI * 2);
  ctx.fill();

  for (const side of [-1, 1] as const) {
    const gx = side * L;
    // Surface de réparation
    const pa1 = toScreen(t, { x: gx, y: -PITCH.penaltyAreaHalfWidth });
    const pa2 = toScreen(t, { x: gx - side * PITCH.penaltyAreaLength, y: PITCH.penaltyAreaHalfWidth });
    ctx.strokeRect(Math.min(pa1.x, pa2.x), pa1.y, Math.abs(pa2.x - pa1.x), pa2.y - pa1.y);
    // Surface de but
    const ga1 = toScreen(t, { x: gx, y: -PITCH.goalAreaHalfWidth });
    const ga2 = toScreen(t, { x: gx - side * PITCH.goalAreaLength, y: PITCH.goalAreaHalfWidth });
    ctx.strokeRect(Math.min(ga1.x, ga2.x), ga1.y, Math.abs(ga2.x - ga1.x), ga2.y - ga1.y);
    // Point de penalty
    const ps = toScreen(t, { x: gx - side * PITCH.penaltySpotDistance, y: 0 });
    ctx.beginPath();
    ctx.arc(ps.x, ps.y, Math.max(1.5, px(t, 0.25)), 0, Math.PI * 2);
    ctx.fill();
    // Arc de cercle de la surface
    const r = px(t, PITCH.centreCircleRadius);
    const edgeX = toScreen(t, { x: gx - side * PITCH.penaltyAreaLength, y: 0 }).x;
    const dx = Math.abs(edgeX - ps.x);
    const ang = Math.acos(Math.min(1, dx / r));
    ctx.beginPath();
    if (side === 1) ctx.arc(ps.x, ps.y, r, Math.PI - ang, Math.PI + ang);
    else ctx.arc(ps.x, ps.y, r, -ang, ang);
    ctx.stroke();
    // Arcs de coin
    for (const sy of [-1, 1] as const) {
      const corner = toScreen(t, { x: gx, y: sy * W });
      ctx.beginPath();
      const a0 = side === 1 ? (sy === 1 ? Math.PI : Math.PI / 2) : sy === 1 ? -Math.PI / 2 : 0;
      ctx.arc(corner.x, corner.y, px(t, PITCH.cornerArcRadius), a0, a0 + Math.PI / 2);
      ctx.stroke();
    }
    // But (filet derrière la ligne)
    const g1 = toScreen(t, { x: gx, y: -PITCH.goalHalfWidth });
    const g2 = toScreen(t, { x: gx + side * PITCH.goalDepth, y: PITCH.goalHalfWidth });
    const gxMin = Math.min(g1.x, g2.x), gw = Math.abs(g2.x - g1.x), gh = g2.y - g1.y;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(gxMin, g1.y, gw, gh);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    const mesh = Math.max(3, px(t, 0.6));
    ctx.beginPath();
    for (let x = gxMin; x <= gxMin + gw + 0.1; x += mesh) { ctx.moveTo(x, g1.y); ctx.lineTo(x, g2.y); }
    for (let y = g1.y; y <= g2.y + 0.1; y += mesh) { ctx.moveTo(gxMin, y); ctx.lineTo(gxMin + gw, y); }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = Math.max(1.5, px(t, 0.18));
    ctx.strokeRect(gxMin, g1.y, gw, gh);
    ctx.restore();
  }
  ctx.restore();
}

/** Flèche de sens d'attaque discrète, dessinée en bas du terrain. */
export function drawAttackHints(ctx: CanvasRenderingContext2D, t: Transform, colorA: string, colorB: string): void {
  const y = toScreen(t, { x: 0, y: PITCH.halfWidth + 2.2 }).y;
  const font = Math.max(9, px(t, 1.6));
  ctx.save();
  ctx.font = `600 ${font}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = colorA;
  ctx.textAlign = 'left';
  ctx.fillText('Équipe A  ⟶', toScreen(t, { x: -PITCH.halfLength, y: 0 }).x, y);
  ctx.fillStyle = colorB;
  ctx.textAlign = 'right';
  ctx.fillText('⟵  Équipe B', toScreen(t, { x: PITCH.halfLength, y: 0 }).x, y);
  ctx.restore();
}
