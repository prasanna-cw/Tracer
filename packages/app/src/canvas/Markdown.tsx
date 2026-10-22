import { Fragment, memo, type ReactNode } from "react";

// ponytail: a deliberate markdown subset (paragraphs, ## headings, - lists, `code`, **bold**, *italic*).
// Builds React elements, so no HTML injection. Swap for a real parser (e.g. micromark) if diagrams need links/tables.
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;

function inline(s: string): ReactNode[] {
  return s.split(INLINE).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 3) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*") && part.length > 1) return <em key={i}>{part.slice(1, -1)}</em>;
    return part;
  });
}

const withBreaks = (s: string): ReactNode[] =>
  s.split("\n").map((line, i) => (
    <Fragment key={i}>
      {i > 0 && <br />}
      {inline(line)}
    </Fragment>
  ));

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n\s*\n/).filter((b) => b.trim());
  return (
    <>
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^[-*+] /.test(l))) {
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.slice(2))}</li>
              ))}
            </ul>
          );
        }
        // A heading may be followed by text on the next line (Obsidian writes "## Title\nBody").
        const heading = /^#{1,6} (.*)$/.exec(lines[0] ?? "");
        if (heading) {
          const rest = lines.slice(1).join("\n");
          return (
            <Fragment key={i}>
              <h4>{inline(heading[1] ?? "")}</h4>
              {rest && <p>{withBreaks(rest)}</p>}
            </Fragment>
          );
        }
        return <p key={i}>{withBreaks(b)}</p>;
      })}
    </>
  );
});
