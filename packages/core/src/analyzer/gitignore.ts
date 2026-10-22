// ponytail: the common .gitignore subset (globs, `**`, anchored `/x`, dir-only `x/`, comments).
// Negation (`!x`) and nested .gitignore files are not supported; they are reported as a warning.
// Upgrade path: the `ignore` npm package if real repos need full semantics.

export type IgnoreMatcher = (relPath: string, isDirectory: boolean) => boolean;

function globToRegex(glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return re;
}

export function parseGitignore(text: string): { matches: IgnoreMatcher; unsupported: string[] } {
  const rules: { re: RegExp; dirOnly: boolean }[] = [];
  const unsupported: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("!")) {
      unsupported.push(line);
      continue;
    }
    const dirOnly = line.endsWith("/");
    let pattern = dirOnly ? line.slice(0, -1) : line;
    // A slash at the start or in the middle anchors the pattern to the root; otherwise it matches at any depth.
    const anchored = pattern.includes("/");
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    rules.push({ re: new RegExp(`${anchored ? "^" : "(?:^|/)"}${globToRegex(pattern)}$`), dirOnly });
  }
  return {
    matches: (relPath, isDirectory) => rules.some((r) => (!r.dirOnly || isDirectory) && r.re.test(relPath)),
    unsupported,
  };
}
