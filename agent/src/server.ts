import { createServer, type IncomingMessage } from "node:http";
import { getRequestListener, type HttpBindings } from "@hono/node-server";
import type { Hono } from "hono";

export type RunningServer = { url: string; close(): Promise<void> };

/**
 * Serves `app` on `port` (0 picks a free one). Each request gets an execution
 * context: its handler resolves once the response is done and so is the work
 * the app handed to `c.executionCtx.waitUntil`, even if the client left.
 */
export function listen(
  app: Hono,
  port: number,
  hostname = "0.0.0.0",
): Promise<RunningServer> {
  const pendingWork = new WeakMap<IncomingMessage, Promise<unknown>[]>();
  const listener = getRequestListener((request, bindings) => {
    // An HTTP/1 server: the bindings are always Node's request and response.
    const pending = pendingWork.get((bindings as HttpBindings).incoming) ?? [];
    return app.fetch(request, bindings, {
      waitUntil: (work) => void pending.push(work),
      passThroughOnException: () => {},
      props: {},
    });
  });
  const server = createServer(async (incoming, outgoing) => {
    const pending: Promise<unknown>[] = [];
    pendingWork.set(incoming, pending);
    await listener(incoming, outgoing);
    for (let i = 0; i < pending.length; i++) await pending[i].catch(() => {});
  });

  return new Promise((resolve) => {
    server.listen(port, hostname, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${actualPort}`,
        close: () =>
          new Promise<void>((done, fail) =>
            server.close((error) => (error ? fail(error) : done())),
          ),
      });
    });
  });
}
