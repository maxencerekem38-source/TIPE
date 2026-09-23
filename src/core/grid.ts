/**
 * Champ scalaire discrétisé sur le terrain (contrôle du terrain, menace, pression...).
 * Résolution par défaut : 2 m ⇒ 53 × 34 cellules (1802 valeurs), calculable en < 1 ms.
 */
import { PITCH } from './pitch';
import type { Vec2 } from './vec2';

export class ScalarField {
  readonly cols: number;
  readonly rows: number;
  readonly cellSize: number;
  readonly data: Float32Array;

  constructor(cellSize = 2, data?: Float32Array) {
    this.cellSize = cellSize;
    this.cols = Math.ceil(PITCH.length / cellSize) + 1;
    this.rows = Math.ceil(PITCH.width / cellSize) + 1;
    this.data = data ?? new Float32Array(this.cols * this.rows);
  }

  /** Coordonnée x du centre de la colonne i. */
  xOf(i: number): number {
    return -PITCH.halfLength + i * this.cellSize;
  }
  yOf(j: number): number {
    return -PITCH.halfWidth + j * this.cellSize;
  }
  index(i: number, j: number): number {
    return j * this.cols + i;
  }
  get(i: number, j: number): number {
    return this.data[j * this.cols + i];
  }
  set(i: number, j: number, value: number): void {
    this.data[j * this.cols + i] = value;
  }

  /** Remplit le champ avec f(x, y) évaluée au centre de chaque cellule. */
  fill(f: (x: number, y: number) => number): this {
    for (let j = 0; j < this.rows; j++) {
      const y = this.yOf(j);
      for (let i = 0; i < this.cols; i++) this.data[j * this.cols + i] = f(this.xOf(i), y);
    }
    return this;
  }

  /** Interpolation bilinéaire en un point quelconque du terrain (borné au terrain). */
  sample(p: Vec2): number {
    const fx = (p.x + PITCH.halfLength) / this.cellSize;
    const fy = (p.y + PITCH.halfWidth) / this.cellSize;
    const i0 = Math.max(0, Math.min(this.cols - 2, Math.floor(fx)));
    const j0 = Math.max(0, Math.min(this.rows - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - i0));
    const ty = Math.max(0, Math.min(1, fy - j0));
    const a = this.data[j0 * this.cols + i0];
    const b = this.data[j0 * this.cols + i0 + 1];
    const c = this.data[(j0 + 1) * this.cols + i0];
    const d = this.data[(j0 + 1) * this.cols + i0 + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  /** Valeur max/min et leur position (utile pour « exploiter un espace »). */
  argmax(): { value: number; pos: Vec2 } {
    let best = -Infinity, bi = 0, bj = 0;
    for (let j = 0; j < this.rows; j++)
      for (let i = 0; i < this.cols; i++) {
        const val = this.data[j * this.cols + i];
        if (val > best) { best = val; bi = i; bj = j; }
      }
    return { value: best, pos: { x: this.xOf(bi), y: this.yOf(bj) } };
  }

  map(f: (value: number, x: number, y: number) => number): ScalarField {
    const out = new ScalarField(this.cellSize);
    for (let j = 0; j < this.rows; j++)
      for (let i = 0; i < this.cols; i++) out.data[j * this.cols + i] = f(this.data[j * this.cols + i], this.xOf(i), this.yOf(j));
    return out;
  }

  clone(): ScalarField {
    return new ScalarField(this.cellSize, new Float32Array(this.data));
  }

  /** Itère sur toutes les cellules. */
  forEach(f: (value: number, x: number, y: number, i: number, j: number) => void): void {
    for (let j = 0; j < this.rows; j++)
      for (let i = 0; i < this.cols; i++) f(this.data[j * this.cols + i], this.xOf(i), this.yOf(j), i, j);
  }
}
