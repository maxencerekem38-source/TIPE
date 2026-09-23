/**
 * Outils statistiques pour le protocole expérimental :
 * moyenne, écart-type, intervalle de confiance, test de Welch, bootstrap.
 */
export const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
export const mean = (xs: number[]): number => (xs.length ? sum(xs) / xs.length : 0);

/** Variance non biaisée (n − 1). */
export const variance = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1);
};
export const std = (xs: number[]): number => Math.sqrt(variance(xs));
export const stderr = (xs: number[]): number => (xs.length ? std(xs) / Math.sqrt(xs.length) : 0);

export const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const k = Math.floor(s.length / 2);
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
};

export const quantile = (xs: number[], q: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};

/**
 * Quantile de la loi de Student (approximation de Hill, précise à ~1e-3 pour ν ≥ 3),
 * utilisé pour les intervalles de confiance à petits échantillons.
 */
export function tQuantile(p: number, df: number): number {
  if (df <= 0) return NaN;
  if (df > 200) return normalQuantile(p);
  // Approximation (Abramowitz–Stegun 26.7.5 / Hill 1970)
  const z = normalQuantile(p);
  const g1 = (z ** 3 + z) / 4;
  const g2 = (5 * z ** 5 + 16 * z ** 3 + 3 * z) / 96;
  const g3 = (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / 384;
  const g4 = (79 * z ** 9 + 776 * z ** 7 + 1482 * z ** 5 - 1920 * z ** 3 - 945 * z) / 92160;
  return z + g1 / df + g2 / df ** 2 + g3 / df ** 3 + g4 / df ** 4;
}

/** Quantile de la loi normale centrée réduite (algorithme d'Acklam). */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425, phigh = 1 - plow;
  let q: number, r: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= phigh) {
    q = p - 0.5;
    r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Intervalle de confiance de Student sur la moyenne, niveau `level` (défaut 95 %). */
export function confidenceInterval(xs: number[], level = 0.95): { mean: number; low: number; high: number; halfWidth: number } {
  const m = mean(xs);
  if (xs.length < 2) return { mean: m, low: m, high: m, halfWidth: 0 };
  const t = tQuantile(1 - (1 - level) / 2, xs.length - 1);
  const hw = t * stderr(xs);
  return { mean: m, low: m - hw, high: m + hw, halfWidth: hw };
}

/**
 * Test t de Welch (deux échantillons de variances inégales).
 * Retourne la statistique t, les degrés de liberté et une p-value bilatérale approchée.
 */
export function welchTest(xs: number[], ys: number[]): { t: number; df: number; pValue: number } {
  const n1 = xs.length, n2 = ys.length;
  if (n1 < 2 || n2 < 2) return { t: 0, df: 0, pValue: 1 };
  const v1 = variance(xs) / n1, v2 = variance(ys) / n2;
  const denom = Math.sqrt(v1 + v2);
  if (denom === 0) return { t: 0, df: n1 + n2 - 2, pValue: mean(xs) === mean(ys) ? 1 : 0 };
  const t = (mean(xs) - mean(ys)) / denom;
  const df = (v1 + v2) ** 2 / (v1 ** 2 / (n1 - 1) + v2 ** 2 / (n2 - 1));
  return { t, df, pValue: 2 * (1 - studentCdf(Math.abs(t), df)) };
}

/** Fonction de répartition de Student via la fonction bêta incomplète régularisée. */
export function studentCdf(t: number, df: number): number {
  const x = df / (df + t * t);
  const ib = regularizedIncompleteBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - 0.5 * ib : 0.5 * ib;
}

function logGamma(z: number): number {
  const g = 7;
  const coef = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = coef[0];
  for (let i = 1; i < g + 2; i++) x += coef[i] / (z + i);
  const tt = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(tt) - tt + Math.log(x);
}

/** Bêta incomplète régularisée I_x(a,b) par fraction continue (Numerical Recipes). */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  const cf = (xx: number, aa: number, bb: number): number => {
    const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
    const qab = aa + bb, qap = aa + 1, qam = aa - 1;
    let c = 1, d = 1 - (qab * xx) / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m;
      let aaa = (m * (bb - m) * xx) / ((qam + m2) * (aa + m2));
      d = 1 + aaa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aaa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aaa = (-(aa + m) * (qab + m) * xx) / ((aa + m2) * (qap + m2));
      d = 1 + aaa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aaa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  };
  if (x < (a + 1) / (a + b + 2)) return (bt * cf(x, a, b)) / a;
  return 1 - (bt * cf(1 - x, b, a)) / b;
}

/** Bootstrap percentile de la moyenne (utilise un générateur fourni pour la reproductibilité). */
export function bootstrapMean(xs: number[], rnd: () => number, iterations = 2000, level = 0.95): { low: number; high: number } {
  if (!xs.length) return { low: 0, high: 0 };
  const means: number[] = [];
  for (let k = 0; k < iterations; k++) {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rnd() * xs.length)];
    means.push(s / xs.length);
  }
  return { low: quantile(means, (1 - level) / 2), high: quantile(means, 1 - (1 - level) / 2) };
}
