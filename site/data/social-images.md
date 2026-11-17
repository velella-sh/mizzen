---
title: Social images
description: Draw one 1200 by 630 share image per page from an SVG template, with the config keys, template slots, fonts, and the files written.
---

# Social images

A page's share image is drawn from an SVG template and the page's own fields: its title, its description, and the site
name. The build needs no browser, no system font, and no network call, and the same input gives the same bytes on every
operating system. The renderer and the reasons are in the
[decision record](https://github.com/velella-sh/mizzen/blob/main/docs/adr/social-images.md).

```yaml
social:
  template: card
  fonts:
    - fonts/Inter-Regular.ttf
    - fonts/Vazirmatn-Regular.ttf
```

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `template` | string | | The default template of every page: the file `_templates/social/<template>.svg`. A page names another in front matter `social`, or `false` for no image. |
| `fonts` | list of string | `[]` | Font files the images are drawn with, relative to the site root: `.ttf`, `.otf`, or `.woff`. No system font is ever used. |

Without `social`, no image is drawn and nothing is written.

## The template

A template is a fixed 1200 by 630 SVG. A `<text data-slot="title">` element is a slot that the page's field of that name
fills. A slot may name `title`, `description`, `site`, or any string front matter key.

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#0f172a"/>
  <text data-slot="title" x="80" y="260" data-width="1040" font-size="72" data-min-size="48"
        data-max-lines="3" fill="#ffffff" font-family="Inter">Title</text>
  <text data-slot="site" x="80" y="560" data-width="800" font-size="32" fill="#94a3b8" font-family="Inter">Site</text>
</svg>
```

| Attribute | Meaning | Default |
| --- | --- | --- |
| `x`, `y` | The box's left edge and the first line's baseline. | |
| `data-width` | The box's width. | |
| `font-size` | The largest size. | |
| `data-min-size` | The smallest size; text shrinks to fit before it wraps further. | the largest |
| `data-max-lines` | The most lines. | `1` |
| `data-line-height` | Line height as a ratio. | `1.25` |
| `data-align` | `start`, `center`, or `end`, where `start` is the side the text is read from. | `start` |

Every other attribute, such as `fill` or `font-family`, is copied onto the lines drawn. The element's own text is a
placeholder and is replaced. A template that could reach outside the site (a `<script>`, a `<foreignObject>`, an
external `href`), run code, or change size is refused, and each reason is reported.

## Fonts and right-to-left text

Text is shaped with its own engine, so Arabic-script joining and right-to-left order are correct. Declare one font per
script and list the families in the slot's `font-family`. Two files of the same family and weight hide each other. A
`.woff2` file is not accepted. A character that no declared font has is reported as `social.missing-glyph`.

## Files written

One PNG per page under `assets/social/`, named from the page's URL. The head's `og:image`, `og:image:width`, and
`og:image:height` point at it. A page's own `image` front matter wins over the generated one. Unchanged pages are drawn
from a cache, so a rebuild draws only what changed.

## Findings

| Id | Meaning |
| --- | --- |
| `social.template-missing`, `social.template-invalid` | The template is not there, or breaks a rule above. |
| `social.font-missing`, `social.font-format`, `social.font-outside` | A declared font is absent, not a supported format, or outside the site. |
| `social.missing-glyph` | A character in the text has no glyph in any declared font. |
| `social.truncated` | A slot's text was too long and ends with an ellipsis. |
| `social.worker-failed`, `social.images` | Drawing failed, or the run's summary of images drawn, reused, and shared. |

See [Data findings](/data/validation/).
