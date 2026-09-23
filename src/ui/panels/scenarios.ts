/**
 * Panneau « Scénarios » : situations prédéfinies, regroupées par catégorie (en-têtes). Le registre `BUILTIN_SCENARIOS`
 * peut être remplacé/complété plus tard par un simple import d'une liste { id, name, description, apply(sim) }.
 */
import type { Simulation } from '@/engine/loop';
import type { AppState, Scenario } from '../app';
import { el, replace } from '../dom';

/** Forme attendue d'un scénario externe (src/scenarios) : agit directement sur la simulation. */
export interface SimScenario { id: string; name: string; description: string; apply: (sim: Simulation) => void }

/** Adapte un scénario « simulation » en scénario « application ». */
export const fromSimScenario = (s: SimScenario): Scenario => ({ id: s.id, name: s.name, description: s.description, apply: (app) => { s.apply(app.sim); app.selectPlayer(null); } });

/** Catégorie des scénarios qui n'en déclarent pas. */
export const DEFAULT_CATEGORY = 'Général';

export const BUILTIN_SCENARIOS: Scenario[] = [
  { id: 'kickoff', name: 'Coup d’envoi', description: 'Réinitialise le match : formations de départ, engagement de l’équipe A.', apply: (app) => app.reset() },
];

/** Regroupe les scénarios par catégorie, dans l'ordre de première apparition (l'ordre interne est conservé). */
export function groupScenarios(scenarios: readonly Scenario[]): { category: string; items: Scenario[] }[] {
  const groups: { category: string; items: Scenario[] }[] = [];
  const byName = new Map<string, Scenario[]>();
  for (const s of scenarios) {
    const category = s.category ?? DEFAULT_CATEGORY;
    let items = byName.get(category);
    if (!items) { items = []; byName.set(category, items); groups.push({ category, items }); }
    items.push(s);
  }
  return groups;
}

export function createScenariosPanel(app: AppState): HTMLElement {
  const list = el('div', { class: 'scenario-groups' });
  const root = el('div', { class: 'panel scenarios-panel' },
    el('p', { class: 'help' }, 'Situations de jeu prédéfinies (bibliothèque du banc d’expériences) : chaque scénario place les 22 joueurs et le ballon, sélectionne le protagoniste et affiche sa décision. Lancez la lecture pour voir la suite.'),
    list,
  );
  let n = -1;
  const refresh = (): void => {
    if (app.scenarios.length === n) return;
    n = app.scenarios.length;
    replace(list, groupScenarios(app.scenarios).map((g) =>
      el('section', { class: 'section scenario-group' },
        el('h3', { class: 'section-title' }, g.category, ' ', el('span', { class: 'muted small' }, `· ${g.items.length}`)),
        el('div', { class: 'scenario-list' }, ...g.items.map((s) =>
          el('button', { class: 'scenario', onClick: () => app.loadScenario(s.id) },
            el('span', { class: 'scenario-name' }, s.name),
            el('span', { class: 'scenario-desc' }, s.description),
          ),
        )),
      ),
    ));
  };
  app.on('ui', refresh);
  refresh();
  return root;
}
