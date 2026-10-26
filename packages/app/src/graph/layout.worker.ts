import { createLayout, type ToLayout } from "./layoutEngine";

// Module worker: typed by hand because the DOM lib's postMessage is Window's, not a worker's.
const scope = self as unknown as {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToLayout>) => void) | null;
};
// ~60 frames a second: one tick per frame (a slow tick on a huge graph just makes frames rarer).
const layout = createLayout((m, transfer) => scope.postMessage(m, transfer), (fn) => setTimeout(fn, 16));
scope.onmessage = (e) => layout.handle(e.data);
