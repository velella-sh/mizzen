export default {
  srcDir: "docs",
  base: "/beacon/",
  title: "Beacon",
  locales: {
    root: { label: "English", lang: "en" },
    fa: { label: "Persian", lang: "fa", themeConfig: { nav: [{ text: "خانه", link: "/fa/" }] } },
  },
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/page" },
      { text: "External", link: "https://example.com" },
    ],
    sidebar: { "/guide/": [{ text: "Guide", items: [{ text: "Page", link: "/guide/page" }] }] },
  },
  rewrites: { "guide/page.md": "handbook/page.md" },
};
