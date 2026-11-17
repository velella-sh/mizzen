/**
 * `mizzen init --starter <name> [dir] [--theme <dir>] [--lang <a,b>]` and `mizzen init --list`: starts a site by copying
 * a theme's `starters/<name>/` folder into a target folder.
 *
 * A starter is a folder of ordinary site files. Its optional `starter.json` holds a `title`, a `description`, and
 * `optionalLanguages`: language codes whose files a person may leave out. A file is in an optional language when its
 * name is `<name>.<lang>.<ext>` or when it sits under a top-level `<lang>/` folder. `starter.json` itself is never
 * copied. The command refuses a target folder that is not empty, so it never overwrites anything, and it copies in
 * code-point order so two runs write the same folder.
 */
import { cp, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** The file that describes a starter inside its folder. */
export const STARTER_FILE = "starter.json";

/** What the command needs. */
export interface InitOptions {
  /** The resolved theme root, or `undefined` when none was found. */
  readonly themeRoot: string | undefined;
  /** The starter to copy; absent for `--list`. */
  readonly starter?: string;
  /** The target folder. */
  readonly target: string;
  /** Print the starters instead of copying. */
  readonly list: boolean;
  /** Keep only these optional languages; unset keeps every one. */
  readonly langs?: readonly string[];
}

/** What the command reports. */
export interface InitResult {
  readonly code: number;
  readonly messages: readonly string[];
  readonly errors: readonly string[];
}

/** A starter as `starter.json` describes it. */
interface StarterInfo {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly optionalLanguages: readonly string[];
}

const fail = (message: string): InitResult => ({ code: 1, messages: [], errors: [message] });

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Reads one starter's `starter.json`; a missing or unreadable file gives an empty description, never a throw. */
async function infoOf(dir: string, name: string): Promise<StarterInfo> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(dir, STARTER_FILE), "utf8"));
  } catch {
    raw = {};
  }
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  const langs = Array.isArray(record["optionalLanguages"])
    ? record["optionalLanguages"].filter((item): item is string => typeof item === "string")
    : [];
  return { name, title: text(record["title"]), description: text(record["description"]), optionalLanguages: langs };
}

/** The starters a theme ships, in code-point order. */
async function startersOf(themeRoot: string): Promise<string[]> {
  const root = join(themeRoot, "starters");
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(byCodePoint);
  } catch {
    return [];
  }
}

/** The optional language a relative path belongs to, if any. */
function languageOf(path: string, optional: readonly string[]): string | undefined {
  const parts = path.split("/");
  if (optional.includes(parts[0]!)) return parts[0];
  const name = parts[parts.length - 1]!;
  const segments = name.split(".");
  if (segments.length >= 3) {
    const lang = segments[segments.length - 2]!;
    if (optional.includes(lang)) return lang;
  }
  return undefined;
}

/** Runs the command. */
export async function init(options: InitOptions): Promise<InitResult> {
  const { themeRoot } = options;
  if (themeRoot === undefined) return fail("no theme found; set theme.name in the config or pass --theme");
  const names = await startersOf(themeRoot);

  if (options.list) {
    if (names.length === 0) return { code: 0, messages: ["The theme ships no starters."], errors: [] };
    const lines: string[] = [];
    for (const name of names) {
      const info = await infoOf(join(themeRoot, "starters", name), name);
      lines.push(`${name}\t${info.title}\t${info.description}`.replace(/\t+$/, ""));
    }
    return { code: 0, messages: lines, errors: [] };
  }

  const starter = options.starter;
  if (starter === undefined) return fail("init needs --starter <name>; run mizzen init --list to see the starters");
  const dir = join(themeRoot, "starters", starter);
  if (!names.includes(starter) || !(await isDirectory(dir))) {
    const known = names.length === 0 ? "the theme ships none" : `the theme ships ${names.join(", ")}`;
    return fail(`starter "${starter}" not found in the theme at ${themeRoot}; ${known}`);
  }

  if (await isDirectory(options.target)) {
    if ((await readdir(options.target)).length > 0) {
      return fail(`${options.target} is not empty; choose a new or empty folder`);
    }
  } else {
    try {
      await stat(options.target);
      return fail(`${options.target} exists and is not a folder`);
    } catch {
      // The target does not exist; it is created below.
    }
  }

  const info = await infoOf(dir, starter);
  const unknown = (options.langs ?? []).filter((lang) => !info.optionalLanguages.includes(lang));
  if (unknown.length > 0) {
    return fail(
      `starter "${starter}" has no optional language ${unknown.join(", ")}; its optional languages are ${info.optionalLanguages.join(", ") || "none"}`,
    );
  }
  const left = options.langs === undefined ? new Set<string>() : new Set(info.optionalLanguages.filter((lang) => !options.langs!.includes(lang)));

  await mkdir(options.target, { recursive: true });
  await cp(dir, options.target, {
    recursive: true,
    filter: (source) => {
      const path = relative(dir, source).split(sep).join("/");
      if (path === "") return true;
      if (path === STARTER_FILE) return false;
      const lang = languageOf(path, info.optionalLanguages);
      if (lang !== undefined && left.has(lang)) return false;
      return true;
    },
  });
  return {
    code: 0,
    messages: [`Copied the ${starter} starter into ${options.target}.`],
    errors: [],
  };
}
