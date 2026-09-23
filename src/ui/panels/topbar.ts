/**
 * Barre supérieure : titre, transport (lecture/pause, pas, réinitialisation), vitesse,
 * chrono, score, phases, indicateur FPS/latence et badge du mode démo.
 */
import { SPEEDS, type AppState } from '../app';
import { el } from '../dom';
import { fmtClock, fmtMs, PHASE_LABELS } from '../format';

export function createTopbar(app: AppState, onToggleSidebar: () => void): HTMLElement {
  const playBtn = el('button', { class: 'btn btn-primary', title: 'Lecture / pause (Espace)', onClick: () => app.toggle() }, '▶ Lecture');
  const stepBtn = el('button', { class: 'btn', title: 'Avancer d’un cycle de décision (N)', onClick: () => app.step() }, '⏭ Pas');
  const resetBtn = el('button', { class: 'btn', title: 'Réinitialiser (R)', onClick: () => app.reset() }, '↺ Réinitialiser');
  const speedBtns = SPEEDS.map((s) =>
    el('button', { class: 'seg-btn', 'data-speed': s, title: `Vitesse ×${s}`, onClick: () => app.setSpeed(s) }, `×${String(s).replace('.', ',')}`),
  );
  const speed = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Vitesse' }, ...speedBtns);
  const clock = el('span', { class: 'clock', text: '00:00' });
  const scoreA = el('span', { class: 'score-team team-a', text: 'A' });
  const scoreB = el('span', { class: 'score-team team-b', text: 'B' });
  const scoreVal = el('span', { class: 'score-value', text: '0 – 0' });
  const phaseA = el('span', { class: 'phase-badge team-a', text: '' });
  const phaseB = el('span', { class: 'phase-badge team-b', text: '' });
  const perf = el('span', { class: 'perf', title: 'Images par seconde · latence moyenne de décision' }, '— fps');
  const demo = el('span', { class: 'demo-badge', text: 'MODE DÉMO (moteur non chargé)', style: 'display:none' });
  const toggleBtn = el('button', { class: 'btn btn-icon', title: 'Afficher / masquer le panneau latéral', onClick: onToggleSidebar }, '☰');

  const root = el('header', { class: 'topbar' },
    el('div', { class: 'topbar-left' },
      el('h1', { class: 'title' }, el('span', { class: 'title-icon', 'aria-hidden': 'true' }, '⚽'), 'Décision tactique — Simulation football'),
      demo,
    ),
    el('div', { class: 'topbar-center' },
      el('div', { class: 'transport' }, playBtn, stepBtn, resetBtn),
      speed,
      el('div', { class: 'scoreboard' },
        el('span', { class: 'phase-wrap' }, phaseA),
        scoreA, scoreVal, scoreB,
        el('span', { class: 'phase-wrap' }, phaseB),
      ),
      clock,
    ),
    el('div', { class: 'topbar-right' }, perf, toggleBtn),
  );

  const refresh = (): void => {
    const st = app.state;
    playBtn.textContent = app.running ? '⏸ Pause' : '▶ Lecture';
    playBtn.classList.toggle('active', app.running);
    for (const b of speedBtns) b.classList.toggle('active', Number(b.dataset.speed) === app.speed);
    clock.textContent = fmtClock(st.time);
    scoreVal.textContent = `${st.score.A} – ${st.score.B}`;
    phaseA.textContent = PHASE_LABELS[st.phase.A];
    phaseB.textContent = PHASE_LABELS[st.phase.B];
    phaseA.dataset.phase = st.phase.A;
    phaseB.dataset.phase = st.phase.B;
    perf.textContent = `${Math.round(app.fps)} fps · ${fmtMs(app.decisionLatencyMs)}`;
    demo.style.display = app.demoMode ? '' : 'none';
  };
  app.on('ui', refresh);
  app.on('sim', refresh);
  refresh();
  return root;
}
