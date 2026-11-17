# Design note: API contract check

Epic: api-contract-check (#612). Issue: #613. Status: accepted.

## Problem

A page can cite a function's line and write its signature. A change to a function body is harmless; a changed
parameter or type member is not. The drift scanner already compares TypeScript signatures, but what it checks has
never been written down: the comparable scope, what counts as removal, what is reported as unchecked, and what
fails CI. This note fixes those four answers. The other issues of the epic implement them; this issue only adds the
note, the fixture, and a baseline test.

## Audit: what exists today

The comparison lives in `src/drift/` and runs for every page with a code reference:

- `code-refs.ts` finds `path:line`, `path:line:col`, `path:line-line`, and `path#Lx-Ly` references in text, inline
  code, link URLs, and `test` fences. A path resolves from the page's folder unless it starts with `/`, which
  anchors it at the site root.
- `symbols.ts` scans top-level exports without a TypeScript compiler and normalizes each declaration's signature.
  Unsupported declarations carry an `unchecked` reason instead of a guessed signature.
- `compare.ts` resolves every reference inside the site root, checks existence and line ranges, and for a
  TypeScript target compares the cited line with an export within the tolerance (default 5 lines). Inline code in
  the reference's paragraph names the symbol and may state its signature.
- `outputs/drift-report.ts` writes `drift.json` from those findings, grouped by page URL, with coverage and
  evidence.

Every drift diagnostic is a `warning` by default, except `drift.symbols-syntax`, which is an `error`. A contract
failure can be raised to an error with `drift.severity`, which `mizzen doctor` and `drift.json` both report; the
configurable gate is #617.

### Baseline run

`fixtures/api-contract-check/` is the audit fixture: `docs/widgets.md` cites `/src/widget.ts:10` with
`` `createWidget(name: string, options?: WidgetOptions): Widget` `` and `/src/widget.ts:1` with
`` `interface WidgetOptions { readonly id: string }` ``, so it connects a function parameter and a type member.
`node --test test/api-contract-check.test.ts` runs the current comparison against it:

| Case | Current result |
| --- | --- |
| The fixture as written | No findings. |
| `name: string` changed to `name: number` in the page | One `drift.signature-mismatch` at `docs/widgets.md:3`; the message names `src/widget.ts` and line 10. |
| `createWidget` changed to `makeWidget` in the page | `drift.missing-symbol` at the same claim. |
| The claim written as `createWidget(...args)` | `drift.signature-unchecked` at the same claim, with the reason. |

The last two are not clean results: one names the removal, the other names a form the check cannot compare.

## The checked contract

An **API claim** is inline code in the same paragraph as a code reference. The inline code names a symbol and may
state its signature. A reference with no such inline code stays a path/line check, as before, and is not promoted
to an API claim.

### Comparable scope

The first acceptance base is an exported TypeScript declaration:

| Claim form | Compared | Not compared |
| --- | --- | --- |
| `createWidget(name: string, options?: WidgetOptions): Widget` | Parameter count, parameter types, optionality, generics written on the claim, and a documented return type. Named parameters may be spelled differently by the page. | Parameter names, default values, and the function body. A trailing optional parameter may be left out of the page; a declared optional parameter the page leaves out is not drift. A return type the page does not write is not drift. |
| `createWidget()` | Arity only. | Types, generics, return type. |
| `interface WidgetOptions { readonly id: string }`, `class Widget { resize(width: number): void }` | The members the page states, after normalization; generics and heritage when the page writes them. The page may state a subset of the declaration's members. | Extra declaration members, member order, constructors, private members, and bodies. A changed or missing stated member is drift. |
| `type Id = string \| number` | The right-hand side. | The alias name's kind when the declaration is not a type alias. |
| `const VERSION: string` | The annotated type. | A const whose type is inferred. |
| `Widget` | The name and its declaration line only. | Every signature detail. |

A declaration with overloads matches if any overload matches, and any overload's line may be cited. Only top-level
exports are scanned; a local re-export is resolved by #615, and declarations from installed packages are out of
scope.

Comparable text is normalized: whitespace, comments, declaration formatting, equivalent quote style, function
bodies, property initializers, and a trailing `async` do not create drift. A default value whose type is not
written states only optionality. The comparison is a subset check, not a type-system proof: an extra optional
parameter, an extra member, or an undocumented return type on the declaration is accepted.

### API removal

- `drift.missing-symbol` when the page names an export the file no longer has, or when a cited TypeScript file
  exports nothing. The finding points at the documented claim and names the missing symbol.
- `drift.moved-symbol` when the symbol still exists but the cited line is farther than the tolerance from every
  declaration or overload. The message names the symbol and its actual line.
- `drift.missing-file`, `drift.line-out-of-range`, and `drift.outside-root` when the target cannot be checked:
  a missing file, a cited line a non-TypeScript file does not have, or a path that resolves outside the root.
- A rename is removal plus a new name, not a rename detection. A lowercase-only bare name is not treated as a
  symbol claim, so renaming one can leave a page clean; a call or a signature claim does not have that gap.

### Unchecked cases

An unchecked result is never a pass. It is reported at the documentation claim, with the reason, and the
citation is not counted as clean:

- A declaration whose API cannot be read: an inferred const type, an enum, a namespace or namespace alias, a
  re-export or default export whose local declaration is unknown, a member or class body the scanner cannot
  extract, or an ambiguous export (#615).
- A documented form that states no comparable API: a spread argument (`createWidget(...args)`), a destructured
  argument, an unparsable signature, a class constructor, a typed parameter or return type the declaration does
  not annotate, or a parameter past the declared rest parameter.
- A claim attached to a file outside the TypeScript acceptance base. The report shape stays the same and the
  claim is unchecked; no language-specific finding is invented.

A TypeScript file the scanner cannot parse is the stronger `drift.symbols-syntax` error, carries the scanner's
real position in the target, and replaces every symbol judgment for that citation. It is never reported as a
clean, missing, or exportless file.

### Report contract

Every result answers the same questions without naming a language: which documentation file and span made the
claim, which code path and line it targets, which symbol and (when stated) member or parameter it names, and
whether the result is a match, a mismatch, a removal, a move, or unchecked with a reason. TypeScript is the first
resolver; another resolver fills the same fields. `drift.json` keeps its existing `kind`, `reference`, `severity`,
`message`, `help`, `source`, and `target` keys, and a contract finding adds `state` (`mismatch`, `missing`, `moved`,
or `unchecked`) without changing the meaning of those keys. A reference without a claim keeps its path/line finding
and no `state`.

## CI policy

- A contract failure is `drift.signature-mismatch`, `drift.missing-symbol`, or `drift.moved-symbol`. It is a
  `warning` by default; a site raises it with `drift.severity: error`. `drift.symbols-syntax` is always an error.
  The process exits non-zero and the diagnostic carries the documentation path and line, so CI points at the claim
  and not only at the code.
- `drift.signature-unchecked` is always a `warning` and exits zero, whatever `drift.severity` says. It is always
  printed and present in JSON, so an intentionally uncovered case cannot fail CI by accident.
- `mizzen doctor` adds a `drift` check, which reads the same comparison `drift.json` writes. A site that turns the
  `drift-report` output off with `outputs` skips the check.
- The existing `drift.missing-file`, `drift.line-out-of-range`, and `drift.outside-root` findings keep their
  current severity unless the site raises it. This epic does not widen the gate beyond the API contract.
- The gate runs from a directory where the cited files resolve, through `MIZZEN_SITE_ROOT` or the working
  directory, and reads `drift.json`. A page with no coverage or no evidence is not a clean page: absence of a
  finding only counts when the page was measured.
- Findings remain deterministic and source-positioned; the recipe does not compare wall-clock output or a
  generated snapshot.

## Recipe

`recipes/api-contract-check.yml` runs `mizzen doctor --format json` on a pull request, prints the findings, and
uploads the JSON whether the job passes or fails. It needs `drift.severity: error` in the site config to fail on a
changed signature; unchecked claims stay visible in the same report and leave the exit code at 0.

```yaml
# mizzen.yml
drift:
  severity: error
```

## Limits

The check is textual and syntactic, not a type checker: it does not prove assignability, resolve generic types
across modules, read declarations from packages, or compare function bodies. A page can still describe behavior
the signature does not capture. The fixture is read-only and grows by new files, not by editing an existing case.

`fixtures/api-contract-check/` holds the source and the page; `test/api-contract-check.test.ts` runs the current
comparison and is the baseline that the rest of the epic must keep green or supersede deliberately.
