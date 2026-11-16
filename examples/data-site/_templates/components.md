---
title: "{name}"
description: "The {name} component."
layout: doc
---
# :field[name]

:field[summary]

Status: :field[status] · Released: :field[released] · Region: :field[region]

## Releases

:::records{from=releases where="component=slug" sort=date}
- Release :field[id], :field[date]
:::
