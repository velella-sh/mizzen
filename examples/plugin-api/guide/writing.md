---
title: Write a plugin
description: One hook per example, and the rules every hook keeps.
layout: doc
---

# Write a plugin

A plugin is a `name` and any of the five hooks: `markdown`, `content`, `validate`, `model`, and `outputs`. Plugins run
in the order the code file lists them, and each hook receives what the hook before it returned.

## Validate a page

Return the findings; the build adds them with their own position. A hook that throws is `plugin.hook-failed` and names
the plugin and the stage.

## Transform Markdown

The `markdown` hook runs before parsing, so a transformed heading keeps its id and position. The text it returns must
have the same number of lines as the body it replaces.

## Write a custom output

The `outputs` hook receives every file the enabled outputs produced. Append files to add them, remove one to drop it,
and return the list. A path is relative to the output folder and never leaves it.
