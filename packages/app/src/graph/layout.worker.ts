import { createLayout, type ToLayout } from "./layoutEngine";

// Module worker: typed by hand because the DOM lib's postMessage is Window's, not a worker's.
const scope = self as unknown as {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToLayout>) => void) | null;
};
const layout = createLayout((m, transfer) => scope.postMessage(m, transfer), (fn) => setTimeout(fn, 0));
scope.onmessage = (e) => layout.handle(e.data);
