/**
 * One deterministic unified diff for one text file.
 *
 * The edited text is produced by span replacement, so a file has one contiguous changed run at
 * most. A shared prefix and suffix are cut away instead of running a full diff, which keeps the
 * output small and stable. Three lines of context surround the run; a changed region that reaches
 * the end of the file adds nothing beyond it.
 */

/** The lines of a text, without a trailing newline's empty final line. */
function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** A unified diff of `before` and `after` for `file`, with `context` lines around the change. */
export function unifiedDiff(before: string, after: string, file: string, context = 3): string {
  if (before === after) return "";
  const oldLines = linesOf(before);
  const newLines = linesOf(after);

  let prefix = 0;
  const shared = Math.min(oldLines.length, newLines.length);
  while (prefix < shared && oldLines[prefix] === newLines[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldChangeEnd = oldLines.length - suffix;
  const newChangeEnd = newLines.length - suffix;
  const oldStart = Math.max(0, prefix - context);
  const oldEnd = Math.min(oldLines.length, oldChangeEnd + context);
  const newStart = Math.max(0, prefix - context);
  const newEnd = Math.min(newLines.length, newChangeEnd + context);

  const body: string[] = [];
  for (let index = oldStart; index < prefix; index += 1) body.push(` ${oldLines[index]}`);
  for (let index = prefix; index < oldChangeEnd; index += 1) body.push(`-${oldLines[index]}`);
  for (let index = prefix; index < newChangeEnd; index += 1) body.push(`+${newLines[index]}`);
  for (let index = oldChangeEnd; index < oldEnd; index += 1) body.push(` ${oldLines[index]}`);

  const oldCount = oldEnd - oldStart;
  const newCount = newEnd - newStart;
  const oldFrom = oldCount === 0 ? oldStart : oldStart + 1;
  const newFrom = newCount === 0 ? newStart : newStart + 1;
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${oldFrom},${oldCount} +${newFrom},${newCount} @@`,
    ...body,
    "",
  ].join("\n");
}
