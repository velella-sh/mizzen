---
title: Guide
description: A page whose expected output can be corrected to make its example pass.
---

# A failing example to correct

The greeting below prints `hello`, but the expected output says `goodbye`; correcting the expected
text makes this example pass without any other change.

```js test id="greet"
console.log("hello");
```
```output
goodbye
```

# Passing example

```js test id="passes"
console.log("ok");
```
```output
ok
```

# An imported snippet

The block below takes its code from `lib/greeting.js`; editing that file changes the evidence.

```js test id="snippet" snippet="lib/greeting.js:3-3"
```
```output
from a snippet
```

# Setup and teardown

The setup block is hidden from the rendered page but still runs.

```js test id="setup" role="setup" hidden
import { writeFileSync } from "node:fs";
writeFileSync("prepared.txt", "ready");
```

```js test id="read"
import { readFileSync } from "node:fs";
console.log(readFileSync("prepared.txt", "utf8"));
```
```output
ready
```

# Shared session

```js test id="write" session="run"
import { writeFileSync } from "node:fs";
writeFileSync("state.txt", "shared");
```

```js test id="read-state" session="run"
import { readFileSync } from "node:fs";
console.log(readFileSync("state.txt", "utf8"));
```
```output
shared
```

# A runbook

```bash test id="one" role="step" runbook="checks"
echo first
```
```output
first
```

```bash test id="two" role="step" runbook="checks"
echo second
```
```output
second
```
