# ADR: How social share images are rendered

- Status: accepted
- Epic: `social-images` (#191), decision #280
- Date: 2026-11-16

## Context

Every page can have a share image built from an SVG template and the page's own fields. The build is deterministic: the same input gives the same bytes on every operating system. Rendering text to PNG is where that usually breaks, because the result depends on the system font, the shaping library, the rasterizer, and the PNG encoder. The rules from the issue: no browser, no system font, no network call.

## Options measured

Both options are `resvg` (a Rust SVG renderer with its own text shaping, which handles right-to-left and Arabic-script joining). They differ in how it is delivered.

| | `@resvg/resvg-wasm` 2.6.2 | `@resvg/resvg-js` 2.6.2 (native addon) |
| --- | --- | --- |
| Delivery | one WebAssembly file, same on every OS | a prebuilt native binary per OS and CPU, chosen at install time |
| Install size | 2.4 MB, one package | 44 KB plus 3.4 MB to 4.5 MB for the platform binary (darwin-arm64 3.4 MB, linux-x64-gnu 4.4 MB, win32-x64 4.5 MB) |
| Speed (1200 x 630, Persian text, fonts passed in memory, mean of 20, Apple silicon, Node 22) | 10 ms per image | 84 ms per image |
| Text shaping | `rustybuzz`: Latin and Arabic script, with right-to-left | the same library |
| System fonts | off with `loadSystemFonts: false`; only the font buffers passed in are used | the same switch |
| Same bytes on Linux, macOS, and Windows | by construction: one binary runs the same integer and float operations on every host (WebAssembly defines its float behaviour; the one open case, the bit pattern of a NaN, is not produced by rendering) | not by construction: each platform binary is a separate compile with its own target-specific float and SIMD paths, so equal bytes would have to be observed, never assumed |
| Install can fail | no | yes: an unsupported platform or `--omit=optional` leaves no binary |

The two renderers do not produce the same bytes as each other for the same SVG (10514 and 9592 bytes in the measurement), which is a reason to choose one and never fall back from one to the other.

A third family, `sharp` (librsvg), was not measured: it finds fonts through the system's fontconfig, which the issue rules out.

Only the macOS arm64 row was measured on this machine. The Linux and Windows equality is a property of the WebAssembly choice that CI checks on all three systems (see Consequences); it is not a result of this document.

## Decision

Render with `@resvg/resvg-wasm`, with system fonts off and every font passed in as bytes the site declared.

- One renderer on every operating system makes "same bytes everywhere" a property of the design, not something to hope for.
- It is the faster of the two and has no install-time branch.
- Text measuring for wrapping uses the same renderer, so a measured width and a drawn width cannot disagree.
- Its license is MPL-2.0, which applies per file to the renderer itself and does not reach the engine's own code.

Pipeline: fill the template's text slots (SVG), render to PNG, then drop every PNG chunk except the image data. The compression is the encoder inside the WebAssembly file, so it does not vary with the Node version's zlib; the engine does not recompress.

## If identical bytes turn out to be impossible

The epic says its scope changes in that case. The fallback is: write no PNG, and write the filled SVG instead (it is plain text and byte-identical by construction), and say in the docs that platforms which require a raster image for `og:image` need a pre-made `image` in front matter. A test that compares the PNG hash with a stored value on Linux, macOS, and Windows is what tells the two cases apart, and it runs in CI on all three. If any of them differs, this ADR is reopened before the output ships.

## Known limits

- Fonts: `.ttf`, `.otf`, and `.woff` are accepted (a `.woff` is unwrapped to its plain font in memory). `.woff2` is not: the resvg renderer cannot read it and decoding it needs a Brotli table transform the engine does not carry.
- Two font files of the same family name and weight collide in the renderer: one hides the other and a character only the hidden one has is not drawn. A script needs its own family (for example a Latin family plus an Arabic-script family, listed in the slot's `font-family`), or one font that covers both. The engine reports a character that no declared font has.
- Wrapping uses the ink width of a text run plus its side bearings, so a line is measured a little wide, never narrow.

## Consequences

- One new dependency: `@resvg/resvg-wasm`.
- CI gets a determinism job on `ubuntu`, `macos`, and `windows` that runs the social image tests, which compare PNG hashes to stored values.
