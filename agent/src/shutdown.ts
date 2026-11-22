import type { RunningServer } from "./server";
import type { UsageRecorder } from "./usage";

type Shutdown = {
  server: RunningServer;
  usage: UsageRecorder;
  exit: (code: number) => void;
};

/**
 * On SIGINT or SIGTERM (Cloud Run's shutdown), writes the pending usage
 * batch, closes the server, writes what arrived while it closed, then exits.
 */
export function closeOnSignals(
  signals: Pick<NodeJS.EventEmitter, "once">,
  { server, usage, exit }: Shutdown,
): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    signals.once(signal, () => {
      // The batch first, in case closing outlasts Cloud Run's shutdown grace.
      void usage
        .flush()
        .then(() => server.close())
        .then(() => usage.close())
        .then(() => exit(0));
    });
  }
}
