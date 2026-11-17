---
title: Valid annotations
---

```ts annotations={1: reads the token once | 3-4: `connect` retries on a timeout | 5: logs a or b \| c}
const token = read();
const client = connect(token);
const first = await client.scan();
const second = await client.scan();
log(first, second);
```
