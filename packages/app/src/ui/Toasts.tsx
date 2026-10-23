import { useCallback, useState } from "react";
import { Icon, IconButton } from "./Icon";

type Toast = { id: number; message: string };
let nextId = 1;

export function useToasts(): [Toast[], (message: string) => void, (id: number) => void] {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (message: string) => {
      const id = nextId++;
      setToasts((ts) => [...ts.slice(-4), { id, message }]);
      setTimeout(() => dismiss(id), 6000);
    },
    [dismiss],
  );
  return [toasts, push, dismiss];
}

export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <Icon name="info" />
          <span className="msg">{t.message}</span>
          <IconButton icon="close" label="Dismiss" onClick={() => dismiss(t.id)} />
        </div>
      ))}
    </div>
  );
}
