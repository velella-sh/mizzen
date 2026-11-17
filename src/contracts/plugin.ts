import type { Page, Site } from "./content.ts";
import type { Diagnostic } from "./diagnostic.ts";
import type { OutputFile } from "./output.ts";

/** A value or a promise of one. */
export type MaybePromise<T> = T | Promise<T>;

/** A page's Markdown before parsing, as the markdown hook sees it. */
export interface MarkdownSource {
  /** The page path relative to the site root. */
  readonly path: string;
  /** The page body after includes, before parsing. */
  readonly markdown: string;
}

/** The hooks a plugin can implement. The engine runs each hook of every plugin in the order the code file lists them. */
export interface PluginHooks {
  /**
   * Called for each page in the Markdown stage, before parsing. The text it returns is parsed instead, and it must keep
   * the same line count so heading and diagnostic positions stay valid.
   */
  markdown?(source: MarkdownSource): MaybePromise<string>;
  /** Called for each page after its Markdown is parsed and before the site model is assembled. */
  content?(page: Page): MaybePromise<Page>;
  /** Called once per final page, after the content hook. Its findings are added to the build. */
  validate?(page: Page): MaybePromise<readonly Diagnostic[]>;
  /** Called once with the assembled site model, before rendering. */
  model?(site: Site): MaybePromise<Site>;
  /** Called once with the files the outputs produced, before they are written. */
  outputs?(files: readonly OutputFile[], site: Site): MaybePromise<readonly OutputFile[]>;
}

/** A plugin: a name for diagnostics and the hooks it implements. */
export interface Plugin extends PluginHooks {
  /** The plugin's name, shown in diagnostics; unique among the plugins of one site's code file. */
  readonly name: string;
  /**
   * The plugin's own version. A cached build is reused only while this stays the same, so bump it when the plugin's
   * behavior changes without its code or declared inputs changing.
   */
  readonly version?: string;
  /** Settings that shape the plugin's output; a change retires a cached build. Compared by JSON value, not by identity. */
  readonly settings?: unknown;
  /**
   * The site-relative files the plugin reads, with `/` separators. Their bytes are part of the build cache key, so a
   * change rebuilds. A plugin that omits this list declares that its inputs cannot be tracked, and every build of a
   * site that lists it runs cold; `[]` declares that it reads no file.
   */
  readonly inputs?: readonly string[];
}

/** What the site's code file default-exports: plugins and nothing else. */
export interface CodeConfig {
  /** Plugins, applied in order. */
  readonly plugins: readonly Plugin[];
}
