/**
 * Panneau « Décision » : action optimale du joueur mis en avant, comparaison classée de tous les
 * candidats, décomposition du score par composante, formule d'utilité et explication textuelle.
 */
import type { Candidate, Decision, Player } from '@/core/types';
import type { AppState } from '../app';
import { el, replace } from '../dom';
import { actionLabel, actionTargetLabel, fmtMs, fmtNumber, fmtPercent, fmtValue, intentTitle, moveTargetLabel, INTENT_LABELS, PHASE_LABELS, ROLE_LABELS, TEAM_LABELS } from '../format';
import type { Vec2 } from '@/core/vec2';
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
    replace(root, header(player, app), optimalBlock(d, numberOf, player.pos), comparison(d, app, numberOf, player.pos), contextBlock(d), explanationBlock(d));
  };

  app.on('ui', render);
  app.on('sim', render);
  app.on('reset', () => { lastKey = ''; render(); });
  render();
  return root;
}

function header(p: Player, app: AppState): HTMLElement {
  const isOwner = app.state.ball.ownerId === p.id;
  const d = app.focusDecision;
  const a = d?.chosen.action;
  const role = isOwner ? 'Porteur du ballon' : a && a.type === 'move' ? `Sans ballon — intention : ${INTENT_LABELS[a.intent]}` : 'Dernier joueur au contact du ballon';
  const hint = app.selectedPlayerId === p.id ? ' (cliquer sur le terrain ou ✕ pour revenir au porteur)' : '';
  return el('div', { class: 'decision-header' },
    el('span', { class: `dot team-${p.team.toLowerCase()}` }),
    el('div', {},
      el('div', { class: 'decision-player' }, `Joueur n°${p.number} (${ROLE_LABELS[p.role]}) — ${TEAM_LABELS[p.team]}`),
      el('div', { class: 'muted small' }, role + hint),
    ),
    app.selectedPlayerId !== null ? el('button', { class: 'btn btn-small', onClick: () => app.selectPlayer(null), title: 'Revenir au porteur' }, '✕') : null,
  );
}

function optimalBlock(d: Decision, numberOf: (id: number) => string, pos: Vec2): HTMLElement {
  const c = d.chosen;
  const a = c.action;
  const isMove = a.type === 'move';
  const rows: HTMLElement[] = [
    el('div', { class: 'kv' }, el('span', { class: 'k' }, isMove ? 'DÉPLACEMENT :' : 'ACTION OPTIMALE :'), el('span', { class: 'v accent' }, (a.type === 'move' ? intentTitle(a.intent) : actionLabel(a)).toUpperCase())),
    el('div', { class: 'kv' }, el('span', { class: 'k' }, 'CIBLE :'), el('span', { class: 'v' }, a.type === 'move' ? moveTargetLabel(a, pos) : actionTargetLabel(a, numberOf).toUpperCase())),
    el('div', { class: 'kv kv-2' },
      el('span', {}, el('span', { class: 'k' }, isMove ? 'UTILITÉ : ' : 'SCORE : '), el('span', { class: 'v mono' }, fmtNumber(c.score, 3))),
      el('span', {}, el('span', { class: 'k' }, isMove ? 'P_PASSE VERS LA CIBLE : ' : 'PROBABILITÉ : '), el('span', { class: 'v mono' }, fmtPercent(c.probability))),
    ),
    el('div', { class: 'kv' }, el('span', { class: 'k' }, 'RAISON :'), el('span', { class: 'v reason' }, c.reason)),
  ];
  if (d.keptByHysteresis) rows.push(el('div', { class: 'tag tag-info' }, 'Intention conservée par hystérésis'));
  if (d.game) {
    const g = d.game;
    rows.push(el('div', { class: 'tag tag-info', title: `Matrice : [[${g.matrix[0].map((x) => fmtNumber(x, 3)).join(' ; ')}] ; [${g.matrix[1].map((x) => fmtNumber(x, 3)).join(' ; ')}]]` },
      `Jeu 2×2 résolu : ${g.pure ? 'stratégie pure' : `stratégie mixte (π₁ = ${fmtNumber(g.pi1, 2)})`}, valeur ${fmtNumber(g.value, 3)}`));
  }
  return el('div', { class: 'optimal' }, ...rows);
}

