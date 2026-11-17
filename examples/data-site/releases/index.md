---
title: Releases
layout: doc
list:
  collection: releases
  sort: [date desc]
  group: { field: date, by: month }
  perPage: 5
  fields: [id, date, status, component]
---
# Releases

::data-table{from=releases columns="id,date,status,component" sort=date}
