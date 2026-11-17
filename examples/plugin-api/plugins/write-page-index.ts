import type { OutputFile, Plugin } from "@velella/mizzen/contracts";

/** Adds a JSON index of the site's pages to the files the build writes. */
export const writePageIndex: Plugin = {
  name: "write-page-index",
  inputs: [],
  outputs(files, site) {
    const pages = site.pages.map((page) => ({ url: page.url, title: page.title }));
    const file: OutputFile = { path: "plugin-api/pages.json", contents: `${JSON.stringify(pages, null, 2)}\n` };
    return [...files, file];
  },
};
