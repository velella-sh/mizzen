/**
 * Converts the Docusaurus MDX components this importer supports into the Markdown this engine
 * already renders:
 *
 *   <Tabs><TabItem label="Bash" default>…</TabItem></Tabs>  →  :::::tabs / :::tab{label="Bash"}
 *   :::info[Title]                                           →  :::note[Title]
 *   :::caution                                                →  :::warning
 *   import X from '@theme/X';                                →  removed
 *
 * The conversion is textual, before parsing: JSX is raw HTML to the Markdown parser, so a panel's
 * indented Markdown would become a code block. Moving into a directive first keeps its lists and
 * fences as Markdown. `groupId`, `value`, and other attributes have no Markdown equivalent and are
 * dropped; `default` only decides panel order. Custom components, `:::note`, `:::tip`, and
 * `:::warning` are left for the diagnostics stage and the existing admonition unit.
 *
 * Only the fixture's shapes are mapped: one top-level `<Tabs>` per group, each `<TabItem>` on its
 * own line with a quoted `label`, and no nested groups. Anything else is left untouched.
 */
export function convertComponents(source: string): string {
  return convertTabs(convertAdmonitions(stripImports(source)));
}

/** A Docusaurus theme or site import, which the importer never resolves. */
const IMPORT = /^\s*import\s[^\n]*\sfrom\s+['"]@(?:theme|site)\/[^'"]*['"];?\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const ADMONITION = /^(\s*):::(info|caution)(?=\s|\[|\{|$)/;
const TABS_OPEN = /^<Tabs\b[^>]*>$/;
const TAB_OPEN = /^\s*<TabItem\b[^>]*>\s*$/;
const TAB_CLOSE = /^\s*<\/TabItem>\s*$/;
const TABS_CLOSE = /^\s*<\/Tabs>\s*$/;

/** Applies `change` to every line outside a fenced code block; `null` drops the line. */
function mapProse(source: string, change: (line: string) => string | null): string {
  let fence = "";
  const lines: string[] = [];
  for (const line of source.split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    if (fence !== "") {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = "";
      lines.push(line);
    } else if (marker) {
      fence = marker;
      lines.push(line);
    } else {
      const changed = change(line);
      if (changed !== null) lines.push(changed);
    }
  }
  return lines.join("\n");
}

/** Removes theme and site imports; the rendering engine has no module to resolve them against. */
function stripImports(source: string): string {
  return mapProse(source, (line) => (IMPORT.test(line) ? null : line));
}

/** Rewrites the Docusaurus admonition names the shared callout does not already know. */
function convertAdmonitions(source: string): string {
  return mapProse(source, (line) =>
    line.replace(
      ADMONITION,
      (_match, indent: string, name: string) =>
        `${indent}:::${name === "info" ? "note" : "warning"}`,
    ),
  );
}

/** `label` from an opening tag, or `""` when it has none; values are always quoted in the fixture. */
function labelOf(tag: string): string {
  const match = /\slabel\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
  return match?.[1] ?? match?.[2] ?? "";
}

/** The common indentation of a panel body, with blank lines trimmed from both ends. */
function dedent(lines: readonly string[]): string[] {
  const body = [...lines];
  while (body[0]?.trim() === "") body.shift();
  while (body[body.length - 1]?.trim() === "") body.pop();
  const widths = body
    .filter((line) => line.trim() !== "")
    .map((line) => /^\s*/.exec(line)?.[0].length ?? 0);
  const cut = widths.length === 0 ? 0 : Math.min(...widths);
  return body.map((line) => line.slice(cut));
}

/** Turns the inside of one `<Tabs>` group into tab directives, or `null` when its shape is unknown. */
function convertGroup(lines: readonly string[]): string[] | null {
  const panels: { label: string; body: string[]; first: boolean }[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index]?.trim() === "") {
      index += 1;
      continue;
    }
    const opening = lines[index];
    if (opening === undefined || !TAB_OPEN.test(opening)) return null;
    const start = index + 1;
    let end = start;
    while (end < lines.length && !TAB_CLOSE.test(lines[end] ?? "")) end += 1;
    if (end === lines.length) return null;
    panels.push({
      label: labelOf(opening),
      body: dedent(lines.slice(start, end)),
      first: /(?:^|\s)default(?=\s|>)/.test(opening),
    });
    index = end + 1;
  }
  if (panels.length === 0) return null;

  const defaultAt = panels.findIndex((panel) => panel.first);
  if (defaultAt > 0) panels.unshift(...panels.splice(defaultAt, 1));

  const out: string[] = [];
  for (const panel of panels) {
    out.push(panel.label === "" ? ":::tab" : `:::tab{label=${JSON.stringify(panel.label)}}`);
    out.push(...panel.body);
    out.push(":::");
  }
  return out;
}

/** Rewrites every top-level `<Tabs>` group whose children are `<TabItem>` panels. */
function convertTabs(source: string): string {
  const lines = source.split("\n");
  const out: string[] = [];
  let fence = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const marker = FENCE.exec(line)?.[1];
    if (fence !== "") {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = "";
      out.push(line);
      continue;
    }
    if (marker) {
      fence = marker;
      out.push(line);
      continue;
    }
    if (!TABS_OPEN.test(line)) {
      out.push(line);
      continue;
    }
    let end = index + 1;
    while (end < lines.length && !TABS_CLOSE.test(lines[end] ?? "")) end += 1;
    const group = end === lines.length ? null : convertGroup(lines.slice(index + 1, end));
    if (group === null) {
      out.push(line);
      continue;
    }
    out.push(":::::tabs", ...group, ":::::");
    index = end;
  }
  return out.join("\n");
}
