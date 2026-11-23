import { directionFromLang } from "../content/lang.ts";
import type { Page, PreparedReport, ReportPagination, ReportView, SiteConfig, SourcePos } from "../contracts/index.ts";
import { escapeAttribute } from "../outputs/search-shared.ts";
import { ROWS_PER_REPORT_PAGE } from "./prepare.ts";

function tablePages(url: string, count: number) {
  const pages = Math.max(1, Math.ceil(count / ROWS_PER_REPORT_PAGE));
  const urlOf = (page: number) => page === 1 ? url : `${url}page/${page}/`;
  return Array.from({ length: pages }, (_, index): { url: string; pagination: ReportPagination } => ({
    url: urlOf(index + 1),
    pagination: {
      start: index * ROWS_PER_REPORT_PAGE,
      end: Math.min((index + 1) * ROWS_PER_REPORT_PAGE, count),
      page: index + 1,
      pages,
      ...(index > 0 ? { previous: urlOf(index) } : {}),
      ...(index + 1 < pages ? { next: urlOf(index + 2) } : {}),
    },
  }));
}

/** Plans ordinary docs pages with a data link usable by any theme and typed view data for report-aware themes. */
export function buildReportPages(report: PreparedReport, config: SiteConfig, source: SourcePos): Page[] {
  const description = "Published check results";
  const markdown = `[Download report data (JSON)](${report.jsonUrl})\n`;
  const html = `<p><a href="${escapeAttribute(report.jsonUrl)}">Download report data (JSON)</a></p>`;
  const create = (url: string, title: string, reportView: ReportView): Page => ({
    url, title, source, reportView,
    frontMatter: { title, description, layout: "doc", agent: { edit: false, source: source.file } },
    lang: config.lang,
    dir: directionFromLang(config.lang),
    headings: [],
    markdown, html, kind: "doc",
  });

  return [
    create(report.url, report.title, { kind: "overview" }),
    ...report.runs.flatMap((run) => tablePages(run.url, run.findings.length).map(({ url, pagination }) =>
      create(url, pagination.page === 1 ? `Run ${run.id}` : `Run ${run.id}, page ${pagination.page}`,
        { kind: "run", id: run.id, ...pagination }))),
    ...report.comparisons.flatMap(({ base, head, url, changes }) =>
      tablePages(url, changes.length).map(({ url: pageUrl, pagination }) => {
        const title = `${base} → ${head}`;
        return create(pageUrl, pagination.page === 1 ? title : `${title}, page ${pagination.page}`,
          { kind: "comparison", base, head, ...pagination });
      })),
  ];
}
