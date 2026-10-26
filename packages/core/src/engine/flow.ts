import type { Node } from "web-tree-sitter";
import { layoutFlow } from "../layout/flowLayout";
import type { Diagram, DiagramEdge, DiagramNode, Side } from "../schema/diagram";
import { cleanCallee } from "./callee";
import { nameOf } from "./facts";
import type { LanguageSpec } from "./languages";

/** A function the workspace defines, as found by the call resolver. */
export type CallTarget = { path: string; line: number; name: string; container?: string };
export type CallResolver = (callee: string, from: { path: string; container?: string }) => CallTarget | undefined;

export type FlowRequest =
  | { kind: "function"; line: number; column?: number } // 1-based line inside the function; 0-based column (default: first non-blank)
  | { kind: "selection"; startLine: number; endLine: number }; // 1-based, inclusive

export type FlowOutcome = { ok: true; diagram: Diagram; truncated: boolean } | { ok: false; reason: string };

export const NODE_W = 272;
const MAX_NODES = 80;
const MAX_ROWS = 5;

// ---- tree helpers --------------------------------------------------------------------------------------

// Block-like nodes only: `for_statement` etc. must NOT match (they end in "statement" too).
const CONTAINER = /^(block|statements|statement_list|statement_block|compound_statement|body|body_statement|then|else|else_clause|do_block|declaration_list)$|_(block|body)$/;
const STOP = /catch|except|rescue|handler|finally|ensure|finalizer/; // try clauses are never part of a plain body
// switch/match arms: switch_case, case_statement, when_entry, match_arm, expression_case, switch_section, …
// (`when_subject` and `catch_clause` must not match.)
const CASE = /^(case|default|when)$|^(case|default)_|_(case|default|when)$|(arm|entry|section|group|rule)$|case_clause$/;
const COMMENT = /comment/;
const isContainer = (n: Node): boolean => CONTAINER.test(n.type) || n.type === "do_block";
const named = (n: Node): Node[] => n.namedChildren.filter((c): c is Node => !!c && !COMMENT.test(c.type));
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Statements of a body node, with block-like wrappers flattened away (`{ … }`, `then`, `else_clause`, …). */
function statementsOf(n: Node | null | undefined): Node[] {
  if (!n) return [];
  if (!isContainer(n)) return [n];
  return named(n).flatMap((c) => (STOP.test(c.type) ? [] : statementsOf(c)));
}

