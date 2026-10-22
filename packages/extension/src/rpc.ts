import { errorResponse, hostEvent, okResponse, parseToHost, type HostEvent, type Method, type Params, type Result } from "@codemap/core";

/** One async handler per protocol method. Throwing becomes an error response for that request. */
export type Handlers = { [M in Method]: (params: Params<M>) => Promise<Result<M>> };

/** The slice of vscode.Webview the server needs (kept minimal so it is testable without VS Code). */
export type Channel = {
  onDidReceiveMessage(listener: (message: unknown) => unknown): { dispose(): unknown };
  postMessage(message: unknown): PromiseLike<boolean>;
};

/**
 * Serves protocol requests from a webview. Every incoming message is validated before a handler sees it;
 * every outgoing response and event is validated before it is posted (okResponse/hostEvent throw on bugs).
 */
export function serve(channel: Channel, handlers: Handlers, log: (message: string) => void) {
  const subscription = channel.onDidReceiveMessage(async (raw) => {
    const r = parseToHost(raw);
    if (!r.ok) {
      log(`Rejected a message from the webview: ${r.errors.join("; ")}`);
      const id = (raw as { id?: unknown } | null)?.id;
      if (typeof id === "number" && Number.isInteger(id) && id >= 0) {
        void channel.postMessage(errorResponse(id, `invalid request: ${r.errors.join("; ")}`));
      }
      return;
    }
    const req = r.value;
    try {
      const handler = handlers[req.method] as (params: unknown) => Promise<unknown>;
      const result = await handler(req.params);
      void channel.postMessage(okResponse(req.id, req.method, result as Result<typeof req.method>));
    } catch (e) {
      void channel.postMessage(errorResponse(req.id, e instanceof Error ? e.message : String(e)));
    }
  });
  return {
    emit: (event: HostEvent): void => void channel.postMessage(hostEvent(event)),
    dispose: (): void => void subscription.dispose(),
  };
}
