/**
 * Discover CLI commands and flags (#1339): reads the running CLI's own help and parser, records every command, its
 * subcommands, its arguments, and every option, and cross-checks the two. A command the help lists but `COMMANDS` does
 * not register, a command `COMMANDS` registers but the help omits, a command the parser does not handle, and a flag the
 * parser accepts but the help does not describe are findings, never silently dropped items.
 *
 * Every item points at the line of the CLI module that writes it: a command at its help line, and a flag at its help
 * line. The help is one template literal, so a help line's file line is the literal's start line plus the line's offset
 * inside it.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative, resolve } from "node:path";
import type { SourcePos } from "../../contracts/source.ts";
import type { SurfaceAdapterResult, SurfaceFinding, SurfaceItem } from "../../contracts/surface.ts";
import { COMMANDS, NAME, parseArgs, usage } from "../../cli/index.ts";
import { itemId, sortItems } from "../contract.ts";

/** What a CLI discovery needs. */
export interface DiscoverCommandsOptions {
  /** The CLI module's file, for spans and the accepted-flag list; defaults to this package's `src/cli/index.ts`, or `dist/cli/index.js` when installed. */
  readonly source?: string;
  /** The version the CLI ships in, so its items carry an introduction version. Default: none. */
  readonly version?: string;
}

/** The module that declares the CLI surface. */
const CLI_TS = fileURLToPath(new URL("../../cli/index.ts", import.meta.url));

/** The package ships compiled output, so an installed copy has `index.js` where a checkout has `index.ts`. */
const CLI_SOURCE = existsSync(CLI_TS) ? CLI_TS : CLI_TS.replace(/\.ts$/, ".js");

/** The 1-based line of `needle` in `source`, or 1 when it does not appear. */
function lineOf(source: string, needle: string): number {
  const at = source.indexOf(needle);
  return at === -1 ? 1 : source.slice(0, at).split("\n").length;
}

/** The line the `usage` template literal opens on, so a help line maps to its file line. */
function usageStartLine(source: string): number {
  return lineOf(source, "export const usage = `");
}

/** A point span at a line of a file. */
function point(file: string, line: number): SourcePos {
  return { file, line, column: 1, endLine: line, endColumn: 1 };
}

/** The span of one line, from its first character to `text`'s length. */
function lineSpan(file: string, line: number, text: string): SourcePos {
  return { file, line, column: 1, endLine: line, endColumn: Math.max(1, text.trimEnd().length) };
}

/** One line from the help's `Commands:` block. */
interface HelpLine {
  /** The words before the first argument, such as `build` or `data extract`. */
  readonly phrase: string;
  /** The top-level command, which is the phrase's first word. */
  readonly command: string;
  /** The subcommand, when the phrase has a second word. */
  readonly subcommand?: string;
  readonly arguments: readonly string[];
  /** The line number inside the usage literal. */
  readonly line: number;
  readonly text: string;
}

/** Reads the help's `Commands:` block into its command lines. */
function helpLines(text: string): HelpLine[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === "Commands:");
  if (start === -1) return [];
  const out: HelpLine[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.trim() === "Options:") break;
    // A command line begins at column 3 with a lowercase word; a wrapped description begins with more spaces.
    if (!/^ {2}[a-z]/.test(line)) continue;
    const words = line.trim().split(/\s+/);
    const phraseWords: string[] = [];
    const args: string[] = [];
    for (const word of words) {
      if (word.startsWith("[") || word.startsWith("<")) {
        args.push(word);
        continue;
      }
      if (args.length > 0) break;
      if (/^[a-z][a-z-]*$/.test(word)) phraseWords.push(word);
      else break;
    }
    if (phraseWords.length === 0) continue;
    out.push({
      phrase: phraseWords.join(" "),
      command: phraseWords[0]!,
      ...(phraseWords.length > 1 ? { subcommand: phraseWords[1]! } : {}),
      arguments: args,
      line: index + 1,
      text: line,
    });
  }
  return out;
}

/** One option from the help's `Options:` block. */
interface HelpFlag {
  readonly name: string;
  readonly line: number;
  readonly text: string;
}

/** Reads every long option from the help's `Options:` block. */
function helpFlags(text: string): HelpFlag[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === "Options:");
  if (start === -1) return [];
  const out: HelpFlag[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const match = /^ {2}(--[A-Za-z][\w-]*)/.exec(line);
    if (match === null) continue;
    out.push({ name: match[1]!, line: index + 1, text: line });
  }
  return out;
}

/** The `--flag` literals the parser recognises, read from its source. */
function acceptedFlags(source: string): string[] {
  const flags = new Set<string>();
  for (const match of source.matchAll(/"(--[a-z][a-z0-9-]*)"/g)) flags.add(match[1]!);
  return [...flags].sort();
}

