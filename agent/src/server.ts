import { serve } from "@hono/node-server";
import type { Hono } from "hono";

export type RunningServer = { url: string; close(): Promise<void> };

/** Serves `app` on `port` (0 picks a free one). */
export function listen(
  app: Hono,
  port: number,
  hostname = "0.0.0.0",
): Promise<RunningServer> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
      resolve({
        url: `http://127.0.0.1:${info.port}`,
        close: () =>
          new Promise<void>((done, fail) =>
            server.close((error) => (error ? fail(error) : done())),
          ),
      });
    });
  });
}
