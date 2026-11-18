#!/usr/bin/env node
// A sample service for the API fetch example: one page-number endpoint and one cursor endpoint, 5 records each.
// Run it with `node fixtures/api-fetch/example/service.mjs`, then `mizzen data fetch` on a site in this folder.
import { createServer } from "node:http";

const records = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
  { id: "c", name: "Gamma" },
  { id: "d", name: "Delta" },
  { id: "e", name: "Epsilon" },
];
const size = 2;

function pageOf(page) {
  const start = (page - 1) * size;
  return records.slice(start, start + size);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const body = (value) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (url.pathname === "/page/items") {
    const page = Number(url.searchParams.get("page") ?? "1");
    body({ data: { items: pageOf(Number.isFinite(page) ? page : 1) } });
    return;
  }
  if (url.pathname === "/cursor/items") {
    const cursor = url.searchParams.get("cursor");
    if (cursor === null) return body({ data: { items: records.slice(0, 2) }, next: "p2" });
    if (cursor === "p2") return body({ data: { items: records.slice(2, 4) }, next: "p3" });
    if (cursor === "p3") return body({ data: { items: records.slice(4) }, next: null });
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unknown cursor" }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not found" }));
});

server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => {
  console.log(`ready ${server.address().port}`);
});
