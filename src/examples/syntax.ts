/**
 * The opt-in attributes of an executable fence (#1325).
 *
 * A bare `test` token still marks a fence as an example, exactly as before. Every other attribute is optional and only
 * refines what that example is: a stable id, a shared session, a hidden setup or teardown block, a runbook step, a
 * snippet source, expected stdout or stderr, and the runner's limits. A fence without `test` is untouched, so a site
 * that never opts in keeps its bytes and its behavior.
 *
 * Parsing is total: an attribute this version does not know, or a value of the wrong shape, is ignored rather than
 * failing the page. A malformed limit is reported where it is read (`timeoutMs`, `memoryMb`), because a limit that was
 * silently dropped would run an example the author meant to bound.
 */

/** Which role a block plays in an example: a step of the output, hidden setup, hidden teardown, or a runbook step. */
export type ExampleRole = "output" | "setup" | "teardown" | "step";

/** How an expected output is compared: the whole text, or a regular expression. */
export type ExampleMatch = "exact" | "pattern";

/** A snippet the block's code reads from, so a source change invalidates the evidence (#1332). */
export interface ExampleSnippet {
  /** The file, relative to the source folder, `/`-separated. */
  readonly file: string;
  /** `2-10` or `4`, 1-based and inclusive; the whole file when omitted. */
  readonly lines?: string;
}

/** Parsed opt-in attributes of one executable fence. */
export interface ExampleSyntax {
  /** The stable id the author gave with `id="..."`; absent keeps the page-local `example-<order>`. */
  readonly id?: string;
  /** The shared session this block joins, so blocks run in one process in document order (#1330). */
  readonly session?: string;
  /** The block's role; `output` is a normal example, the others are the special blocks. */
  readonly role: ExampleRole;
  /** True when the block is hidden from the public HTML but kept in the Markdown twin (#1331). */
  readonly hidden: boolean;
  /** The runbook this step belongs to, when the block is a `step`. */
  readonly runbook?: string;
  /** A shell command that must exit zero before the step runs (#1333). */
  readonly precondition?: string;
  /** How the expected stdout is compared; default `exact`. */
  readonly stdout: ExampleMatch;
  /** How the expected stderr is compared; default `exact`. */
  readonly stderr: ExampleMatch;
  /** The snippet the block reads, when it does not carry its code inline. */
  readonly snippet?: ExampleSnippet;
  /** Whether the runner may reach the network; default `deny` for an executable example (#1334). */
  readonly network: "allow" | "deny";
  /** Per-block timeout in milliseconds; absent uses the runner's limit. */
  readonly timeoutMs?: number;
  /** Per-block V8 old-space limit in MiB; absent keeps V8's default. */
  readonly memoryMb?: number;
}

/** A bare flag or `key="value"` pair from a fence meta string. */
interface Attribute {
  readonly key: string;
  readonly value: string | undefined;
}

/** One meta token: `key=value`, `key="value"`, `key='value'`, a bare `{...}` list, or a bare flag word. */
const TOKEN = /([A-Za-z][\w-]*)\s*=\s*("[^"]*"|'[^']*'|\{[^}]*\}|\S+)|\{([^}]*)\}|([A-Za-z][\w-]*)/g;