function comparison(d: Decision, app: AppState, numberOf: (id: number) => string, pos: Vec2): HTMLElement {
  const cands = d.candidates;
  const isMove = d.chosen.action.type === 'move';
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
      el('span', { class: 'cand-main' },
        el('span', { class: 'cand-label' }, c.action.type === 'move' ? intentTitle(c.action.intent) : actionLabel(c.action)),
        el('span', { class: 'cand-target muted', title: c.action.type === 'move' ? moveTargetLabel(c.action, pos) : undefined }, c.action.type === 'move' ? moveTargetLabel(c.action, pos, true) : actionTargetLabel(c.action, numberOf)),
      ),
      scoreBar(c.score, maxAbs),
      el('span', { class: 'cand-score mono' }, fmtNumber(c.score, 3)),
      el('span', { class: 'cand-prob mono muted', title: c.action.type === 'move' ? 'Probabilité de passe rapide vers la cible' : 'Probabilité de réussite' }, fmtPercent(c.probability)),
      el('span', { class: 'cand-chevron' }, expanded ? '▾' : '▸'),
    );
    row.append(head);
    if (expanded) row.append(breakdown(c));
    list.append(row);
  });
  return el('section', { class: 'section' },
    el('h3', { class: 'section-title' }, isMove ? 'Comparaison des déplacements ' : 'Comparaison des actions ', el('span', { class: 'muted small' }, `· ${cands.length} candidats ${isMove ? 'conservés' : 'évalués'}`)),
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
  const sum = c.components.reduce((s, k) => s + k.contribution, 0);
  const isMove = c.action.type === 'move';
  const extra: HTMLElement[] = [];
  if (c.duration !== undefined) extra.push(el('span', { class: 'tag' }, `durée ${fmtNumber(c.duration, 1)} s`));
  if (c.response) extra.push(el('span', { class: 'tag' }, `réponse adverse : ${RESPONSE_LABELS[c.response.kind] ?? c.response.kind} (Δ ${fmtNumber(c.response.delta, 3, true)})`));
  if (c.threats?.length) extra.push(el('span', { class: 'tag tag-warn' }, `${c.threats.length} menace${c.threats.length > 1 ? 's' : ''} d’interception`));
  // Formule : utilité additive U(q) = Σ wᵢ·fᵢ(q) pour un déplacement, espérance P·V⁺ − (1−P)·V⁻ − C pour le porteur.
  const formula = isMove
    ? el('div', { class: 'formula mono' },
      el('div', {}, 'U(q) = Σ poids × valeur (utilité additive)'),
      el('div', { class: 'muted' }, `${fmtNumber(c.score, 3)} = Σ contributions (${fmtNumber(sum, 3)})`),
    )
    : el('div', { class: 'formula mono' },
      el('div', {}, 'Score = P·V⁺ − (1−P)·V⁻ − C'),
      el('div', { class: 'muted' }, `${fmtNumber(c.score, 3)} = ${fmtNumber(P, 2)} × ${fmtNumber(Vp, 3)} − ${fmtNumber(1 - P, 2)} × ${fmtNumber(Vm, 3)} − ${fmtNumber(Math.max(0, cost), 3)}`),
    );
  const values = isMove
    ? el('div', { class: 'kv-inline' },
      el('span', {}, el('span', { class: 'muted' }, 'P_passe vers q '), el('span', { class: 'mono' }, fmtPercent(P))),
      el('span', {}, el('span', { class: 'muted' }, 'menace xT(q) '), el('span', { class: 'mono' }, fmtNumber(Vp, 3))),
    )
    : el('div', { class: 'kv-inline' },
      el('span', {}, el('span', { class: 'muted' }, 'V⁺ (succès) '), el('span', { class: 'mono' }, fmtNumber(Vp, 3))),
      el('span', {}, el('span', { class: 'muted' }, 'V⁻ (échec) '), el('span', { class: 'mono' }, fmtNumber(Vm, 3))),
    );
  return el('div', { class: 'breakdown' },
    el('div', { class: 'breakdown-title' }, isMove ? 'Décomposition de l’utilité' : 'Décomposition du score'),
    el('div', { class: 'comp-head' },
      el('span', {}, 'Composante'), el('span', {}, 'Valeur'), el('span', {}, 'Poids'), el('span', {}, 'Contribution'), el('span', {}, ''),
    ),
    ...rows,
    formula,
    values,
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
