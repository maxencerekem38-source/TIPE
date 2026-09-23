/**
 * Panneau « Décision » : action optimale du joueur mis en avant, comparaison classée de tous les
 * candidats, décomposition du score par composante, formule d'utilité et explication textuelle.
 */
import type { Candidate, Decision, Player } from '@/core/types';
import type { AppState } from '../app';
import { el, replace } from '../dom';
import { actionLabel, actionTargetLabel, fmtMs, fmtNumber, fmtPercent, fmtValue, PHASE_LABELS, ROLE_LABELS, TEAM_LABELS } from '../format';
import { STYLE_LABELS } from '@/tactics/styles';
import { rgbaCss, scoreRamp } from '../render/colors';

const RESPONSE_LABELS: Record<string, string> = { hold: 'tenir', press: 'presser', cover: 'couvrir', drop: 'reculer' };

export function createDecisionPanel(app: AppState): HTMLElement {
  const root = el('div', { class: 'panel decision-panel' });
  let lastKey = '';

  const numberOf = (id: number): string => String(app.state.players[id]?.number ?? id);

  const render = (): void => {
    const id = app.focusPlayerId;
    const d = app.focusDecision;
    const player = id !== null ? app.state.players[id] : undefined;
    const key = `${id}:${d?.time}:${d?.candidates.length}:${app.expandedCandidate}:${app.hoveredCandidate === null ? '' : d?.candidates.indexOf(app.hoveredCandidate)}`;
    if (key === lastKey) return;
    lastKey = key;
    if (!player || !d) {
      replace(root, el('div', { class: 'empty' }, 'Aucune décision disponible. Lancez la simulation ou sélectionnez un joueur.'));
      return;
    }
    replace(root, header(player, app), optimalBlock(d, numberOf), comparison(d, app, numberOf), contextBlock(d), explanationBlock(d));
  };

  app.on('ui', render);
  app.on('sim', render);
  app.on('reset', () => { lastKey = ''; render(); });
  render();
  return root;
}

function header(p: Player, app: AppState): HTMLElement {
  const isOwner = app.state.ball.ownerId === p.id;
  return el('div', { class: 'decision-header' },
    el('span', { class: `dot team-${p.team.toLowerCase()}` }),
    el('div', {},
      el('div', { class: 'decision-player' }, `Joueur n°${p.number} (${ROLE_LABELS[p.role]}) — ${TEAM_LABELS[p.team]}`),
      el('div', { class: 'muted small' }, isOwner ? 'Porteur du ballon' : app.selectedPlayerId === p.id ? 'Joueur sélectionné (cliquer sur le terrain pour désélectionner)' : 'Dernier joueur au contact du ballon'),
    ),
    app.selectedPlayerId !== null ? el('button', { class: 'btn btn-small', onClick: () => app.selectPlayer(null), title: 'Revenir au porteur' }, '✕') : null,
  );
}

function optimalBlock(d: Decision, numberOf: (id: number) => string): HTMLElement {
  const c = d.chosen;
  const rows: HTMLElement[] = [
    el('div', { class: 'kv' }, el('span', { class: 'k' }, 'ACTION OPTIMALE :'), el('span', { class: 'v accent' }, actionLabel(c.action).toUpperCase())),
    el('div', { class: 'kv' }, el('span', { class: 'k' }, 'CIBLE :'), el('span', { class: 'v' }, actionTargetLabel(c.action, numberOf).toUpperCase())),
    el('div', { class: 'kv kv-2' },
      el('span', {}, el('span', { class: 'k' }, 'SCORE : '), el('span', { class: 'v mono' }, fmtNumber(c.score, 2))),
      el('span', {}, el('span', { class: 'k' }, 'PROBABILITÉ : '), el('span', { class: 'v mono' }, fmtPercent(c.probability))),
    ),
    el('div', { class: 'kv' }, el('span', { class: 'k' }, 'RAISON :'), el('span', { class: 'v reason' }, c.reason)),
  ];
  if (d.keptByHysteresis) rows.push(el('div', { class: 'tag tag-info' }, 'Intention conservée par hystérésis'));
  if (d.game) {
    const g = d.game;
    rows.push(el('div', { class: 'tag tag-info', title: `Matrice : [[${g.matrix[0].map((x) => fmtNumber(x, 2)).join(' ; ')}] ; [${g.matrix[1].map((x) => fmtNumber(x, 2)).join(' ; ')}]]` },
      `Jeu 2×2 résolu : ${g.pure ? 'stratégie pure' : `stratégie mixte (π₁ = ${fmtNumber(g.pi1, 2)})`}, valeur ${fmtNumber(g.value, 2)}`));
  }
  return el('div', { class: 'optimal' }, ...rows);
}

