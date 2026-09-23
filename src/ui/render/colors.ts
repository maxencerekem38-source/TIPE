/**
 * Rampes de couleurs pour les calques (cartes de chaleur, lignes de passe) et légende.
 * Toutes les fonctions sont pures ; les couleurs sont retournées en RGBA 0..255.
 */
export type RGBA = [number, number, number, number];

export const TEAM_COLORS = {
  A: { main: '#3b82f6', gk: '#0ea5e9', light: '#93c5fd', rgb: [59, 130, 246] as [number, number, number] },
  B: { main: '#ef4444', gk: '#f97316', light: '#fca5a5', rgb: [239, 68, 68] as [number, number, number] },
} as const;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Interpolation linéaire entre les arrêts d'une rampe (positions régulièrement espacées). */
function rampAt(stops: RGBA[], t: number): RGBA {
  t = clamp01(t);
  const n = stops.length - 1;
  const f = t * n;
  const i = Math.min(n - 1, Math.floor(f));
  const u = f - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
}

/** Contrôle du terrain : divergente bleu (B contrôle, t=0) ↔ blanc ↔ rouge… non : rouge = B, bleu = A. */
export const controlRamp = (t: number): RGBA =>
  rampAt(
    [
      [239, 68, 68, 210], // B contrôle (t = 0)
      [244, 130, 130, 120],
      [235, 235, 235, 20], // neutre
      [120, 165, 250, 120],
      [59, 130, 246, 210], // A contrôle (t = 1)
    ],
    t,
  );

/** Menace : transparente → ambre → rouge. */
export const threatRamp = (t: number): RGBA =>
  rampAt(
    [
      [251, 191, 36, 0],
      [251, 191, 36, 110],
      [249, 115, 22, 170],
      [220, 38, 38, 220],
    ],
    t,
  );

/** Pression : transparente → violet clair → violet profond. */
export const pressureRamp = (t: number): RGBA =>
  rampAt(
    [
      [167, 139, 250, 0],
      [167, 139, 250, 120],
      [139, 92, 246, 180],
      [91, 33, 182, 230],
    ],
    t,
  );

/** Score d'une option : rouge (mauvais) → jaune → vert (bon). */
export const scoreRamp = (t: number): RGBA =>
  rampAt(
    [
      [239, 68, 68, 255],
      [250, 204, 21, 255],
      [34, 197, 94, 255],
    ],
    t,
  );

export const rgbaCss = (c: RGBA, alphaScale = 1): string =>
  `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${clamp01((c[3] / 255) * alphaScale).toFixed(3)})`;

/** Couleur CSS pour une intention de déplacement. */
export const INTENT_COLORS: Record<string, string> = {
  support: '#60a5fa',
  run: '#f472b6',
  width: '#38bdf8',
  create_space: '#a78bfa',
  exploit_space: '#c084fc',
  hold_shape: '#94a3b8',
  press: '#f97316',
  mark: '#fb7185',
  cover: '#fbbf24',
  zone: '#facc15',
  recover: '#22d3ee',
  intercept: '#f43f5e',
  chase: '#fde047',
  gk_position: '#34d399',
  receive: '#4ade80',
};

/** Description d'une rampe pour la légende (titre + étiquettes des extrémités). */
export interface RampSpec {
  id: 'control' | 'threat' | 'pressure';
  title: string;
  low: string;
  high: string;
  ramp: (t: number) => RGBA;
}

export const RAMP_SPECS: Record<RampSpec['id'], RampSpec> = {
  control: { id: 'control', title: 'Contrôle du terrain', low: 'Équipe B', high: 'Équipe A', ramp: controlRamp },
  threat: { id: 'threat', title: 'Menace (zones dangereuses)', low: 'faible', high: 'forte', ramp: threatRamp },
  pressure: { id: 'pressure', title: 'Pression défensive', low: 'nulle', high: 'forte', ramp: pressureRamp },
};