/** Every `--flag` the help describes, in its Options block or a command's own line. */
function describedFlags(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/(--[A-Za-z][\w-]*)/g)) names.add(match[1]!);
  return names;
}

/** The `--flag` tokens a flag's help line names, so `--report <file>` records `--report` once. */
function flagNames(flag: HelpFlag): string[] {
  const names = new Set<string>();
  for (const match of flag.text.matchAll(/(--[A-Za-z][\w-]*)/g)) names.add(match[1]!);
  return [...names];
}

/**
 * Reads the running CLI's commands, subcommands, arguments, and flags, and checks them against the help and the parser.
 * Every item is derived from the module's own `COMMANDS`, help text, or parser source; nothing is invented.
 */
export async function discoverCommands(options: DiscoverCommandsOptions = {}): Promise<SurfaceAdapterResult> {
  const file = options.source ?? CLI_SOURCE;
  const source = await readFile(file, "utf8");
  // The span is the path a reader sees, never a machine-specific absolute path.
  const display = relative(process.cwd(), resolve(file)).split("\\").join("/") || file;
  const startLine = usageStartLine(source);
  const base = (line: number): number => startLine + line - 1;
  const items: SurfaceItem[] = [];
  const findings: SurfaceFinding[] = [];
  const commands = COMMANDS as readonly string[];
  const help = helpLines(usage);
  const commandsLine = lineOf(source, "export const COMMANDS");
  const version = options.version === undefined ? {} : { version: { introduced: options.version } };

  for (const name of commands) {
    const line = help.find((entry) => entry.command === name);
    items.push({
      id: itemId("command", name),
      area: "cli",
      kind: "command",
      name,
      source: line === undefined ? point(display, commandsLine) : lineSpan(display, base(line.line), line.text),
      stability: "stable",
      signature: `${NAME} ${name}`,
      ...version,
    });
  }

  for (const entry of help) {
    if (!commands.includes(entry.command)) {
      findings.push({
        code: "cli.unregistered-command",
        severity: "error",
        message: `The help lists \`${NAME} ${entry.phrase}\`, which \`COMMANDS\` does not register.`,
        pos: lineSpan(display, base(entry.line), entry.text),
      });
      continue;
    }
    if (entry.subcommand !== undefined) {
      items.push({
        id: itemId("command", entry.phrase),
        area: "cli",
        kind: "command",
        name: entry.subcommand,
        parent: itemId("command", entry.command),
        source: lineSpan(display, base(entry.line), entry.text),
        stability: "stable",
        signature: `${NAME} ${entry.phrase}`,
        ...version,
      });
    }
    for (const argument of entry.arguments) {
      items.push({
        id: itemId("argument", `${entry.phrase} ${argument}`),
        area: "cli",
        kind: "argument",
        name: argument,
        parent: itemId("command", entry.phrase),
        source: lineSpan(display, base(entry.line), entry.text),
        stability: "stable",
        signature: `${NAME} ${entry.phrase} ${argument}`,
        ...version,
      });
    }
  }

  for (const [index, name] of commands.entries()) {
    if (!help.some((entry) => entry.command === name)) {
      findings.push({
        code: "cli.undocumented-command",
        severity: "error",
        message: `\`${NAME} ${name}\` is registered but the help does not list it.`,
        pos: point(display, commandsLine + index),
      });
    }
    const parsed = parseArgs([name, "--help"]);
    if (!("help" in parsed)) {
      findings.push({
        code: "cli.unreachable-command",
        severity: "error",
        message: `\`${NAME} ${name} --help\` is not handled by the parser.`,
        pos: point(display, commandsLine + index),
      });
    }
  }

  const flags = helpFlags(usage);
  const described = describedFlags(usage);
  for (const flag of flags) {
    for (const name of flagNames(flag)) {
      items.push({
        id: itemId("flag", name),
        area: "cli",
        kind: "flag",
        name,
        source: lineSpan(display, base(flag.line), flag.text),
        stability: "stable",
        ...version,
      });
    }
  }

  for (const name of acceptedFlags(source)) {
    if (name === "--help" || described.has(name)) continue;
    findings.push({
      code: "cli.undocumented-flag",
      severity: "warning",
      message: `The parser accepts \`${name}\`, which the help's Options block does not describe.`,
      pos: point(display, lineOf(source, `"${name}"`)),
    });
  }

  // A flag may be described once and recognised by several string literals; the item is the option, once.
  const unique = new Map<string, SurfaceItem>();
  for (const item of items) if (!unique.has(item.id)) unique.set(item.id, item);
  return { version: 1, area: "cli", items: sortItems([...unique.values()]), findings: sortFindings(findings) };
}

/** Orders findings by code then message, so two runs agree. */
function sortFindings(findings: readonly SurfaceFinding[]): SurfaceFinding[] {
  return [...findings].sort(
    (a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : a.message < b.message ? -1 : a.message > b.message ? 1 : 0),
  );
}
