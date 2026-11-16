import type { AnalyticsConfig, AnalyticsProvider } from "../contracts/config.ts";
import type { ScriptTag } from "../contracts/render.ts";

/**
 * The analytics tools a site can attach, in one table. Each entry holds the origin of the tool's script and builds
 * the script tag from the site's `analytics` key. The engine depends on none of them: it writes one tag and runs no
 * code of the tool's, collects nothing, and reads no network.
 */
interface ProviderEntry {
  /** The origin the script is loaded from when the site sets no `host`. `undefined` for `custom`. */
  readonly origin: string | undefined;
  /** Builds the tag, or `undefined` when a value the tool needs is missing. */
  script(config: AnalyticsConfig): ScriptTag | undefined;
  /** Every origin the tool contacts besides the page's own: the script's and the one that receives the hits. */
  contacts(config: AnalyticsConfig): readonly string[];
}

/** The origin of a URL (`scheme://host`), or `undefined` when it is not an absolute URL. */
export function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export const PROVIDERS: Readonly<Record<AnalyticsProvider, ProviderEntry>> = {
  goatcounter: {
    origin: "https://gc.zgo.at",
    script: (config) =>
      config.site === undefined
        ? undefined
        : {
            src: "https://gc.zgo.at/count.js",
            attrs: {
              "data-goatcounter": `${stripSlash(config.host ?? `https://${config.site}.goatcounter.com`)}/count`,
            },
          },
    contacts: (config) =>
      config.site === undefined ? [] : ["https://gc.zgo.at", originOf(config.host ?? `https://${config.site}.goatcounter.com`)!],
  },
  plausible: {
    origin: "https://plausible.io",
    script: (config) =>
      config.site === undefined
        ? undefined
        : { src: `${stripSlash(config.host ?? "https://plausible.io")}/js/script.js`, attrs: { "data-domain": config.site } },
    contacts: (config) => [originOf(config.host ?? "https://plausible.io")!],
  },
  umami: {
    origin: "https://cloud.umami.is",
    script: (config) =>
      config.site === undefined
        ? undefined
        : { src: `${stripSlash(config.host ?? "https://cloud.umami.is")}/script.js`, attrs: { "data-website-id": config.site } },
    contacts: (config) => [originOf(config.host ?? "https://cloud.umami.is")!],
  },
  cloudflare: {
    origin: "https://static.cloudflareinsights.com",
    script: (config) =>
      config.site === undefined
        ? undefined
        : {
            src: "https://static.cloudflareinsights.com/beacon.min.js",
            attrs: { "data-cf-beacon": JSON.stringify({ token: config.site }) },
          },
    contacts: () => ["https://static.cloudflareinsights.com", "https://cloudflareinsights.com"],
  },
  custom: {
    origin: undefined,
    script: (config) =>
      config.src === undefined ? undefined : { src: config.src, ...(config.attrs === undefined ? {} : { attrs: config.attrs }) },
    contacts: (config) => {
      const origin = config.src === undefined ? undefined : originOf(config.src);
      return origin === undefined ? [] : [origin];
    },
  },
};

/** The script tag of an `analytics` key, or `undefined` when the key lacks a value its provider needs. */
export function providerScript(config: AnalyticsConfig, label?: string): ScriptTag | undefined {
  const tag = PROVIDERS[config.provider].script(config);
  if (tag === undefined) return undefined;
  if (label === undefined) return tag;
  return { src: tag.src, attrs: { ...tag.attrs, "data-project": label } };
}

/** The outside origins the tool's script and hits use, sorted by code point and without repeats. */
export function providerOrigins(config: AnalyticsConfig): readonly string[] {
  return [...new Set(PROVIDERS[config.provider].contacts(config))].sort();
}
