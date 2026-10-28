export type AdrInfo = { number?: number; title: string; status?: string; date?: string };

const HEADING = /^#\s+(?:(\d+)\.\s*)?(.+?)\s*$/;
const FIELD = /^(status|date)\s*:\s*(.+?)\s*$/i;

/**
 * Reads the standard ADR heading (`# 0001. Title`, or just `# Title`) and the `Status:`/`Date:` lines
 * Michael Nygard's format (and `adr-tools`) use. Lenient: a file missing a number or a field still parses,
 * since this is a plain Markdown file a person can edit by hand, not a format Tracer enforces.
 */
export function parseAdr(text: string): AdrInfo | undefined {
  let title: string | undefined;
  let number: number | undefined;
  let status: string | undefined;
  let date: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (title === undefined) {
      const h = HEADING.exec(line);
      if (h) {
        title = h[2];
        number = h[1] ? Number(h[1]) : undefined;
      }
      continue;
    }
    const f = FIELD.exec(line);
    if (f) {
      if ((f[1] as string).toLowerCase() === "status") status = f[2];
      else date = f[2];
    } else if (line.trim() && line.trim().startsWith("#")) {
      break; // reached the first body section (## Context, …): no more front fields to read
    }
  }
  return title ? { number, title, status, date } : undefined;
}

const SLUG_STRIP = /[^a-z0-9]+/g;

/** "Use a message queue!" -> "use-a-message-queue" */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(SLUG_STRIP, "-")
    .replace(/^-+|-+$/g, "");
}

const NUMBERED = /^(\d+)-/;

/** The next ADR number: one past the highest `NNNN-` prefix among existing filenames, or 1 if there are none. */
export function nextAdrNumber(existingFilenames: readonly string[]): number {
  const numbers = existingFilenames.flatMap((f) => {
    const m = NUMBERED.exec(f);
    return m ? [Number(m[1])] : [];
  });
  return (numbers.length ? Math.max(...numbers) : 0) + 1;
}

/** `docs/adr/<NNNN>-<slug>.md`, zero-padded to 4 digits. */
export function adrFilename(number: number, title: string): string {
  return `${String(number).padStart(4, "0")}-${slugify(title)}.md`;
}

/** The standard ADR body (Nygard format): a numbered heading, status/date fields, then the three sections. */
export function adrTemplate(number: number, title: string, date: string): string {
  return `# ${String(number).padStart(4, "0")}. ${title}

Status: Proposed
Date: ${date}

## Context

What is the issue we're seeing that motivates this decision?

## Decision

What is the change we're making, and why this option over the alternatives?

## Consequences

What becomes easier or harder as a result of this change?
`;
}
