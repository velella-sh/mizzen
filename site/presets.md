---
title: Presets and Theme Studio
description: Pick a Lateen preset, override single brand values, try them in Theme Studio, and give a Velella project its family identity.
layout: doc
permalink: /presets/
---

# Presets and Theme Studio

Lateen `0.2.5` lets a site change its look with a few lines in `mizzen.yml` instead of a forked theme. Mizzen hands `theme.options` to the theme unread; Lateen validates it, derives every dependent color at build time, and holds every preset to the same contrast test in light and dark.

## Choose a preset

A preset is a starting point. Name it in `theme.options.preset`:

```yaml
theme:
  options:
    preset: harbor
```

| Preset | Character |
| --- | --- |
| `clay` | Warm, roomy, and rounded, with an earth accent. |
| `graphite` | Grey, dense, and square, for reference-heavy sites. |
| `harbor` | Cool and calm, with a blue accent. |
| `orchard` | Green with compact corners, for guides and handbooks. |
| `plum` | A soft violet accent. |
| `mizzen`, `lateen`, `offing`, `ebb` | The Velella family: shared page, panel, and text colors, and one accent for each product. |

This site uses `mizzen`.

## Override single values

`brand` overrides single values on top of a preset. A value the brand sets wins; a value neither sets keeps the theme's own.

```yaml
theme:
  options:
    preset: harbor
    brand:
      accent: "#0b6e4f"
      radius: small
      density: compact
```

The keys are `accent`, `neutral`, `fonts`, `radius` (`none`, `small`, `medium`, `large`), and `density` (`compact`, `comfortable`). Custom fonts are self-hosted: a font from another origin is refused instead of loaded. See [Brand options](https://velella.sh/lateen/brand-options/) for the full list and the contrast rule.

## Try it in Theme Studio

[Theme Studio](https://velella.sh/lateen/theme-studio/) shows a live sample. Try a preset, a color, or a font, then copy the generated `preset` and `brand` keys into `theme.options`. If you chose a different font, download the file and put it at the path shown, relative to the site root.

After you paste the settings, run the check from the site folder:

```sh
npx mizzen check .
```

The theme validates `theme.options` against its own schema, so a misspelled key is reported by the build.

## A Velella family site

For another project in the family, use the family preset that matches the project and the shared project list:

```yaml
network:
  source: https://velella.sh/network.json
  project: mizzen
theme:
  options:
    preset: mizzen
    network:
      search: false
```

The preset sets the colors. The network lock gives the project switcher and the network footer their entries, and `network.search: false` keeps each site's search on its own index instead of reaching into other projects. A manifest-based [lock refresh](/network/) needs every listed project to publish its page manifest.

Lateen also documents README badges for the four family projects, using shared dark labels and each product's accent. See [Presets](https://velella.sh/lateen/presets/) for the badge snippets.

## Related

- [Lateen 0.2.5](/theme/): what else changes after the upgrade.
- [Configuration](/config/): where `theme.options` sits in `mizzen.yml`.
- [Several projects](/network/): the network file and the lock.
