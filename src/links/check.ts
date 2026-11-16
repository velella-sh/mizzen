/**
 * The one place that decides whether a `[[project:path]]` link is sound, and says why not. A finding carries the file
 * and line of the link, so the author sees it where they wrote it. Pure: it reads the locked network and nothing else.
 */
import type { Diagnostic, SourcePos } from "../contracts/index.ts";
import type { LockedPage, LockedProject, NetworkLock } from "../network/lock.ts";

/** What a link resolves to. */
export interface ResolvedProjectLink {
  readonly project: LockedProject;
  readonly page: LockedPage;
  /** The URL of the page on the shared domain, such as `/blog/post/`. */
  readonly url: string;
}

/** The outcome of checking one link: its target when sound, and the findings either way. */
export interface ProjectLinkCheck {
  readonly resolved?: ResolvedProjectLink;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Looks up `projectId` and `path` in the lock. `currentId` is this site's project: a hidden project may link to
 * itself and to other hidden projects, a public one may not link to a hidden one.
 *
 * - `network.link-missing-project`: the id is not in the lock. An error.
 * - `network.link-hidden`: the target project is not public and the linking project is. An error.
 * - `network.link-missing-page`: the project has no such page in its locked page list. An error.
 * - `network.link-changed`: the page's hash changed in the latest `network update` and was not accepted. A warning.
 */
export function checkProjectLink(
  lock: NetworkLock,
  currentId: string,
  projectId: string,
  path: string,
  pos: SourcePos,
): ProjectLinkCheck {
  const project = lock.projects.find((candidate) => candidate.id === projectId);
  const address = `[[${projectId}:${path}]]`;
  if (project === undefined) {
    return {
      diagnostics: [{
        id: "network.link-missing-project",
        severity: "error",
        message: `${address} names the project "${projectId}", which the network lock does not list.`,
        help: `Use one of: ${lock.projects.filter((p) => p.public).map((p) => p.id).join(", ")}.`,
        pos,
      }],
    };
  }
  const current = lock.projects.find((candidate) => candidate.id === currentId);
  if (!project.public && current?.public !== false && project.id !== currentId) {
    return {
      diagnostics: [{
        id: "network.link-hidden",
        severity: "error",
        message: `${address} links to "${projectId}", a project that is not public.`,
        help: "A public project cannot point readers at a hidden one. Remove the link, or make the project public in the network file.",
        pos,
      }],
    };
  }
  const page = project.manifest?.pages.find((candidate) => candidate.path === path);
  if (page === undefined) {
    return {
      diagnostics: [{
        id: "network.link-missing-page",
        severity: "error",
        message: `${address} names a page that "${projectId}" does not list.`,
        help: project.manifest === undefined
          ? `The lock holds no page list for "${projectId}". Run \`mizzen network update\`.`
          : `Run \`mizzen network update\` if the page is new, or fix the path (pages look like "${project.manifest.pages[0]?.path ?? "/"}").`,
        pos,
      }],
    };
  }
  const resolved: ResolvedProjectLink = { project, page, url: `/${project.path}${page.path}` };
  if (page.previous !== undefined) {
    return {
      resolved,
      diagnostics: [{
        id: "network.link-changed",
        severity: "warning",
        message: `${address} points at a page whose content changed in the latest \`mizzen network update\`.`,
        help: "Check that the link still fits, then run `mizzen network update --accept`.",
        pos,
      }],
    };
  }
  return { resolved, diagnostics: [] };
}