function comparison(d: Decision, app: AppState, numberOf: (id: number) => string): HTMLElement {
  const cands = d.candidates;
  const maxAbs = Math.max(1e-6, ...cands.map((c) => Math.abs(c.score)));
  const lo = Math.min(...cands.map((c) => c.score)), hi = Math.max(...cands.map((c) => c.score));
  const norm = (s: number): number => (hi - lo < 1e-6 ? 1 : (s - lo) / (hi - lo));
  const list = el('div', { class: 'cand-list' });
  cands.forEach((c, i) => {
    const expanded = app.expandedCandidate === i;
    const hovered = app.hoveredCandidate === c;
    const row = el('div', {
      class: `cand ${c === d.chosen ? 'chosen' : ''} ${expanded ? 'expanded' : ''} ${hovered ? 'hovered' : ''}`,
      onMouseenter: () => app.setHoveredCandidate(c),
      onMouseleave: () => app.setHoveredCandidate(null),
    });
    const head = el('div', {
      class: 'cand-head', role: 'button', tabindex: 0,
      onClick: () => { app.expandedCandidate = expanded ? -1 : i; app.setHoveredCandidate(c); app.emit('ui'); },
    },
      el('span', { class: 'cand-rank' }, String(i + 1)),
      el('span', { class: 'cand-dot', style: `background:${rgbaCss(scoreRamp(norm(c.score)))}` }),
      el('span', { class: 'cand-label' }, actionLabel(c.action)),
      el('span', { class: 'cand-target muted' }, actionTargetLabel(c.action, numberOf)),
      scoreBar(c.score, maxAbs),
      el('span', { class: 'cand-score mono' }, fmtNumber(c.score, 2)),
      el('span', { class: 'cand-prob mono muted' }, fmtPercent(c.probability)),
      el('span', { class: 'cand-chevron' }, expanded ? '▾' : '▸'),
    );
    row.append(head);
    if (expanded) row.append(breakdown(c));
    list.append(row);
  });
  return el('section', { class: 'section' },
    el('h3', { class: 'section-title' }, 'Comparaison des actions ', el('span', { class: 'muted small' }, `(${cands.length} candidats évalués)`)),
    list,
  );
}

function scoreBar(score: number, maxAbs: number): HTMLElement {
  const frac = Math.min(1, Math.abs(score) / maxAbs) * 50;
  const bar = el('span', { class: `bar ${score >= 0 ? 'pos' : 'neg'}`, style: score >= 0 ? `left:50%;width:${frac}%` : `right:50%;width:${frac}%` });
  return el('span', { class: 'score-bar', title: 'Score (utilité espérée), barre depuis la ligne zéro' }, el('span', { class: 'zero' }), bar);
}

