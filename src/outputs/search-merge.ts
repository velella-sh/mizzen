import type { Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import { SEARCH_SCOPE } from "./search-shared.ts";

/** The folder of a search index below its project, when the network file names none. */
const DEFAULT_FOLDER = "pagefind";

/** The file that names the indexes the theme merges for the `all` scope, at the root of the output folder. */
export const SEARCH_MERGE_PATH = "pagefind-network.json";

/**
 * Lists the search indexes of the other public projects of the network, so the theme can search them next to this
 * project's own in the browser. Nothing of another project is copied into this build: the file holds addresses only.
 * A site with no `network` key, one whose search is off, and a project that is alone in the network write nothing.
 * A project that is not public is never listed.
 */
export const searchMerge: Output = {
  name: "search-merge",
  async run(site: Site, _ctx: OutputContext): Promise<readonly OutputFile[]> {
    const network = site.network;
    if (network === undefined || site.config.search === false) return [];
    const others = network.projects.filter((project) => !project.current);
    if (others.length === 0) return [];
    const index = (path: string, folder: string | undefined): string => `/${path}/${folder ?? DEFAULT_FOLDER}`;
    const current = network.projects.find((project) => project.current);
    const record = {
      version: 1,
      scope: { parameter: SEARCH_SCOPE.parameter, values: [SEARCH_SCOPE.project, SEARCH_SCOPE.all], default: SEARCH_SCOPE.project },
      project: current === undefined ? undefined : { id: current.id, title: current.title, index: index(current.path, current.search) },
      others: others.map((project) => ({ id: project.id, title: project.title, index: index(project.path, project.search) })),
    };
    return [{ path: SEARCH_MERGE_PATH, contents: `${JSON.stringify(record, null, 2)}\n` }];
  },
};
