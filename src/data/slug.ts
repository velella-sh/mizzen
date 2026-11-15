/**
 * A URL-safe slug from a field value, for a permalink pattern written `{field|slug}`.
 *
 * Lowercase, then keep the letters and digits of every script and a hyphen for every run of anything else. A name in
 * another script keeps its letters: nothing is transliterated, so `سلام` stays `سلام`. The slug never holds a `/`: the
 * pattern alone says how many segments a URL has, so a scoped name is one segment in `/p/{name|slug}/` and two in
 * `/p/{scope|slug}/{name|slug}/`.
 */

/** True for a code point a slug keeps: a letter, a combining mark, or a digit of any script. */
function kept(char: string): boolean {
  return /[\p{L}\p{M}\p{N}]/u.test(char);
}

/** A URL-safe slug: lowercase, letters and digits kept, every run of separators one hyphen, no leading or trailing hyphen. */
export function slugOf(value: string): string {
  let out = "";
  let separator = false;
  for (const char of value.toLowerCase()) {
    if (kept(char)) {
      if (separator && out !== "") out += "-";
      separator = false;
      out += char;
      continue;
    }
    separator = true;
  }
  return out;
}
