---
title: Components by status
layout: doc
list:
  collection: components
  sort: [name]
  group: { field: status, order: key }
  fields: [name, status]
  expand:
    field: status
    permalink: "/status/{value|slug}/"
    title: "Status {value}"
---
# Components by status

Each status has its own page.
