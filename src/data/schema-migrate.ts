/**
 * `mizzen data migrate [collection] [dir]`: previews moving earlier records to the current schema. It applies the
 * collection's explicit `schemaRenames`, validates every record, and prints a sample of the migrated records and each
 * rejected one with its source line. Nothing is written, and a source that cannot be read is one error.
 *
 * Exit 0 is a preview, 1 is a config, schema, or source problem, and 2 is a usage error.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { loadConfig } from "../config/load.ts";
import type { DataRecord, Diagnostic } from "../contracts/index.ts";
import { applySchemaRenames, formatOf, readText } from "./collections.ts";
import { compileSchemas, validateRecords } from "./schema.ts";

/** How many migrated records a preview prints. */
const SAMPLE = 3;

/** What {@link dataMigrate} found, ready for the CLI to print. */
export interface DataMigrateResult {
  /** 0 when every selected collection was previewed, 1 when the config, a schema, or a source has an error. */
  readonly code: number;
  /** The preview, ending in a newline. */
  readonly output: string;
  /** Problems, printed to stderr. */
  readonly errors: readonly string[];
}

/** One finding as a preview line, with the source line it points at. */
function lineOf(diagnostic: Diagnostic): string {
  const pos = diagnostic.pos;
  const at = pos === undefined ? "" : `${pos.file}:${pos.line}: `;
  return `  ${diagnostic.severity} ${at}${diagnostic.id}: ${diagnostic.message}`;
}

/** Previews every selected collection without writing; the whole site when no collection is named. */
export async function dataMigrate(options: { readonly root: string; readonly name?: string }): Promise<DataMigrateResult> {
  const loaded = loadConfig(options.root);
  const errors = loaded.diagnostics.filter((finding) => finding.severity === "error").map((finding) => finding.message);
  if (errors.length > 0) return { code: 1, output: "", errors };

  const names = Object.keys(loaded.config.collections).sort();
  const selected = options.name === undefined ? names : names.filter((name) => name === options.name);
  if (options.name !== undefined && selected.length === 0) {
    return { code: 1, output: "", errors: [`no collection named "${options.name}"`] };
  }

  const scratch: Diagnostic[] = [];
  const compiled = compileSchemas(options.root, loaded.config, {}, scratch);
  for (const finding of scratch) {
    if (finding.severity === "error") errors.push(finding.message);
  }
  if (errors.length > 0) return { code: 1, output: "", errors };

  const lines: string[] = [];
  let code = 0;
  for (const name of selected) {
    const entry = loaded.config.collections[name]!;
    const schema = compiled.schemas[name];
    if (schema === undefined) {
      lines.push(`skipped ${name}: ${compiled.unchecked.includes(name) ? "no schema is declared" : "the schema cannot be read"}`);
      continue;
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(entry.source)) {
      errors.push(`${name}: data migrate previews a local source, and "${entry.source}" is an address.`);
      code = 1;
      continue;
    }
    const file = resolve(options.root, entry.source);
    const sourcePath = relative(options.root, file);
    const display = sourcePath.split(sep).join("/");
    if (sourcePath === ".." || sourcePath.startsWith(`..${sep}`) || isAbsolute(sourcePath)) {
      errors.push(`${name}: "${entry.source}" is outside the site root.`);
      code = 1;
      continue;
    }
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      errors.push(`${name}: ${display} cannot be read.`);
      code = 1;
      continue;
    }

    const sourceDiagnostics: Diagnostic[] = [];
    const read = readText(name, entry.source, display, text, entry.id ?? "id", sourceDiagnostics);
    if (read === undefined) {
      for (const finding of sourceDiagnostics) lines.push(lineOf(finding));
      code = sourceDiagnostics.some((finding) => finding.severity === "error") ? 1 : code;
      continue;
    }
    const migrated = applySchemaRenames(name, read, entry.schemaRenames ?? {}, sourceDiagnostics);

    let renamed = 0;
    let rejected = 0;
    const sample: DataRecord[] = [];
    const rejectedLines: string[] = [];
    for (let index = 0; index < migrated.length; index++) {
      const record = migrated[index]!;
      if (JSON.stringify(record.fields) !== JSON.stringify(read[index]!.fields)) renamed += 1;
      const findings: Diagnostic[] = [];
      if (validateRecords(name, [record], schema, entry, formatOf(entry.source), findings).skipped === 0) {
        if (sample.length < SAMPLE) sample.push(record);
        continue;
      }
      rejected += 1;
      for (const finding of findings) rejectedLines.push(lineOf(finding));
    }

    lines.push(`${name}: ${display}, schema ${schema.file}`);
    lines.push(`  ${migrated.length} records, ${renamed} renamed, ${rejected} rejected`);
    for (const finding of sourceDiagnostics) lines.push(lineOf(finding));
    for (const record of sample) lines.push(`  sample ${JSON.stringify(record.fields)}`);
    lines.push(...rejectedLines);
    if (sourceDiagnostics.some((finding) => finding.severity === "error")) code = 1;
  }

  return { code, output: lines.length === 0 ? "" : `${lines.join("\n")}\n`, errors };
}