/** Removes one pair of matching quotes. */
function unquote(value: string): string {
  const first = value.charAt(0);
  const last = value.charAt(value.length - 1);
  if (value.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/** The attributes of a meta string, in the order written. A bare word is a flag with no value. */
export function attributesOf(meta: string | null | undefined): Attribute[] {
  if (!meta) return [];
  const attributes: Attribute[] = [];
  for (const match of meta.matchAll(TOKEN)) {
    const [, key, value, , flag] = match;
    if (key !== undefined) attributes.push({ key, value: unquote(value ?? "") });
    else if (flag !== undefined) attributes.push({ key: flag, value: undefined });
  }
  return attributes;
}

/** The last value written for `key`, treating a bare flag as `""`; `undefined` when the key is absent. */
function valueOf(attributes: readonly Attribute[], key: string): string | undefined {
  let value: string | undefined;
  for (const attribute of attributes) if (attribute.key === key) value = attribute.value ?? "";
  return value;
}

/** True when `key` appears as a bare flag or with a truthy value. */
function flagOf(attributes: readonly Attribute[], key: string): boolean {
  for (const attribute of attributes) {
    if (attribute.key !== key) continue;
    if (attribute.value === undefined) return true;
    const text = attribute.value.trim().toLowerCase();
    if (text === "" || text === "true" || text === "1" || text === "yes") return true;
  }
  return false;
}

/** A non-empty trimmed attribute value, or `undefined`. */
function textOf(attributes: readonly Attribute[], key: string): string | undefined {
  const value = valueOf(attributes, key)?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** A positive whole number from an attribute, or `undefined` when it is absent or not one. */
function boundOf(attributes: readonly Attribute[], key: string): number | undefined {
  const value = textOf(attributes, key);
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/** The role attribute, defaulting to a normal `output` block. */
function roleOf(attributes: readonly Attribute[]): ExampleRole {
  const value = textOf(attributes, "role")?.toLowerCase();
  if (value === "setup" || value === "teardown" || value === "step") return value;
  // Shorthand flags keep the common cases short.
  if (flagOf(attributes, "setup")) return "setup";
  if (flagOf(attributes, "teardown")) return "teardown";
  if (flagOf(attributes, "step")) return "step";
  return "output";
}

/** The snippet attribute: `snippet="file.ts"` or `snippet="file.ts:2-10"`. */
function snippetOf(attributes: readonly Attribute[]): ExampleSnippet | undefined {
  const value = textOf(attributes, "snippet");
  if (value === undefined) return undefined;
  const match = /^(.*?)(?::(\d+(?:-\d+)?))?$/.exec(value);
  const file = (match?.[1] ?? value).trim();
  if (file === "") return undefined;
  return match?.[2] === undefined ? { file } : { file, lines: match[2] };
}

/** The match mode: `match="pattern"`, `stdout="pattern"`, or the default `exact`. */
function matchOf(attributes: readonly Attribute[], keys: readonly string[]): ExampleMatch {
  for (const key of keys) {
    const value = textOf(attributes, key)?.toLowerCase();
    if (value === "pattern" || value === "regex" || value === "regexp") return "pattern";
    if (value === "exact") return "exact";
  }
  return "exact";
}

/** Parses the opt-in attributes of one fence. Total: unknown keys and bad values are ignored, never thrown. */
export function parseExampleSyntax(meta: string | null | undefined): ExampleSyntax {
  const attributes = attributesOf(meta);
  const network = textOf(attributes, "network")?.toLowerCase();
  const id = textOf(attributes, "id");
  const session = textOf(attributes, "session");
  const runbook = textOf(attributes, "runbook");
  const precondition = textOf(attributes, "precondition");
  const snippet = snippetOf(attributes);
  const timeoutMs = boundOf(attributes, "timeoutMs");
  const memoryMb = boundOf(attributes, "memoryMb");
  const stderr = matchOf(attributes, ["stderr", "stderrMatch"]);
  return {
    ...(id === undefined ? {} : { id }),
    ...(session === undefined ? {} : { session }),
    role: roleOf(attributes),
    hidden: flagOf(attributes, "hidden"),
    ...(runbook === undefined ? {} : { runbook }),
    ...(precondition === undefined ? {} : { precondition }),
    // `stdout`, the bare `match`, and `pattern` all ask for a pattern; an explicit `exact` wins.
    stdout: exactOf(attributes) ?? matchOf(attributes, ["stdout", "match"]),
    stderr: stderr,
    ...(snippet === undefined ? {} : { snippet }),
    network: network === "allow" ? "allow" : "deny",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(memoryMb === undefined ? {} : { memoryMb }),
  };
}

/** `exact` when the meta says so explicitly, so a stray `pattern` flag does not override it. */
function exactOf(attributes: readonly Attribute[]): ExampleMatch | undefined {
  for (const key of ["stdout", "match"]) {
    if (textOf(attributes, key)?.toLowerCase() === "exact") return "exact";
  }
  return undefined;
}

/** True for an id a fence may declare: lower-case, digits, and hyphens, starting with an alphanumeric. */
export function validExampleId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}
