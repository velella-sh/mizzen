/**
 * Blog routes: the public post pages, the archive, and one page per author, planned from the `blog` block in
 * `docs/blog.md`.
 *
 * Nothing here reads a file or the clock: the post sources and the authors map come in, the routes and the findings
 * come out. Posts sort by date descending and then by slug in code-point order, so two posts on the same day keep the
 * same order on every build. A draft is validated and never gets a route, a place in the archive, or an author page.
 */
import { basename, extname } from "node:path";
import type { BlogConfig, Diagnostic, SourcePos } from "../../contracts/index.ts";
import { keyPositionOf } from "../../data/lists.ts";
import { slugOf } from "../../data/slug.ts";
import { sortDiagnostics } from "../../pipeline/diagnostics.ts";
import { parseFrontMatter } from "../frontmatter.ts";

export type { BlogConfig } from "../../contracts/index.ts";

/** One post source to plan. */
export interface BlogPostSource {
  /** Path of the file relative to the site root, `/`-separated; the default slug and diagnostics read it. */
  readonly file: string;
  /** The whole file, front matter included. */
  readonly text: string;
}

/** A public post, as its route and as the archive and author lists carry it. */
export interface BlogPost {
  /** The source file, relative to the site root. */
  readonly file: string;
  /** Front matter `title`, else the file name without its extension. */
  readonly title: string;
  /** The calendar date, `YYYY-MM-DD`. */
  readonly date: string;
  /** The author id, a key of `_data/authors.yml`. */
  readonly author: string;
  /** The URL segment: front matter `slug`, else the slug form of the file name. */
  readonly slug: string;
  /** The public URL, including `base`. */
  readonly url: string;
  /** Front matter `description`, when it has one. */
  readonly description?: string;
}

/** One author from `_data/authors.yml`, with its id and every key the file writes. */
export interface BlogAuthor {
  /** The map key the posts name. */
  readonly id: string;
  /** The display name; the only required key. */
  readonly name: string;
  /** Any other key, passed to the layout unchanged. */
  readonly [key: string]: unknown;
}

/** One public route the planner built. */
export type BlogRoute =
  | { readonly kind: "post"; readonly url: string; readonly post: BlogPost }
  | { readonly kind: "archive"; readonly url: string; readonly posts: readonly BlogPost[] }
  | {
      readonly kind: "author";
      readonly url: string;
      readonly author: BlogAuthor;
      readonly posts: readonly BlogPost[];
    };

/** Options of {@link buildBlogRoutes}. */
export interface BlogRoutesOptions {
  /** The site's `blog` block. */
  readonly config: BlogConfig;
  /** Site `base`: `""` or a `/docs`-shaped prefix without a trailing slash. */
  readonly base?: string;
  /** The post sources, in any order. */
  readonly posts: readonly BlogPostSource[];
  /** `_data/authors.yml`, as a map from author id to its record. */
  readonly authors: Readonly<Record<string, unknown>>;
}

/** What {@link buildBlogRoutes} planned. */
export interface BlogRoutesResult {
  /** The post routes newest first, then the archive, then the author routes by id. */
  readonly routes: readonly BlogRoute[];
  /** Findings in file, line, column, then id order. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function owns(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isMapping(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A source segment with its outer slashes removed, or `undefined` when it is empty. */
function segment(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim().replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? undefined : trimmed;
}

/** Site `base` with exactly one leading slash and no trailing one. */
function baseOf(base: string | undefined): string {
  const trimmed = (base ?? "").trim().replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? "" : `/${trimmed}`;
}

function urlOf(base: string, ...parts: readonly string[]): string {
  return `${base}/${parts.join("/")}/`;
}

/** The file name without its extension, as a title: `posts/one-more-day.md` becomes `one-more-day`. */
function fileTitle(file: string): string {
  return basename(file, extname(file));
}

/** The default slug: the file name in its URL-safe form. */
function fileSlug(file: string): string {
  return slugOf(fileTitle(file));
}

/** True for a real calendar date written `YYYY-MM-DD`; a clock is never read. */
function isDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

function titleOf(value: unknown, file: string): string {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    if (text !== "") return text;
  }
  return fileTitle(file);
}

function at(file: string, line = 1): SourcePos {
  return { file, line, column: 1, endLine: line, endColumn: 1 };
}

function error(id: string, message: string, pos: SourcePos, help: string): Diagnostic {
  return { id, severity: "error", message, pos, help };
}

