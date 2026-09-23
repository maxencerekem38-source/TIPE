/**
 * Parallélisme optionnel par worker_threads (os.cpus().length − 1 workers) pour les lots de matchs.
 * Les tâches doivent être sérialisables (structured clone) et désignées par un nom de tâche connu du worker
 * (`worker.ts`). En cas d'échec des workers (chargeur TypeScript absent, erreur d'initialisation…),
 * l'exécution se replie SANS ERREUR sur la fonction séquentielle `fn`.
 */
import os from 'node:os';

export interface BatchOptions {
  /** Force l'exécution séquentielle (drapeau --sequential ou variable TIPE_SEQUENTIAL=1). */
  sequential?: boolean;
  /** Nombre de workers (défaut : cpus − 1, au moins 1). */
  workers?: number;
  /** Nom de la tâche exécutée par le worker (`match`, `scenario`…). Sans nom : séquentiel. */
  workerTask?: string;
  onProgress?: (done: number, total: number) => void;
  /** Délai (ms) accordé à un worker pour répondre au « ping » initial. */
  probeTimeoutMs?: number;
}

export const defaultWorkerCount = (): number => Math.max(1, (os.cpus()?.length ?? 2) - 1);

export const isSequentialEnv = (): boolean => process.env.TIPE_SEQUENTIAL === '1' || process.env.TIPE_SEQUENTIAL === 'true';

/** Force l'exécution séquentielle pour tout le processus (drapeau CLI). */
export const setSequential = (value: boolean): void => { process.env.TIPE_SEQUENTIAL = value ? '1' : '0'; };

/** Statut du dernier lot (pour les journaux). */
export const lastBatchInfo = { mode: 'sequential' as 'sequential' | 'workers', workers: 0, fallbackReason: '' };

interface WorkerLike {
  postMessage(msg: unknown): void;
  on(event: 'message' | 'error' | 'exit', cb: (arg: any) => void): void;
  terminate(): Promise<number> | void;
}

async function spawnWorker(probeTimeoutMs: number): Promise<WorkerLike> {
  const { Worker } = await import('node:worker_threads');
  const url = new URL('./worker.ts', import.meta.url);
  const worker = new Worker(url, { execArgv: ['--import', 'tsx'] }) as unknown as WorkerLike;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker : pas de réponse au ping')), probeTimeoutMs);
    worker.on('message', (m: any) => { if (m && m.type === 'pong') { clearTimeout(timer); resolve(); } });
    worker.on('error', (e: any) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); });
    worker.on('exit', (code: number) => { clearTimeout(timer); reject(new Error(`worker terminé (code ${code})`)); });
    worker.postMessage({ type: 'ping' });
  });
  return worker;
}

/**
 * Exécute `tasks` ; en parallèle via workers si `workerTask` est fourni et que les workers démarrent,
 * sinon séquentiellement avec `fn`. Les résultats sont renvoyés dans l'ordre des tâches.
 */
export async function runBatch<T, R>(tasks: readonly T[], fn: (task: T) => R | Promise<R>, options: BatchOptions = {}): Promise<R[]> {
  const total = tasks.length;
  const results = new Array<R>(total);
  const sequentialRun = async (indices: number[]): Promise<void> => {
    for (const i of indices) {
      results[i] = await fn(tasks[i]);
      options.onProgress?.(indices.indexOf(i) + 1, total);
    }
  };
  const sequential = options.sequential ?? isSequentialEnv();
  const workerCount = Math.min(options.workers ?? defaultWorkerCount(), total);
  if (sequential || !options.workerTask || workerCount < 1 || total < 2) {
    lastBatchInfo.mode = 'sequential'; lastBatchInfo.workers = 0; lastBatchInfo.fallbackReason = sequential ? 'séquentiel demandé' : '';
    await sequentialRun(tasks.map((_, i) => i));
    return results;
  }

  const probeTimeoutMs = options.probeTimeoutMs ?? 15000;
  const workers: WorkerLike[] = [];
  try {
    const first = await spawnWorker(probeTimeoutMs);
    workers.push(first);
    const rest = await Promise.allSettled(Array.from({ length: workerCount - 1 }, () => spawnWorker(probeTimeoutMs)));
    for (const r of rest) if (r.status === 'fulfilled') workers.push(r.value);
  } catch (err) {
    for (const w of workers) void w.terminate();
    lastBatchInfo.mode = 'sequential'; lastBatchInfo.workers = 0;
    lastBatchInfo.fallbackReason = `workers indisponibles (${err instanceof Error ? err.message : String(err)})`;
    await sequentialRun(tasks.map((_, i) => i));
    return results;
  }

  lastBatchInfo.mode = 'workers'; lastBatchInfo.workers = workers.length; lastBatchInfo.fallbackReason = '';
  const pending = tasks.map((_, i) => i);
  const failed: number[] = [];
  let done = 0;
  let workerFailure: Error | null = null;

  const runOn = (worker: WorkerLike): Promise<void> => new Promise<void>((resolve) => {
    let current = -1;
    const next = (): void => {
      if (workerFailure || pending.length === 0) { resolve(); return; }
      current = pending.shift()!;
      worker.postMessage({ type: 'task', name: options.workerTask, index: current, payload: tasks[current] });
    };
    worker.on('message', (m: any) => {
      if (!m || m.type !== 'result' || m.index !== current) return;
      if (m.ok) { results[current] = m.result as R; done++; options.onProgress?.(done, total); }
      else { workerFailure = new Error(m.error ?? 'erreur worker'); failed.push(current); }
      next();
    });
    worker.on('error', (e: any) => { workerFailure = e instanceof Error ? e : new Error(String(e)); if (current >= 0) failed.push(current); resolve(); });
    worker.on('exit', () => { if (current >= 0 && results[current] === undefined && !failed.includes(current)) failed.push(current); resolve(); });
    next();
  });

  await Promise.all(workers.map(runOn));
  for (const w of workers) void w.terminate();

  // Repli séquentiel pour tout ce qui n'a pas abouti.
  const remaining = [...failed, ...pending].filter((i) => results[i] === undefined);
  if (remaining.length) {
    lastBatchInfo.fallbackReason = `repli séquentiel pour ${remaining.length} tâche(s)` + (workerFailure ? ` : ${(workerFailure as Error).message}` : '');
    await sequentialRun(remaining);
  }
  return results;
}
