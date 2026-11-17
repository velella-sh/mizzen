import { h } from "preact";
import type { Layout } from "../../../../src/contracts/index.ts";

// Keep the render host fixed so a Lateen update cannot rewrite the engine's compatibility baseline.
const doc: Layout = ({ page, head, trail, pager }) =>
  h("html", { lang: page.lang, dir: page.dir },
    h("head", null,
      h("title", null, head.title),
      ...head.meta.map((meta) => h("meta", { [meta.property ? "property" : "name"]: meta.name, content: meta.content })),
      ...head.links.map((link) => h("link", { rel: link.rel, href: link.href, ...link.attrs })),
      ...head.jsonLd.map((data) => h("script", { type: "application/ld+json", dangerouslySetInnerHTML: { __html: JSON.stringify(data) } })),
    ),
    h("body", null,
      h("nav", null, ...trail.map((item) => h("a", { href: item.url }, item.title))),
      h("main", { dangerouslySetInnerHTML: { __html: page.html } }),
      h("footer", null,
        pager.prev ? h("a", { rel: "prev", href: pager.prev.url }, pager.prev.title) : null,
        pager.next ? h("a", { rel: "next", href: pager.next.url }, pager.next.title) : null,
      ),
    ),
  );

export default doc;
