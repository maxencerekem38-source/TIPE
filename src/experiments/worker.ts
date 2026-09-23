/**
 * Point d'entrée des worker_threads : exécute les tâches nommées (`match`, `scenario`) et renvoie un
 * résultat sérialisable. Répond « pong » au « ping » de sondage du pool.
 *
 * Ce fichier peut être chargé par Node avec son retrait natif des types (Node ≥ 22.18) : il enregistre
 * donc lui-même le chargeur tsx (imports sans extension, alias) avant d'importer le reste du code.
 * Toute erreur d'initialisation fait échouer le sondage, et le pool se replie en séquentiel.
 */
import { parentPort } from 'node:worker_threads';

type TaskRegistry = Record<string, (payload: unknown) => unknown>;

async function loadTasks(): Promise<TaskRegistry> {
  try {
    const api = await import('tsx/esm/api');
    api.register();
  } catch {
    // tsx absent : on tente l'import direct (chargeur déjà actif ou extensions explicites).
  }
  const mod = (await import('./worker-tasks')) as { WORKER_TASKS: TaskRegistry };
  return mod.WORKER_TASKS;
}

const tasksPromise = loadTasks();

if (parentPort) {
  const port = parentPort;
  port.on('message', (m: { type?: string; name?: string; index?: number; payload?: unknown }) => {
    if (!m) return;
    if (m.type === 'ping') {
      tasksPromise.then(() => port.postMessage({ type: 'pong' })).catch((err) => { throw err instanceof Error ? err : new Error(String(err)); });
      return;
    }
    if (m.type === 'task') {
      tasksPromise.then((tasks) => {
        const fn = tasks[m.name ?? ''];
        if (!fn) { port.postMessage({ type: 'result', index: m.index, ok: false, error: `tâche inconnue : ${m.name}` }); return; }
        try {
          port.postMessage({ type: 'result', index: m.index, ok: true, result: fn(m.payload) });
        } catch (err) {
          port.postMessage({ type: 'result', index: m.index, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }).catch((err) => port.postMessage({ type: 'result', index: m.index, ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
  });
}
