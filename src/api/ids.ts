/**
 * Whether a record id can be a file name. The API names a record's file by its id and never rewrites an id, because an
 * id that changed spelling would no longer be the id; an id that cannot be a file name is reported instead.
 */

/** Names a Windows host reserves, with or without an extension. */
const RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

/** The longest id, in UTF-8 bytes, that fits a file name on common file systems with `.json` appended. */
const MAX_BYTES = 200;

/** Why an id is not safe as a file name, or `undefined` when it is. */
export function unsafeIdReason(id: string): string | undefined {
  if (id === "") return "it is empty";
  if (id === "." || id === "..") return "it is a path segment";
  if (/[/\\]/.test(id)) return "it contains a slash";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(id)) return "it contains a control character";
  if (/[<>:"|?*]/.test(id)) return "it contains a character a file name cannot hold on every host";
  if (/[. ]$/.test(id)) return "it ends in a dot or a space";
  if (RESERVED.test(id)) return "it is a name some hosts reserve";
  if (Buffer.byteLength(id, "utf8") > MAX_BYTES) return `it is longer than ${MAX_BYTES} bytes`;
  return undefined;
}
