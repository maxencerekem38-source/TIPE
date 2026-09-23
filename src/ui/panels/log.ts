/**
 * Panneau « Journal » : 50 derniers événements du match, du plus récent au plus ancien.
 */
import type { MatchEvent, MatchEventKind } from '@/core/types';
import type { AppState } from '../app';
import { el, replace } from '../dom';
import { fmtClock, fmtNumber } from '../format';

/** Libellés des événements (les types inconnus retombent sur l'identifiant brut). */
const KIND_LABELS: Partial<Record<MatchEventKind, string>> = {
  goal: 'BUT', shot: 'Tir', pass: 'Passe', pass_complete: 'Passe réussie', pass_intercepted: 'Passe interceptée',
  pass_failed: 'Passe manquée', dribble: 'Dribble', dribble_failed: 'Dribble raté', tackle: 'Tacle', turnover: 'Perte de balle',
  out: 'Sortie', restart: 'Reprise', save: 'Arrêt', possession_change: 'Changement de possession', offside: 'Hors-jeu',
};

function describe(e: MatchEvent, app: AppState): string {
  if (e.label) return e.label;
  const p = e.playerId !== undefined ? app.state.players[e.playerId] : undefined;
  const t = e.targetId !== undefined ? app.state.players[e.targetId] : undefined;
  let s = KIND_LABELS[e.kind] ?? e.kind;
  if (p) s += ` — n°${p.number}`;
  if (t) s += ` → n°${t.number}`;
  if (e.value !== undefined) s += ` (${fmtNumber(e.value, 2)})`;
  return s;
}

export function createLogPanel(app: AppState): HTMLElement {
  const list = el('ul', { class: 'log-list' });
  const root = el('div', { class: 'panel log-panel' }, list);
  let lastLen = -1, lastFirst: MatchEvent | null = null;
  const refresh = (): void => {
    const ev = app.state.events;
    const first = ev[ev.length - 1] ?? null;
    if (ev.length === lastLen && first === lastFirst) return;
    lastLen = ev.length; lastFirst = first;
    const items = ev.slice(-50).reverse().map((e) =>
      el('li', { class: `log-item kind-${e.kind}` },
        el('span', { class: 'log-time mono' }, fmtClock(e.time)),
        el('span', { class: `dot team-${e.team.toLowerCase()}` }),
        el('span', { class: 'log-text' }, describe(e, app)),
      ),
    );
    replace(list, items.length ? items : el('li', { class: 'empty' }, 'Aucun événement pour l’instant.'));
  };
  app.on('sim', refresh);
  app.on('reset', () => { lastLen = -1; refresh(); });
  refresh();
  return root;
}
