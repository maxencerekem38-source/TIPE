/**
 * Panneau « Scénarios » : situations prédéfinies. Le registre `BUILTIN_SCENARIOS` peut être
 * remplacé/complété plus tard par un simple import d'une liste { id, name, description, apply(sim) }.
 */
import type { Simulation } from '@/engine/loop';
import type { AppState, Scenario } from '../app';
import { el, replace } from '../dom';

/** Forme attendue d'un scénario externe (src/scenarios) : agit directement sur la simulation. */
export interface SimScenario { id: string; name: string; description: string; apply: (sim: Simulation) => void }

/** Adapte un scénario « simulation » en scénario « application ». */
export const fromSimScenario = (s: SimScenario): Scenario => ({ id: s.id, name: s.name, description: s.description, apply: (app) => { s.apply(app.sim); app.selectPlayer(null); } });

export const BUILTIN_SCENARIOS: Scenario[] = [
  { id: 'kickoff', name: 'Coup d’envoi', description: 'Réinitialise le match : formations de départ, engagement de l’équipe A.', apply: (app) => app.reset() },
];

export function createScenariosPanel(app: AppState): HTMLElement {
  const list = el('div', { class: 'scenario-list' });
  const root = el('div', { class: 'panel scenarios-panel' },
    el('p', { class: 'help' }, 'Situations de jeu prédéfinies pour illustrer les décisions (attaque placée, contre, bloc bas, coup de pied arrêté…). D’autres scénarios seront chargés depuis le banc d’expériences.'),
    list,
  );
  let n = -1;
  const refresh = (): void => {
    if (app.scenarios.length === n) return;
    n = app.scenarios.length;
    replace(list, app.scenarios.map((s) =>
      el('button', { class: 'scenario', onClick: () => app.loadScenario(s.id) },
        el('span', { class: 'scenario-name' }, s.name),
        el('span', { class: 'scenario-desc' }, s.description),
      ),
    ), el('div', { class: 'placeholder' }, 'Emplacement réservé : la liste s’étendra automatiquement avec les scénarios enregistrés (registerScenario).'));
  };
  app.on('ui', refresh);
  refresh();
  return root;
}
