/**
 * Barre supérieure : titre, transport (lecture/pause, pas, réinitialisation), vitesse,
 * chrono, score, phases, indicateur FPS/latence et badge du mode démo.
 */
import { SPEEDS, type AppState } from '../app';
import { el } from '../dom';
import { fmtClock, fmtMs, PHASE_LABELS } from '../format';

export function createTopbar(app: AppState, onToggleSidebar: () => void): HTMLElement {
  const playIcon = el('span', { class: 'btn-icon-glyph', text: '▶' });
  const playLabel = el('span', { class: 'btn-label', text: 'Lecture' });
  const playBtn = el('button', { class: 'btn btn-primary', title: 'Lecture / pause (Espace)', onClick: () => app.toggle() }, playIcon, playLabel);
  const stepBtn = el('button', { class: 'btn', title: 'Avancer d’un cycle de décision (N)', onClick: () => app.step() }, el('span', { class: 'btn-icon-glyph', text: '⏭' }), el('span', { class: 'btn-label', text: 'Pas' }));
  const resetBtn = el('button', { class: 'btn', title: 'Réinitialiser (R)', onClick: () => app.reset() }, el('span', { class: 'btn-icon-glyph', text: '↺' }), el('span', { class: 'btn-label', text: 'Réinitialiser' }));
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
  const demo = el('span', { class: 'demo-badge', title: 'Mode démo : le moteur de simulation n’est pas chargé, une simulation factice anime l’interface.', style: 'display:none' },
    'MODE DÉMO', el('span', { class: 'demo-long', text: ' (moteur non chargé)' }));
  const toggleBtn = el('button', { class: 'btn btn-icon', title: 'Afficher / masquer le panneau latéral', onClick: onToggleSidebar }, '☰');

  const root = el('header', { class: 'topbar' },
    el('div', { class: 'topbar-left' },
      el('h1', { class: 'title', title: 'Décision tactique — Simulation football' }, el('span', { class: 'title-icon', 'aria-hidden': 'true' }, '⚽'), 'Décision tactique', el('span', { class: 'title-sub' }, ' — Simulation football')),
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
    playIcon.textContent = app.running ? '⏸' : '▶';
    playLabel.textContent = app.running ? 'Pause' : 'Lecture';
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
