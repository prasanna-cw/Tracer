const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** `a.b(x).c(y)` -> `a.b.c`; `new Order(a, b)` -> `new Order`: the callee as a dotted path, arguments and blocks removed. */
export function cleanCallee(text: string): string {
  let depth = 0;
  let out = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return clip(
    out
      .replace(/\s+/g, " ")
      .replace(/\s*(\.|::|->)\s*/g, "$1")
      .replace(/[;,]+$/, "")
      .trim(),
    80,
  );
}
