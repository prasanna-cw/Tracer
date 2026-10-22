import type { Diagram, DiagramNode } from "@codemap/core";

/** Undoable diagram state. Every committed change is one undo step (a whole drag, a whole text edit). */
export type History = {
  past: Diagram[];
  present: Diagram;
  future: Diagram[];
  saved: Diagram; // dirty <=> present !== saved (reference equality; every change creates a new object)
};

export type HistoryAction =
  | { type: "load"; diagram: Diagram }
  | { type: "move"; moves: { id: string; x: number; y: number }[] }
  | { type: "edit"; id: string; patch: Partial<DiagramNode> }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "saved"; diagram: Diagram };

const LIMIT = 200;

export const initHistory = (diagram: Diagram): History => ({ past: [], present: diagram, future: [], saved: diagram });

function commit(h: History, next: Diagram): History {
  return { ...h, past: [...h.past, h.present].slice(-LIMIT), present: next, future: [] };
}

function updateNodes(d: Diagram, update: (n: DiagramNode) => DiagramNode): Diagram | undefined {
  let changed = false;
  const nodes = d.nodes.map((n) => {
    const u = update(n);
    if (u !== n) changed = true;
    return u;
  });
  return changed ? { ...d, nodes } : undefined;
}

export function historyReducer(h: History, a: HistoryAction): History {
  switch (a.type) {
    case "load":
      return initHistory(a.diagram);
    case "move": {
      const byId = new Map(a.moves.map((m) => [m.id, m]));
      const next = updateNodes(h.present, (n) => {
        const m = byId.get(n.id);
        return m && (m.x !== n.x || m.y !== n.y) ? { ...n, x: m.x, y: m.y } : n;
      });
      return next ? commit(h, next) : h;
    }
    case "edit": {
      const next = updateNodes(h.present, (n) => {
        if (n.id !== a.id) return n;
        const changed = Object.entries(a.patch).some(([k, v]) => n[k] !== v);
        return changed ? { ...n, ...a.patch } : n;
      });
      return next ? commit(h, next) : h;
    }
    case "undo": {
      const prev = h.past.at(-1);
      return prev ? { ...h, past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] } : h;
    }
    case "redo": {
      const [next, ...rest] = h.future;
      return next ? { ...h, past: [...h.past, h.present], present: next, future: rest } : h;
    }
    case "saved":
      return { ...h, saved: a.diagram };
  }
}
