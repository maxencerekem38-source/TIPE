/**
 * Captures d'écran automatisées de l'interface (Playwright + serveur Vite).
 * Sortie : results/screenshots/ui-*.png (fenêtre 1600×1000) et ui-1280-*.png (fenêtre 1280×800).
 * Chaque capture vérifie l'absence de débordement horizontal des panneaux (texte coupé, colonnes trop étroites).
 */
import { chromium, type Page } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve('results/screenshots');
const PORT = 5199;
const VIEWPORTS = [
  { width: 1600, height: 1000, prefix: 'ui' },
  { width: 1280, height: 800, prefix: 'ui-1280' },
];

/** Sélectionne un coéquipier sans ballon du porteur (de préférence en mouvement : appel, soutien…). */
const SELECT_OFFBALL = `(() => {
  const a = window.__app; const st = a.state; const o = st.ball.ownerId;
  const team = o !== null ? st.players[o].team : (st.possession ?? 'A');
  const mates = st.players.filter((p) => p.team === team && p.id !== o && p.role !== 'GK');
  const moving = mates.filter((p) => { const d = a.sim.decisions.get(p.id); const act = d && d.chosen.action; return act && act.type === 'move' && act.intent !== 'hold_shape'; });
  const pick = moving[0] ?? mates[0];
  if (pick) a.selectPlayer(pick.id);
})()`;

async function captureAll(page: Page, prefix: string, full: boolean): Promise<void> {
  const shot = async (name: string): Promise<void> => {
    await page.screenshot({ path: resolve(OUT, `${prefix}-${name}.png`) });
    // Vérification de débordement horizontal (barre haute, panneau latéral, blocs du panneau de décision, tableaux)
    const overflow = await page.evaluate(() => {
      const out: string[] = [];
      const sels = ['.topbar', '.topbar-center', '.sidebar-content', '.panel', '.optimal', '.cand-head', '.breakdown', '.comp-row', '.ctx-item', '.stats-table', '.scenario', '.slider-row', '.layer-row'];
      for (const sel of sels) {
        for (const e of Array.from(document.querySelectorAll(sel)) as HTMLElement[]) {
          if (e.scrollWidth > e.clientWidth + 1) { out.push(`${sel} : ${e.scrollWidth} > ${e.clientWidth}`); break; }
        }
      }
      return out;
    });
    const time = await page.evaluate(() => (window as any).__app.state.time as number);
    console.log(`capture : results/screenshots/${prefix}-${name}.png (t = ${time.toFixed(1)} s)${overflow.length ? ' DÉBORDEMENT : ' + overflow.join(', ') : ''}`);
  };
  const call = (js: string) => page.evaluate(js);

  // 1. Vue par défaut après 2 s de lecture
  await call(`(() => { const a = window.__app; a.reset(); a.togglePresentation(false); a.selectPlayer(null); window.__showTab('decision'); })()`);
  await page.keyboard.press('Space');
  await page.waitForTimeout(2000);
  await page.keyboard.press('Space');
  await page.waitForTimeout(250);
  await shot('default');

  if (full) {
    // 2. Cartes de chaleur : menace, pression (une capture chacune) + espaces + déplacements + affectations + étiquettes
    await call(`(() => { const a = window.__app; a.toggleOverlay('threat', true); a.toggleOverlay('spaces', true); a.toggleOverlay('moves', true); a.toggleOverlay('labels', true); })()`);
    await page.waitForTimeout(200);
    await shot('layers-threat');
    await call(`(() => { const a = window.__app; a.toggleOverlay('pressure', true); a.toggleOverlay('defence', true); a.toggleOverlay('moves', false); window.__showTab('layers'); })()`);
    await page.waitForTimeout(200);
    await shot('layers-pressure');
    await call(`(() => { const a = window.__app; a.toggleOverlay('control', true); a.toggleOverlay('defence', false); a.toggleOverlay('labels', false); a.toggleOverlay('spaces', false); })()`);
  }

  // 3. Panneau de décision (porteur) avec un candidat développé et survolé
  await call(`window.__showTab('decision')`);
  await page.waitForTimeout(200);
  const heads = page.locator('.cand-head');
  if ((await heads.count()) > 1) { await heads.nth(1).click(); await heads.nth(1).hover(); }
  await page.waitForTimeout(250);
  await shot('decision');

  // 3 bis. Panneau de décision d'un joueur sans ballon (intention, candidats de déplacement, décomposition de l'utilité)
  await call(`(() => { const a = window.__app; a.toggleOverlay('moves', true); })()`);
  await call(SELECT_OFFBALL);
  await page.waitForTimeout(200);
  const heads2 = page.locator('.cand-head');
  if ((await heads2.count()) > 0) { await heads2.nth(0).click(); await heads2.nth(0).hover(); }
  await page.waitForTimeout(250);
  await shot('decision-offball');
  await call(`(() => { const a = window.__app; a.selectPlayer(null); a.toggleOverlay('moves', false); })()`);

  // 4. Tactiques, scénarios
  if (full) {
    await call(`window.__showTab('tactics')`);
    await page.waitForTimeout(200);
    await shot('tactics');
  }
  await call(`window.__showTab('scenarios')`);
  await page.waitForTimeout(200);
  await shot('scenarios');

  if (full) {
    // 5. Statistiques (après un peu plus de jeu à vitesse ×4)
    await call(`(() => { const a = window.__app; a.setSpeed(4); a.play(); })()`);
    await page.waitForTimeout(3000);
    await call(`(() => { const a = window.__app; a.pause(); a.setSpeed(1); window.__showTab('stats'); })()`);
    await page.waitForTimeout(300);
    await shot('stats');

    // 6. Paramètres et journal
    await call(`window.__showTab('params')`);
    await page.waitForTimeout(200);
    await shot('params');
    await call(`window.__showTab('log')`);
    await page.waitForTimeout(200);
    await shot('log');
  }

  // 7. Mode présentation (aide clavier masquée, panneau resserré, terrain agrandi)
  await call(`(() => { const a = window.__app; window.__showTab('decision'); a.togglePresentation(true); })()`);
  await page.waitForTimeout(300);
  await shot('presentation');
  await call(`(() => { window.__app.togglePresentation(false); })()`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  // HMR et surveillance désactivés : d'autres fichiers du dépôt peuvent changer pendant la capture.
  const server = await createServer({
    configFile: resolve('vite.config.ts'),
    server: { port: PORT, strictPort: true, host: '127.0.0.1', hmr: false, watch: null },
    logLevel: 'error',
  });
  await server.listen();
  const url = `http://127.0.0.1:${PORT}/`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: VIEWPORTS[0].width, height: VIEWPORTS[0].height }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas.pitch-canvas');
  await page.waitForFunction(() => (window as any).__app !== undefined);

  for (const [i, vp] of VIEWPORTS.entries()) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(300);
    await captureAll(page, vp.prefix, i === 0);
  }

  await browser.close();
  await server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
