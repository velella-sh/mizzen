/**
 * Which projects of the network the world may see. The network file's `public` flag decides, and nothing else: a
 * project is never hidden by its URL. Every shared output (the theme's project list, the merged search, the sitemap
 * index) reads its projects through here, so one flag changes them all together.
 */

/** True when the project is listed in shared outputs. */
export function isPublicProject(project: { readonly public: boolean }): boolean {
  return project.public;
}

/** The public projects, in their given order. */
export function publicProjects<T extends { readonly public: boolean }>(projects: readonly T[]): readonly T[] {
  return projects.filter(isPublicProject);
}
