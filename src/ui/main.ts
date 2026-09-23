/**
 * Point d'entrée de l'interface : construit la mise en page dans #app, crée l'état applicatif,
 * les panneaux et la vue Canvas, puis lance la boucle de rendu (rAF) avec rafraîchissement DOM ~10 Hz.
 */
import { AppState, OVERLAY_IDS } from './app';
import { el } from './dom';
import { PitchView } from './render/view';
import { createTopbar } from './panels/topbar';
import { createDecisionPanel } from './panels/decision';
import { createTacticsPanel } from './panels/tactics';
import { createLayersPanel } from './panels/layers';
import { createParamsPanel } from './panels/params';
import { createStatsPanel } from './panels/stats';
import { createLogPanel } from './panels/log';
import { BUILTIN_SCENARIOS, createScenariosPanel } from './panels/scenarios';
import { SCENARIOS, SCENARIO_CATEGORIES, copyStateInto } from '@/experiments/scenarios';
import { emptyStats } from '@/core/state-builder';

const TABS = [
  { id: 'decision', label: 'Décision' },
  { id: 'tactics', label: 'Tactiques' },
  { id: 'layers', label: 'Calques' },
  { id: 'params', label: 'Paramètres' },
  { id: 'stats', label: 'Statistiques' },
  { id: 'log', label: 'Journal' },
  { id: 'scenarios', label: 'Scénarios' },
] as const;

function boot(): void {
  const rootEl = document.getElementById('app');
  if (!rootEl) throw new Error('Élément #app introuvable');
  const app = new AppState();
  for (const s of BUILTIN_SCENARIOS) app.registerScenario(s);
  // Bibliothèque de scénarios du banc d'expériences (src/experiments/scenarios.ts), groupée par catégorie.
  for (const s of SCENARIOS) {
    app.registerScenario({
      id: s.id,
      name: `${SCENARIO_CATEGORIES[s.category]} — ${s.name}`,
      description: s.description,
      apply: (a) => {
        a.pause();
        const live = a.sim.state;
        copyStateInto(live, s.build());
        live.stats = emptyStats();
        live.score = { A: 0, B: 0 };
        live.events.length = 0;
        a.sim.decisions.clear();
        a.selectPlayer(s.protagonistId);
        a.step();
      },
    });
  }

  const stage = el('main', { class: 'stage' });
  const sidebar = el('aside', { class: 'sidebar' });
  const layout = el('div', { class: 'layout' }, stage, sidebar);
  const topbar = createTopbar(app, () => { layout.classList.toggle('sidebar-collapsed'); });
  rootEl.append(topbar, layout);

  // Onglets du panneau latéral
  const panels: Record<string, HTMLElement> = {
    decision: createDecisionPanel(app),
    tactics: createTacticsPanel(app),
    layers: createLayersPanel(app),
    params: createParamsPanel(app),
    stats: createStatsPanel(app),
    log: createLogPanel(app),
    scenarios: createScenariosPanel(app),
  };
  const tabButtons = TABS.map((t) => el('button', { class: 'tab', 'data-tab': t.id, onClick: () => showTab(t.id) }, t.label));
  const tabbar = el('nav', { class: 'tabbar', role: 'tablist' }, ...tabButtons);
  const content = el('div', { class: 'sidebar-content' });
  sidebar.append(tabbar, content);
  let currentTab = '';
  const showTab = (id: string): void => {
    if (currentTab === id) return;
    currentTab = id;
    for (const b of tabButtons) b.classList.toggle('active', b.dataset.tab === id);
    content.replaceChildren(panels[id]);
    content.scrollTop = 0;
    app.emit('ui');
  };
  showTab('decision');
  (window as any).__app = app; // pratique pour le débogage et les captures d'écran
  (window as any).__showTab = showTab;

  // Vue terrain
  const view = new PitchView(stage, app);

  // Aide clavier discrète
  stage.append(el('div', { class: 'hint-bar' },
    el('kbd', {}, 'Espace'), ' lecture/pause · ', el('kbd', {}, 'N'), ' pas · ', el('kbd', {}, 'R'), ' réinitialiser · ',
    el('kbd', {}, '1'), '–', el('kbd', {}, '9'), ' calques · ', el('kbd', {}, '+'), '/', el('kbd', {}, '−'), ' vitesse · clic : sélectionner un joueur',
  ));

  // Clavier
  window.addEventListener('keydown', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
    switch (ev.key) {
      case ' ': ev.preventDefault(); app.toggle(); break;
      case 'n': case 'N': app.step(); break;
      case 'r': case 'R': app.reset(); break;
      case '+': case '=': app.speedUp(); break;
      case '-': case '_': app.speedDown(); break;
      case 'Escape': app.selectPlayer(null); break;
      default: {
        const n = Number(ev.key);
        if (n >= 1 && n <= OVERLAY_IDS.length) app.toggleOverlay(OVERLAY_IDS[n - 1]);
      }
    }
  });

  // Boucle : simulation à pas fixe, canvas à chaque image, DOM ~10 Hz
  let last = performance.now();
  let pendingDom = false;
  let lastDom = 0;
  const frame = (now: number): void => {
    const dt = Math.min(0.5, (now - last) / 1000);
    last = now;
    if (app.update(dt)) pendingDom = true;
    view.render(now / 1000);
    if (pendingDom && now - lastDom > 100) {
      pendingDom = false;
      lastDom = now;
      app.emit('sim');
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

boot();