function breakdown(c: Candidate): HTMLElement {
  const maxC = Math.max(1e-6, ...c.components.map((k) => Math.abs(k.contribution)));
  const rows = c.components.map((k) =>
    el('div', { class: 'comp-row' },
      el('span', { class: 'comp-label', title: k.key }, k.label),
      el('span', { class: 'comp-value mono' }, fmtValue(k.value, k.unit)),
      el('span', { class: 'comp-weight mono muted', title: 'Poids' }, `×${fmtNumber(k.weight, 2)}`),
      el('span', { class: 'comp-bar' },
        el('span', { class: 'zero' }),
        el('span', { class: `bar ${k.contribution >= 0 ? 'pos' : 'neg'}`, style: k.contribution >= 0 ? `left:50%;width:${(Math.abs(k.contribution) / maxC) * 50}%` : `right:50%;width:${(Math.abs(k.contribution) / maxC) * 50}%` }),
      ),
      el('span', { class: `comp-contrib mono ${k.contribution >= 0 ? 'pos' : 'neg'}` }, fmtNumber(k.contribution, 3, true)),
    ),
  );
  const P = c.probability, Vp = c.valueIfSuccess, Vm = c.valueIfFailure;
  const cost = P * Vp - (1 - P) * Vm - c.score;
  const extra: HTMLElement[] = [];
  if (c.duration !== undefined) extra.push(el('span', { class: 'tag' }, `durée ${fmtNumber(c.duration, 1)} s`));
  if (c.response) extra.push(el('span', { class: 'tag' }, `réponse adverse : ${RESPONSE_LABELS[c.response.kind] ?? c.response.kind} (Δ ${fmtNumber(c.response.delta, 2, true)})`));
  if (c.threats?.length) extra.push(el('span', { class: 'tag tag-warn' }, `${c.threats.length} menace${c.threats.length > 1 ? 's' : ''} d’interception`));
  return el('div', { class: 'breakdown' },
    el('div', { class: 'breakdown-title' }, 'Décomposition du score'),
    el('div', { class: 'comp-head' },
      el('span', {}, 'Composante'), el('span', {}, 'Valeur'), el('span', {}, 'Poids'), el('span', {}, 'Contribution'), el('span', {}, ''),
    ),
    ...rows,
    el('div', { class: 'formula mono' },
      el('div', {}, 'Score = P·V⁺ − (1−P)·V⁻ − C'),
      el('div', { class: 'muted' }, `${fmtNumber(c.score, 3)} = ${fmtNumber(P, 2)} × ${fmtNumber(Vp, 2)} − ${fmtNumber(1 - P, 2)} × ${fmtNumber(Vm, 2)} − ${fmtNumber(Math.max(0, cost), 3)}`),
    ),
    el('div', { class: 'kv-inline' },
      el('span', {}, el('span', { class: 'muted' }, 'V⁺ (succès) '), el('span', { class: 'mono' }, fmtNumber(Vp, 2))),
      el('span', {}, el('span', { class: 'muted' }, 'V⁻ (échec) '), el('span', { class: 'mono' }, fmtNumber(Vm, 2))),
    ),
    extra.length ? el('div', { class: 'tags' }, ...extra) : null,
    el('div', { class: 'small reason-line' }, c.reason),
  );
}

function contextBlock(d: Decision): HTMLElement {
  const ctx = d.context;
  const item = (k: string, v: string) => el('div', { class: 'ctx-item' }, el('span', { class: 'muted' }, k), el('span', { class: 'mono' }, v));
  return el('section', { class: 'section' },
    el('h3', { class: 'section-title' }, 'Contexte ', el('span', { class: 'muted small' }, `· calcul ${fmtMs(d.computeMs)}`)),
    el('div', { class: 'ctx-grid' },
      item('Phase', PHASE_LABELS[ctx.phase]),
      item('Style', STYLE_LABELS[ctx.style]),
      item('Formation', ctx.formation),
      item('Pression', fmtNumber(ctx.pressure, 2)),
      item('Coéquipiers dispo.', String(ctx.availableTeammates)),
      item('Supériorité locale', (ctx.localSuperiority > 0 ? '+' : '') + String(ctx.localSuperiority)),
    ),
  );
}

function explanationBlock(d: Decision): HTMLElement {
  return el('section', { class: 'section' },
    el('h3', { class: 'section-title' }, 'Explication'),
    el('pre', { class: 'explanation' }, d.explanation),
  );
}
