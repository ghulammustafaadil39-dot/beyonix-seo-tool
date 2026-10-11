import type { EventEmitter } from 'node:events';

/**
 * Graceful shutdown for API + worker (C-03 / N-A2-1).
 *
 * SIGTERM/SIGINT no longer kill in-flight work: the handler runs the
 * registered cleanup steps (BullMQ worker.close() drains in-flight jobs and
 * lets them finish; Fastify app.close() drains in-flight requests), then
 * exits. A second signal forces an immediate exit.
 */
export interface ShutdownStep {
  name: string;
  run: () => Promise<void>;
}

export function installGracefulShutdown(
  steps: ShutdownStep[],
  opts: { signals?: NodeJS.Signals[]; emitter?: EventEmitter; exit?: (code: number) => void } = {},
): () => Promise<void> {
  const signals = opts.signals ?? ['SIGTERM', 'SIGINT'];
  const emitter = (opts.emitter ?? process) as EventEmitter;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      console.error(`[shutdown] ${signal} during shutdown — forcing exit`);
      exit(1);
      return;
    }
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received — draining in-flight work`);
    for (const step of steps) {
      try {
        await step.run();
        console.log(`[shutdown] step ok: ${step.name}`);
      } catch (err) {
        console.error(`[shutdown] step failed: ${step.name}`, err);
      }
    }
    console.log('[shutdown] clean — exiting');
    exit(0);
  };

  for (const sig of signals) {
    emitter.on(sig, () => void shutdown(sig));
  }
  return () => shutdown('manual');
}

export const isShuttingDown = (() => {
  let flag = false;
  return {
    get: () => flag,
    set: () => {
      flag = true;
    },
  };
})();
