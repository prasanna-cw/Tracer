import type { ButtonHTMLAttributes } from "react";

/** A VS Code codicon (bundled font, no network). */
export const Icon = ({ name }: { name: string }) => <span className={`codicon codicon-${name}`} aria-hidden="true" />;

/** Square icon button; `label` is both the tooltip and the accessible name. */
export function IconButton({ icon, label, badge, ...rest }: { icon: string; label: string; badge?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className="icon-btn" title={label} aria-label={label} {...rest}>
      <Icon name={icon} />
      {badge && <span className="badge" aria-hidden="true" />}
    </button>
  );
}

/** The Tracer mark: a path traced through three nodes. */
export const TracerMark = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="5" cy="6" r="2.5" />
    <circle cx="19" cy="12" r="2.5" />
    <circle cx="7" cy="19" r="2.5" />
    <path d="M7.4 6.6 16.6 11M16.7 13.2 9.3 17.8" />
  </svg>
);
