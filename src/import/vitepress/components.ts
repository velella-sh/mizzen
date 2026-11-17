/**
 * Converts the VitePress Markdown that has an exact Mizzen equivalent: the built-in containers and the
 * components the import configuration maps to a directive. Nothing is evaluated. A component without a
 * mapping, a dynamic attribute, or an interpolation is dropped at its source place and listed in
 * `dynamic`, in source order, for the report task.
 */

/** A VitePress component name mapped to the Mizzen directive it becomes. */
export type ComponentMappings = Readonly<Record<string, string>>;

/** A place whose final text needs Vue, with the position the report names. */
export interface DynamicPart {
  /** 1-based line of the tag or expression. */
  readonly line: number;
  /** 1-based column, in Unicode code points. */
  readonly column: number;
  /** The dropped source text, such as `<ReleaseNotes …>` or `{{ version }}`. */
  readonly text: string;
}

/** The converted page and the places it could not convert. */
export interface ConvertedPage {
  readonly markdown: string;
  readonly dynamic: readonly DynamicPart[];
}

/** VitePress container names and the Mizzen directive each one becomes. */
const CONTAINERS: Readonly<Record<string, string>> = {
  tip: "tip",
  info: "note",
  warning: "warning",
  danger: "danger",
  details: "details",
};

const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const CONTAINER = /^ {0,3}:::[ \t]+(tip|info|warning|danger|details)(?:[ \t]+(.*?))?[ \t]*$/u;
const CLOSE_COMPONENT = /^\s*<\/([A-Z][\w.]*)>\s*$/u;
const OPEN_COMPONENT = /^(\s*)<([A-Z][\w.]*)([^>]*?)(\/?)>\s*$/u;
const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/gu;
const INTERPOLATION = /\{\{.*?\}\}/gu;

/** 1-based column of a UTF-16 index, counted in code points as `SourcePos` requires. */
function columnOf(line: string, index: number): number {
  return [...line.slice(0, index)].length + 1;
}

/** The directive attributes of a tag: written names and values stay as they were, dynamic ones are reported. */
function attributesOf(tag: string, line: string, lineNumber: number, dynamic: DynamicPart[]): string {
  const start = line.indexOf(tag);
  const kept: string[] = [];
  for (const match of tag.matchAll(ATTRIBUTE)) {
    const raw = match[0].trim();
    const name = match[1] ?? "";
    if (/^(?::|@|#|v-)/u.test(name) || raw.includes("{{")) {
      dynamic.push({ line: lineNumber, column: columnOf(line, start + (match.index ?? 0)), text: raw });
    } else {
      kept.push(raw);
    }
  }
  return kept.length === 0 ? "" : `{${kept.join(" ")}}`;
}

/** Removes `{{ … }}` and reports each one; the rest of the line is transferred as written. */
function withoutExpressions(line: string, lineNumber: number, dynamic: DynamicPart[]): string {
  return line.replace(INTERPOLATION, (match, offset: number) => {
    dynamic.push({ line: lineNumber, column: columnOf(line, offset), text: match });
    return "";
  });
}

/** Converts one VitePress page. A component is converted only when `mappings` names it. */
export function convertVitePress(markdown: string, mappings: ComponentMappings = {}): ConvertedPage {
  const lines = markdown.split(/\r?\n/u);
  const trailing = markdown.endsWith("\n");
  if (trailing) lines.pop();

  const out: string[] = [];
  const dynamic: DynamicPart[] = [];
  const open: { name: string; directive: string | undefined }[] = [];
  let fence: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNumber = i + 1;

    const openingFence = FENCE.exec(line);
    if (openingFence) {
      const marker = openingFence[1]?.[0];
      fence = fence === undefined ? marker : fence === marker ? undefined : fence;
      out.push(line);
      continue;
    }
    if (fence !== undefined) {
      out.push(line);
      continue;
    }

    const closing = CLOSE_COMPONENT.exec(line);
    if (closing) {
      const top = open[open.length - 1];
      if (top !== undefined && top.name === closing[1]) {
        open.pop();
        if (top.directive !== undefined) out.push(":::");
        continue;
      }
    }

    const component = OPEN_COMPONENT.exec(line);
    if (component) {
      const name = component[2] ?? "";
      const attrs = component[3] ?? "";
      const selfClosing = component[4] === "/";
      const directive = mappings[name];
      if (directive !== undefined) {
        out.push(`${selfClosing ? "::" : ":::"}${directive}${attributesOf(attrs, line, lineNumber, dynamic)}`);
        if (!selfClosing) open.push({ name, directive });
      } else {
        dynamic.push({ line: lineNumber, column: columnOf(line, line.indexOf(`<${name}`)), text: line.trim() });
        if (!selfClosing) open.push({ name, directive: undefined });
      }
      continue;
    }

    const container = CONTAINER.exec(line);
    if (container) {
      const kind = container[1] ?? "";
      const target = CONTAINERS[kind] ?? kind;
      const title = container[2]?.trim();
      if (target === "details") {
        out.push(title ? `:::details{title="${title.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"}` : ":::details");
      } else {
        out.push(title ? `:::${target}[${title}]` : `:::${target}`);
      }
      continue;
    }

    out.push(withoutExpressions(line, lineNumber, dynamic));
  }

  return { markdown: out.join("\n") + (trailing ? "\n" : ""), dynamic };
}