/** Header of a construct: its text up to where the body starts (`for (int i = 0; i < n; i++)`). */
function headerOf(n: Node, body: Node | null | undefined): string {
  const end = body && body.startIndex > n.startIndex ? body.startIndex - n.startIndex : n.text.indexOf("\n") >= 0 ? n.text.indexOf("\n") : n.text.length;
  return clip(oneLine(n.text.slice(0, end)).replace(/[{:]\s*$/, "").replace(/\s*(do|then)\s*$/, "").trim(), 72);
}

function bodyOf(n: Node): Node | null {
  const field = n.childForFieldName("body") ?? n.childForFieldName("consequence");
  if (field) return field;
  const kids = named(n);
  const last = kids.at(-1);
  return last && isContainer(last) ? last : null;
}

const stmtLabel = (n: Node): string => clip(oneLine(n.text.split("\n")[0] ?? "").replace(/[;{]\s*$/, "").trim(), 80);
const parenless = (s: string): string => s.replace(/^\(\s*/, "").replace(/\s*\)$/, "");

// ---- builder -----------------------------------------------------------------------------------------------

type Exit = { id: string; label?: string; side?: Side };
type Cat = string;
type NodeInit = {
  kind: "start" | "layer" | "note" | "decision" | "end";
  category: Cat;
  title: string;
  subtitle?: string;
  text?: string;
  rows?: { text: string; muted?: boolean }[];
  height: number;
};

class Builder {
  readonly nodes: DiagramNode[] = [];
  readonly edges: DiagramEdge[] = [];
  truncated = false;
  private seq = 0;

  constructor(
    private readonly spec: LanguageSpec,
    private readonly path: string,
    private readonly container: string | undefined,
    private readonly resolve: CallResolver,
  ) {}

  private add(n: NodeInit, line: number | undefined): string {
    const id = `n${++this.seq}`;
    const node: DiagramNode = { id, type: "text", x: 0, y: 0, width: NODE_W, ...n };
    if (line) node.source = { path: this.path, line };
    this.nodes.push(node);
    return id;
  }

  private link(from: readonly Exit[], to: string, extra: Partial<DiagramEdge> = {}): void {
    for (const f of from) {
      const e: DiagramEdge = { id: `e${this.edges.length + 1}`, fromNode: f.id, toNode: to, ...extra };
      if (f.label && !e.label) e.label = f.label;
      if (f.side && !e.fromSide) e.fromSide = f.side;
      this.edges.push(e);
    }
  }

  /** True once the diagram is full: callers stop adding and `finish` appends the notice. */
  full(): boolean {
    if (this.nodes.length >= MAX_NODES) this.truncated = true;
    return this.truncated;
  }

  start(title: string, line: number | undefined, subtitle?: string): Exit[] {
    const id = this.add({ kind: "start", category: "layer", title, subtitle, height: 56 }, line);
    return [{ id }];
  }

  finish(from: readonly Exit[]): void {
    if (!this.truncated || !from.length) return;
    const id = this.add({ kind: "note", category: "note", title: "More steps not shown", text: "Select a smaller range, or open the function, to see the rest.", height: 72 }, undefined);
    this.link(from, id, { style: "dashed" });
  }

  // ---- statements ----------------------------------------------------------------------------------------

  walk(stmts: readonly Node[], from: readonly Exit[]): Exit[] {
    let cur: Exit[] = [...from];
    let pending: Node[] = [];
    const flush = (): void => {
      if (pending.length) cur = this.plain(pending, cur);
      pending = [];
    };
    for (const raw of stmts) {
      if (cur.length === 0) break; // after return/throw nothing is reachable
      if (this.full()) {
        flush();
        break;
      }
      const s = this.unwrap(raw);
      const kind = this.classify(s);
      if (kind === "skip") continue;
      if (kind === "plain") {
        if (this.callsIn(s).length) {
          flush();
          cur = this.plain([s], cur);
        } else pending.push(s);
        continue;
      }
      flush();
      cur = kind === "if" ? this.ifFlow(s, cur) : kind === "loop" ? this.loopFlow(s, cur) : kind === "switch" ? this.switchFlow(s, cur) : kind === "try" ? this.tryFlow(s, cur) : this.endFlow(s, kind, cur);
    }
    flush();
    return cur;
  }

  private unwrap(n: Node): Node {
    let cur = n;
    for (;;) {
      const kids = named(cur);
      const only = kids.length === 1 ? kids[0] : undefined;
      if (!only || this.classify(cur) !== "plain" || this.classify(only) === "plain" || this.spec.functions.includes(cur.type)) return cur;
      cur = only;
    }
  }

  private classify(n: Node): "if" | "loop" | "switch" | "try" | "return" | "throw" | "skip" | "plain" {
    const c = this.spec.control;
    const t = n.type;
    if (c.if.includes(t) || /^(elif|elsif)(_|$)/.test(t)) return "if"; // `elif`/`elsif` chain like a nested if
    if (c.loop.includes(t)) return "loop";
    if (c.switch.includes(t)) return "switch";
    if (c.try.includes(t)) return "try";
    if (c.throw.includes(t)) return "throw";
    if (c.return.includes(t)) {
      // Kotlin/Swift share one node for return/throw/break/continue: read the keyword.
      const word = /^\s*(\w+)/.exec(n.text)?.[1];
      if (word === "throw") return "throw";
      if (word === "break" || word === "continue" || word === "fallthrough") return "skip";
      return "return";
    }
    if (COMMENT.test(t) || /^(break|continue)(_|$)/.test(t)) return "skip";
    // Languages where raising is a function call, not a statement (Ruby `raise`, Go `panic`).
    if (this.spec.calls.includes(t) && /^(raise|panic|fail)$/.test(cleanCallee(n.childForFieldName("method")?.text ?? n.childForFieldName("function")?.text ?? ""))) return "throw";
    return "plain";
  }

  /** Distinct calls made by a statement, outermost first, not descending into nested functions or call callees. */
  private callsIn(n: Node): string[] {
    const calls = new Set(this.spec.calls);
    const fns = new Set(this.spec.functions);
    const out: string[] = [];
    const visit = (x: Node): void => {
      if (fns.has(x.type) && x !== n) return;
      if (calls.has(x.type)) {
        const name = cleanCallee(x.type.includes("creation") || x.type === "new_expression" ? `new ${x.childForFieldName("type")?.text ?? x.text}` : x.text);
        if (name && !out.includes(name)) out.push(name);
        const args = x.childForFieldName("arguments") ?? named(x).find((c) => /argument/.test(c.type));
        for (const c of args ? named(args) : []) visit(c);
        if (!args) for (const c of named(x)) visit(c);
        return;
      }
      for (const c of named(x)) visit(c);
    };
    visit(n);
    return out;
  }

  /** Calls of a statement, the ones that resolve to a definition in the workspace, and the rows describing them. */
  private callInfo(n: Node | undefined): { calls: string[]; resolved: { c: string; t: CallTarget }[]; rows: string[] } {
    const calls = n ? this.callsIn(n) : [];
    const resolved = calls.flatMap((c) => {
      const t = this.resolve(c, { path: this.path, container: this.container });
      return t ? [{ c, t }] : [];
    });
    const rows = [
      ...resolved.map(({ t }) => `→ ${t.container ? `${t.container}.` : ""}${t.name}  ${t.path.slice(t.path.lastIndexOf("/") + 1)}:${t.line}`),
      ...calls.filter((c) => !resolved.some((r) => r.c === c)).map((c) => `${c}()`),
    ].slice(0, MAX_ROWS);
    return { calls, resolved, rows };
  }

  private plain(stmts: readonly Node[], from: readonly Exit[]): Exit[] {
    const first = stmts[0];
    if (!first) return [...from];
    const line = first.startPosition.row + 1;
    const { calls, resolved, rows } = this.callInfo(stmts.length === 1 ? first : undefined);
    const merged = stmts.length > 1;
    const id = this.add(
      {
        kind: merged ? "note" : "layer",
        category: resolved.length ? "service" : calls.length ? "layer" : "note",
        title: merged ? `${stmts.length} statements` : stmtLabel(first),
        subtitle: merged ? stmtLabel(first) : undefined,
        rows: merged ? stmts.slice(0, MAX_ROWS).map((s) => ({ text: stmtLabel(s) })) : rows.map((text) => ({ text })),
        height: 44 + (merged ? 20 : 0) + 18 * (merged ? Math.min(stmts.length, MAX_ROWS) : rows.length),
      },
      line,
    );
    // A resolved call makes the card open the callee's definition; otherwise it opens this statement.
    const node = this.nodes.find((n) => n.id === id);
    if (node && resolved[0]) node.source = { path: resolved[0].t.path, line: resolved[0].t.line };
    this.link(from, id);
    return [{ id }];
  }

  // ---- control flow ----------------------------------------------------------------------------------------

  private decision(title: string, keyword: string, category: Cat, n: Node, from: readonly Exit[]): string {
    const id = this.add({ kind: "decision", category, title, subtitle: keyword, height: 60 }, n.startPosition.row + 1);
    this.link(from, id);
    return id;
  }

  private conditionOf(n: Node): string {
    const cond = n.childForFieldName("condition") ?? named(n)[0];
    return cond ? clip(oneLine(parenless(cond.text)), 72) : headerOf(n, bodyOf(n));
  }

  /** then-statements and else-statements of an if-like node, by field names or by the `else` token. */
  private branches(n: Node): { then: Node[]; else: Node[] | null } {
    const field = n.childForFieldName("consequence") ?? n.childForFieldName("body");
    const alt = n.childForFieldName("alternative");
    if (field || alt) return { then: statementsOf(field), else: alt ? statementsOf(alt) : null };
    // No fields (Kotlin, Swift, …): named children after the condition, split at the `else` token.
    const kids = n.children.filter((c): c is Node => !!c);
    const elseAt = kids.findIndex((c) => c.type === "else");
    const bodies = (list: Node[]) => list.filter((c) => c.isNamed && !COMMENT.test(c.type)).flatMap((c) => statementsOf(c));
    const afterCond = kids.filter((c) => c.isNamed).slice(1);
    if (elseAt < 0) return { then: bodies(afterCond), else: null };
    const cut = kids.slice(0, elseAt).filter((c) => c.isNamed).length;
    return { then: bodies(afterCond.slice(0, Math.max(0, cut - 1))), else: bodies(kids.slice(elseAt + 1)) };
  }

  private ifFlow(n: Node, from: readonly Exit[]): Exit[] {
    const unless = /^\s*unless\b/.test(n.text) || n.type.startsWith("unless");
    const id = this.decision(this.conditionOf(n), "if", "entity", n, from);
    const b = this.branches(n);
    const [yes, no] = unless ? ["no", "yes"] : ["yes", "no"];
    const thenExits = this.walk(b.then, [{ id, label: yes }]);
    const elseExits = b.else ? this.walk(b.else, [{ id, label: no }]) : [{ id, label: no }];
    return [...thenExits, ...elseExits];
  }

  private loopFlow(n: Node, from: readonly Exit[]): Exit[] {
    const body = bodyOf(n);
    const id = this.decision(headerOf(n, body), "loop", "data", n, from);
    const exits = this.walk(statementsOf(body), [{ id, label: "each" }]);
    for (const e of exits) {
      this.edges.push({ id: `e${this.edges.length + 1}`, fromNode: e.id, toNode: id, label: e.label ?? "next", style: "dashed", fromSide: "left", toSide: "left" });
    }
    return [{ id, label: "done" }];
  }

  private caseNodes(n: Node): Node[] {
    const out: Node[] = [];
    const find = (x: Node): void => {
      for (const c of named(x)) {
        if (isContainer(c) || /_(block|body)$/.test(c.type)) find(c); // switch_block, case_block, match_block …
        else if (CASE.test(c.type)) out.push(c);
      }
    };
    find(n);
    return out;
  }

  private caseStatements(c: Node): Node[] {
    const out: Node[] = [];
    for (let i = 0; i < c.childCount; i++) {
      const k = c.child(i);
      if (!k || !k.isNamed || COMMENT.test(k.type)) continue;
      const field = c.fieldNameForChild(i);
      const isLabel = /condition|pattern|label|^case$|^default$|^when_condition$/.test(k.type) || field === "pattern" || field === "label" || field === "condition" || (field === "value" && c.type !== "match_arm");
      if (!isLabel) out.push(...statementsOf(k));
    }
    return out;
  }

  private switchFlow(n: Node, from: readonly Exit[]): Exit[] {
    const cases = this.caseNodes(n);
    if (!cases.length) return this.plain([n], from);
    const subject = n.childForFieldName("condition") ?? n.childForFieldName("value") ?? named(n)[0];
    const id = this.decision(clip(oneLine(parenless(subject && !CASE.test(subject.type) ? subject.text : headerOf(n, null))), 72), "switch", "entity", n, from);
    const exits: Exit[] = [];
    for (const c of cases) {
      const label = clip(oneLine(c.text.split("\n")[0] ?? "").split(/:|=>|->|\{/)[0]?.trim() || "default", 40);
      exits.push(...this.walk(this.caseStatements(c), [{ id, label }]));
      if (this.full()) break;
    }
    return exits;
  }

  private tryFlow(n: Node, from: readonly Exit[]): Exit[] {
    const kids = named(n);
    const handlers = kids.filter((c) => /catch|except|rescue|handler/.test(c.type));
    const fin = kids.find((c) => /finally|ensure|finalizer/.test(c.type));
    const bodyNode = n.childForFieldName("body");
    const bodyStmts = bodyNode ? statementsOf(bodyNode) : kids.filter((c) => !STOP.test(c.type) && !/else/.test(c.type)).flatMap((c) => statementsOf(c));
    if (!handlers.length && !fin) return this.walk(bodyStmts, from); // `with`, `using`, try-with-resources: a scope, not a branch
    const id = this.decision("try", "try", "warning", n, from);
    let exits = this.walk(bodyStmts, [{ id }]);
    for (const h of handlers) {
      const hBody = bodyOf(h);
      const hid = this.add({ kind: "decision", category: "warning", title: headerOf(h, hBody) || "catch", subtitle: "catch", height: 60 }, h.startPosition.row + 1);
      this.link([{ id, label: "error" }], hid, { style: "dashed" });
      exits = [...exits, ...this.walk(statementsOf(hBody), [{ id: hid }])];
    }
    if (fin) {
      const fid = this.add({ kind: "decision", category: "note", title: "finally", subtitle: "finally", height: 60 }, fin.startPosition.row + 1);
      this.link(exits, fid);
      exits = this.walk(statementsOf(bodyOf(fin) ?? fin), [{ id: fid }]);
    }
    return exits;
  }

  private endFlow(n: Node, kind: "return" | "throw" | string, from: readonly Exit[]): Exit[] {
    const text = stmtLabel(n).replace(/^(return|throw|raise)\s*/i, "");
    const { resolved, rows } = this.callInfo(n); // `return service.place(x)` links to the callee like any call
    const id = this.add(
      {
        kind: "end",
        category: kind === "throw" ? "warning" : "note",
        title: text || (kind === "throw" ? "throw" : "return"),
        subtitle: kind === "throw" ? "throw" : "return",
        rows: resolved.length ? rows.map((t) => ({ text: t })) : undefined,
        height: 48 + (resolved.length ? 18 * rows.length : 0),
      },
      n.startPosition.row + 1,
    );
    const node = this.nodes.find((x) => x.id === id);
    if (node && resolved[0]) node.source = { path: resolved[0].t.path, line: resolved[0].t.line };
    this.link(from, id);
    return []; // nothing falls through a return or throw
  }
}

// ---- entry points --------------------------------------------------------------------------------------------------

function functionNodeAt(spec: LanguageSpec, root: Node, line: number, text: string, col?: number): Node | undefined {
  const row = line - 1;
  const lineText = text.split("\n")[row] ?? "";
  const column = col ?? Math.max(0, lineText.search(/\S/));
  let n: Node | null = root.descendantForPosition({ row, column });
  while (n) {
    if (spec.functions.includes(n.type) && nameOf(n)) return n;
    n = n.parent;
  }
  // The cursor is on a modifier or decorator line (`export`, `async`, `public`, `@Get()`), just outside the node:
  // take the first function that starts on this line or within the next two.
  const found = root.descendantsOfType(spec.functions, { row, column: 0 }, { row: row + 2, column: 1000 });
  return found.filter((f): f is Node => f !== null && !!nameOf(f)).sort((a, b) => a.startPosition.row - b.startPosition.row || a.startIndex - b.startIndex)[0];
}

function functionBody(n: Node): Node | null {
  // Dart keeps the body next to the signature: method_signature { function_signature } function_body
  let sig: Node = n;
  while (sig.parent && /signature/.test(sig.parent.type)) sig = sig.parent;
  if (sig.nextNamedSibling?.type === "function_body") return sig.nextNamedSibling;
  return n.childForFieldName("body") ?? named(n).filter(isContainer).at(-1) ?? named(n).at(-1) ?? null;
}

function containerOfFunction(spec: LanguageSpec, n: Node): string | undefined {
  let p = n.parent;
  while (p) {
    if (spec.types[p.type]) return nameOf(p);
    p = p.parent;
  }
  return undefined;
}

export function buildFlow(spec: LanguageSpec, root: Node, text: string, path: string, req: FlowRequest, resolve: CallResolver): FlowOutcome {
  if (req.kind === "function") {
    const fn = functionNodeAt(spec, root, req.line, text, req.column);
    if (!fn) return { ok: false, reason: "There is no function at the cursor." };
    const name = nameOf(fn) ?? "function";
    const container = containerOfFunction(spec, fn);
    const b = new Builder(spec, path, container, resolve);
    const entry = b.start(container ? `${container}.${name}` : name, fn.startPosition.row + 1, `${path.slice(path.lastIndexOf("/") + 1)}:${fn.startPosition.row + 1}`);
    const exits = b.walk(statementsOf(functionBody(fn)), entry);
    b.finish(exits);
    return done(b, container ? `${container}.${name}` : name, path, `function ${name}`);
  }

  // Selection: the statements it touches, inside the innermost block that contains it.
  const start = { row: req.startLine - 1, column: 0 };
  const end = { row: req.endLine - 1, column: (text.split("\n")[req.endLine - 1] ?? "").length };
  let scope: Node | null = root.descendantForPosition(start, end);
  while (scope && scope !== root && !isContainer(scope) && !spec.functions.includes(scope.type)) scope = scope.parent;
  scope ??= root;
  const list = spec.functions.includes(scope.type) ? statementsOf(functionBody(scope)) : scope === root ? named(root) : statementsOf(scope);
  const picked = list.filter((s) => s.startPosition.row <= end.row && s.endPosition.row >= start.row);
  if (!picked.length) return { ok: false, reason: "The selection contains no statements." };
  const fn = (() => {
    let p: Node | null = scope;
    while (p && !spec.functions.includes(p.type)) p = p.parent;
    return p ?? undefined;
  })();
  const container = fn ? containerOfFunction(spec, fn) : undefined;
  const where = fn ? `${container ? `${container}.` : ""}${nameOf(fn) ?? "function"}` : path.slice(path.lastIndexOf("/") + 1);
  const b = new Builder(spec, path, container, resolve);
  const entry = b.start(req.startLine === req.endLine ? `Line ${req.startLine}` : `Lines ${req.startLine}–${req.endLine}`, req.startLine, where);
  const exits = b.walk(picked, entry);
  b.finish(exits);
  return done(b, `${where}: lines ${req.startLine}–${req.endLine}`, path, "selection");
}

function done(b: Builder, title: string, path: string, scope: string): FlowOutcome {
  layoutFlow(b.nodes, b.edges);
  return {
    ok: true,
    truncated: b.truncated,
    diagram: { version: 1, title, nodes: b.nodes, edges: b.edges, meta: { generated: { by: "tracer", path, scope } } },
  };
}
