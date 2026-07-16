// Minimal `.env` parser for the Console's env-var editor. Supports the subset
// of dotenv syntax people actually paste / drop:
//   - `KEY=value` lines
//   - `export KEY=value` (the `export ` prefix is stripped)
//   - blank lines and `#` comment lines are ignored
//   - surrounding single or double quotes on the value are stripped
//   - inline `# comment` trailing an UNquoted value is stripped
//   - CRLF and LF line endings
// Later keys win (a repeated KEY overrides the earlier value) so pasting over
// an existing block behaves like a merge.

export interface ParsedEnvVar {
  name: string;
  value: string;
}

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** Parse `.env`-style text into ordered { name, value } pairs (later keys win). */
export function parseDotenv(text: string): ParsedEnvVar[] {
  const byName = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const name = m[1];
    byName.set(name, unquoteValue(m[2]));
  }
  return [...byName.entries()].map(([name, value]) => ({ name, value }));
}

function unquoteValue(raw: string): string {
  let v = raw.trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      // Quoted value — take the literal contents, keep inner `#` verbatim.
      return v.slice(1, -1);
    }
  }
  // Unquoted → strip a trailing inline comment (` #...`), then trim.
  const hash = v.search(/\s#/);
  if (hash !== -1) v = v.slice(0, hash);
  return v.trim();
}
