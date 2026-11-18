/** The package's type-only surface: every contract a consumer may import, re-exported from its own module. */
export type { SourcePos } from "./source.ts";
export type { Diagnostic, DiagnosticFix, Severity } from "./diagnostic.ts";
export type { AnalyticsConfig, ApiCollectionConfig, ApiConfig, ApiVersionConfig, AnalyticsProvider, CalendarConfig, CalendarEventConfig, VerifyConfig, ChangelogEventType, CollectionChangelogConfig, CollectionConfig, CollectionIndexConfig, CollectionJsonConfig, CollectionRawConfig, CollectionSearchConfig, CollectionSeoConfig, CollectionViewConfig, DataLimitsConfig, DatesConfig, DefaultsEntry, DerivedBandConfig, DerivedBandsConfig, DerivedCountConfig, DerivedKind, DerivedRuleConfig, Direction, DriftConfig, ExamplesConfig, FeedConfig, FeedFormat, FeedWindowConfig, LanguageConfig, NetworkConfig, QualityConfig, QualityException, QualityRule, QualityRuleKind, RepositoryConfig, SearchConfig, SiteConfig, SnapshotConfig, SocialConfig, StaleConfig, ThemeConfig } from "./config.ts";
export type { CalendarLink, ChangeEvent, Collection, CollectionSnapshot, DataRecord, DataStats, ListGroup, ListPagination, ListProps, PageRecord, RecordPos, RecordProps, RecordRelations, RelatedRecord } from "./data.ts";
export type { AgentInstructions, FrontMatter, Heading, Page, PageKind, PageStale, PageStaleFile, PageStatus, Site } from "./content.ts";
export type { NavGroup, NavItem, NavLink, NavTree, Pager, Trail } from "./nav.ts";
export type { Output, OutputBuild, OutputContext, OutputFile } from "./output.ts";
export type { Chrome, ChromeProps, Component, ComponentProps, Head, Island, Layout, LayoutProps, LinkTag, MetaTag, RenderHints, RenderNode, ScriptTag } from "./render.ts";
export type { CodeConfig, MarkdownSource, MaybePromise, Plugin, PluginHooks } from "./plugin.ts";
export type { ContextConstraints, ContextRequest, ContextRequestProblem, ContextRequestResult, EvidenceRequirement, TaskIntent, TaskKind, TokenBudget, VersionRange } from "./context-request.ts";
export type { EditAuditCheck, EditAuditCheckStatus, EditAuditOutcome, EditAuditPlan, EditAuditRecord, EditAuditSpan, EditAuditVerification, EditAuditVersion } from "./edit-audit.ts";
export type { NetworkProject, SiteNetwork } from "./network.ts";
