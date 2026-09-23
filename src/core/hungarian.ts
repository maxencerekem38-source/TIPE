/**
 * Algorithme hongrois (Kuhn–Munkres) pour le problème d'affectation à coût minimal.
 * Utilisé pour affecter les défenseurs aux tâches (marquage, pressing, zones).
 *
 * Entrée : matrice de coûts cost[i][j] (n lignes = agents, m colonnes = tâches).
 * Sortie : assign[i] = j (indice de tâche affectée à l'agent i, ou -1 si aucune).
 * Complexité O(n²·m) — négligeable pour n, m ≤ 11.
 * Implémentation par potentiels (version de e-maxx), matrice rectangulaire autorisée (n ≤ m ;
 * si n > m, la matrice est transposée puis l'affectation inversée).
 */
export function hungarian(cost: number[][]): { assignment: number[]; totalCost: number } {
  const n = cost.length;
  if (n === 0) return { assignment: [], totalCost: 0 };
  const m = cost[0].length;
  if (m === 0) return { assignment: new Array(n).fill(-1), totalCost: 0 };

  if (n > m) {
    // Transposer : affecter les tâches aux agents puis inverser.
    const t: number[][] = [];
    for (let j = 0; j < m; j++) {
      t.push([]);
      for (let i = 0; i < n; i++) t[j].push(cost[i][j]);
    }
    const r = hungarian(t);
    const assignment = new Array(n).fill(-1);
    r.assignment.forEach((i, j) => { if (i >= 0) assignment[i] = j; });
    return { assignment, totalCost: r.totalCost };
  }

  const INF = Number.POSITIVE_INFINITY;
  const u = new Array(n + 1).fill(0);
  const vv = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0); // p[j] = ligne affectée à la colonne j (1-indexé)
  const way = new Array(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(INF);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (!used[j]) {
          const cur = cost[i0 - 1][j - 1] - u[i0] - vv[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; vv[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const assignment = new Array(n).fill(-1);
  let totalCost = 0;
  for (let j = 1; j <= m; j++) {
    if (p[j] > 0) { assignment[p[j] - 1] = j - 1; totalCost += cost[p[j] - 1][j - 1]; }
  }
  return { assignment, totalCost };
}
