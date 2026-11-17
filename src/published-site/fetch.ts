export const REDIRECT_HOP_LIMIT = 5;

export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RedirectFinding {
  readonly id:
    | "published-site.domain"
    | "published-site.redirect-mismatch"
    | "published-site.redirect-loop"
    | "published-site.redirect-chain";
  readonly severity: "error";
  readonly url: string;
  readonly message: string;
  readonly expected?: string;
  readonly actual?: string;
}

export interface FollowedResponse {
  readonly response: Response;
  readonly final: string;
  readonly finding?: RedirectFinding;
}

function hostnameOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

function normalize(address: string, base: string): string {
  const url = new URL(address, base);
  url.hash = "";
  return url.href;
}

export async function fetchFollowingRedirects(
  url: string,
  domain: string,
  init: RequestInit,
  fetcher: FetchLike,
): Promise<FollowedResponse> {
  const source = normalize(url, url);
  const visited = new Set([source]);
  let current = source;
  let hops = 0;
  for (;;) {
    const response = await fetcher(current, { ...init, redirect: "manual" });
    const location = isRedirectStatus(response.status) ? response.headers.get("location") : null;
    if (location === null) return { response, final: current };

    let next: string;
    try {
      next = normalize(location, current);
    } catch {
      return {
        response,
        final: current,
        finding: {
          id: "published-site.redirect-mismatch",
          severity: "error",
          url: current,
          message: `The redirect from ${current} names an invalid location ${JSON.stringify(location)}.`,
          actual: location,
        },
      };
    }
    const host = hostnameOf(new URL(next));
    if (host !== domain) {
      return {
        response,
        final: current,
        finding: {
          id: "published-site.domain",
          severity: "error",
          url: next,
          message: `The redirect from ${current} leaves the allowed domain ${domain} for ${next}.`,
          expected: domain,
          actual: host,
        },
      };
    }
    if (visited.has(next)) {
      return {
        response,
        final: current,
        finding: {
          id: "published-site.redirect-loop",
          severity: "error",
          url: source,
          message: `The redirect from ${current} returns to ${next}, which was already visited.`,
          actual: next,
        },
      };
    }
    if (hops === REDIRECT_HOP_LIMIT) {
      return {
        response,
        final: current,
        finding: {
          id: "published-site.redirect-chain",
          severity: "error",
          url: source,
          message: `The redirect chain from ${source} is longer than ${REDIRECT_HOP_LIMIT} hops; it reached ${current}.`,
          actual: current,
        },
      };
    }
    visited.add(next);
    current = next;
    hops++;
  }
}