/** Plans the public routes of a blog and reports every post and author that cannot be public. */
export function buildBlogRoutes(options: BlogRoutesOptions): BlogRoutesResult {
  const base = baseOf(options.base);
  const routeName = segment(options.config.route) ?? "blog";
  const archiveName = segment(options.config.archive) ?? "archive";
  const authors = options.authors;
  const knownAuthors = Object.keys(authors).sort(byCodePoint);
  const diagnostics: Diagnostic[] = [];
  const posts: BlogPost[] = [];
  const authorById = new Map<string, BlogAuthor>();
  const claimedSlugs = new Map<string, string>();

  for (const source of [...options.posts].sort((a, b) => byCodePoint(a.file, b.file))) {
    const frontMatter = parseFrontMatter(source.text, source.file);
    diagnostics.push(...frontMatter.diagnostics);
    if (frontMatter.diagnostics.some((found) => found.severity === "error")) continue;
    const data = frontMatter.data;
    const start = at(source.file);
    let valid = true;

    const date = typeof data.date === "string" ? data.date.trim() : "";
    const datePos = keyPositionOf(source.text, source.file, "date") ?? start;
    if (date === "") {
      diagnostics.push(error("blog.missing-date", `The post ${source.file} has no \`date\`.`, datePos, "Add `date: YYYY-MM-DD` to the front matter."));
      valid = false;
    } else if (!isDate(date)) {
      diagnostics.push(error("blog.invalid-date", `The post ${source.file} has the date "${date}", which is not a calendar date.`, datePos, "Write the date as `YYYY-MM-DD`."));
      valid = false;
    }

    const authorId = typeof data.author === "string" ? data.author.trim() : "";
    const authorPos = keyPositionOf(source.text, source.file, "author") ?? start;
    let author: BlogAuthor | undefined;
    if (authorId === "") {
      diagnostics.push(error("blog.missing-author", `The post ${source.file} has no \`author\`.`, authorPos, "Add `author: <id>` naming an entry in `_data/authors.yml`."));
      valid = false;
    } else if (!owns(authors, authorId)) {
      const help = knownAuthors.length === 0
        ? "Add the author to `_data/authors.yml`."
        : `Add "${authorId}" to \`_data/authors.yml\`, or name one of: ${knownAuthors.join(", ")}.`;
      diagnostics.push(error("blog.unknown-author", `The post ${source.file} names the author "${authorId}", which is not in _data/authors.yml.`, authorPos, help));
      valid = false;
    } else {
      const record = authors[authorId];
      const name = isMapping(record) ? record["name"] : undefined;
      if (!isMapping(record) || typeof name !== "string" || name.trim() === "") {
        diagnostics.push(error("blog.invalid-author", `The author "${authorId}" in _data/authors.yml has no \`name\`.`, authorPos, `Give "${authorId}" a non-empty \`name\`.`));
        valid = false;
      } else {
        author = { ...record, id: authorId, name };
      }
    }

    let slug = fileSlug(source.file);
    const rawSlug = data.slug;
    const slugPos = keyPositionOf(source.text, source.file, "slug") ?? start;
    if (rawSlug !== undefined) {
      if (typeof rawSlug !== "string" || rawSlug.trim() === "" || /[/\\]/.test(rawSlug)) {
        diagnostics.push(error("blog.invalid-slug", `The post ${source.file} has a \`slug\` that is not one URL segment.`, slugPos, "Write `slug` as one segment with no slash."));
        valid = false;
      } else {
        slug = rawSlug.trim();
      }
    } else if (slug === "") {
      diagnostics.push(error("blog.invalid-slug", `The post ${source.file} has no usable file name for a slug.`, slugPos, "Add a `slug` to the front matter."));
      valid = false;
    }

    let draft = false;
    if (data.draft !== undefined) {
      if (typeof data.draft !== "boolean") {
        diagnostics.push(error("blog.invalid-draft", `The post ${source.file} has a non-boolean \`draft\`.`, keyPositionOf(source.text, source.file, "draft") ?? start, "Write `draft: true` or `draft: false`."));
        valid = false;
      } else {
        draft = data.draft;
      }
    }

    if (!valid || author === undefined) continue;

    const first = claimedSlugs.get(slug);
    if (first !== undefined) {
      diagnostics.push(error("blog.duplicate-slug", `Two posts use the slug "${slug}": ${first} and ${source.file}.`, slugPos, "Give one post a different `slug`, or rename its file."));
      continue;
    }
    claimedSlugs.set(slug, source.file);

    if (draft) continue;

    if (slug === archiveName) {
      diagnostics.push(error("blog.route-collision", `The post ${source.file} would be written over the archive at ${urlOf(base, routeName, archiveName)}.`, slugPos, `Give the post another \`slug\`, or set \`blog.archive\` to a different segment than "${archiveName}".`));
      continue;
    }

    const description = typeof data.description === "string" && data.description.trim() !== ""
      ? data.description
      : undefined;
    posts.push({
      file: source.file,
      title: titleOf(data.title, source.file),
      date,
      author: authorId,
      slug,
      url: urlOf(base, routeName, slug),
      ...(description === undefined ? {} : { description }),
    });
    authorById.set(authorId, author);
  }

  posts.sort((a, b) => (a.date === b.date ? byCodePoint(a.slug, b.slug) : a.date < b.date ? 1 : -1));

  const routes: BlogRoute[] = posts.map((post) => ({ kind: "post", url: post.url, post }));
  routes.push({ kind: "archive", url: urlOf(base, routeName, archiveName), posts });
  if (options.config.authors !== false) {
    for (const id of [...authorById.keys()].sort(byCodePoint)) {
      routes.push({
        kind: "author",
        url: urlOf(base, routeName, "authors", id),
        author: authorById.get(id)!,
        posts: posts.filter((post) => post.author === id),
      });
    }
  }

  return { routes, diagnostics: sortDiagnostics(diagnostics) };
}
