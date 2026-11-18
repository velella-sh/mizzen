#!/usr/bin/env node
// A loopback JSON API for the refresh fixture. Set SCENARIO to unchanged, changed, or failed.
import { createServer } from "node:http";

const scenario = process.env.SCENARIO ?? "changed";
const records = {
  unchanged: [{ id: "alpha", name: "Alpha", note: "first" }],
  changed: [
    { id: "alpha", name: "Alpha Two", note: "first" },
    { id: "beta", name: "Beta", note: "second" },
  ],
  failed: [],
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (scenario === "failed") {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "source unavailable" }));
    return;
  }
  if (url.pathname !== "/items") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ data: { items: records[scenario] ?? records.changed } }));
});

server.listen(Number(process.env.PORT ?? 4317), "127.0.0.1", () => {
  console.log(`ready ${server.address().port} ${scenario}`);
});
