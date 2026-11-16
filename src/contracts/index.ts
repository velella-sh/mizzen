/** The package's type-only surface: every contract a consumer may import, re-exported from its own module. */
export type { SourcePos } from "./source.ts";
export type { Diagnostic, DiagnosticFix, Severity } from "./diagnostic.ts";
export type { AnalyticsConfig, ApiCollectionConfig, ApiConfig, ApiVersionConfig, AnalyticsProvider, VerifyConfig, CollectionConfig, CollectionIndexConfig, CollectionJsonConfig, CollectionRawConfig, CollectionSearchConfig, CollectionSeoConfig, CollectionViewConfig, DataLimitsConfig, DefaultsEntry, Direction, FeedConfig, FeedFormat, LanguageConfig, NetworkConfig, RepositoryConfig, SearchConfig, SiteConfig, SnapshotConfig, SocialConfig, ThemeConfig } from "./config.ts";
export type { Collection, CollectionSnapshot, DataRecord, DataStats, ListGroup, ListPagination, ListProps, PageRecord, RecordPos, RecordProps } from "./data.ts";
export type { AgentInstructions, FrontMatter, Heading, Page, PageKind, PageStatus, Site } from "./content.ts";
export type { NavGroup, NavItem, NavLink, NavTree, Pager, Trail } from "./nav.ts";
export type { Output, OutputBuild, OutputContext, OutputFile } from "./output.ts";
export type { Chrome, ChromeProps, Component, ComponentProps, Head, Island, Layout, LayoutProps, LinkTag, MetaTag, RenderHints, RenderNode, ScriptTag } from "./render.ts";
export type { CodeConfig, MaybePromise, Plugin, PluginHooks } from "./plugin.ts";
export type { ContextConstraints, ContextRequest, ContextRequestProblem, ContextRequestResult, EvidenceRequirement, TaskIntent, TaskKind, TokenBudget, VersionRange } from "./context-request.ts";
export type { EditAuditCheck, EditAuditCheckStatus, EditAuditOutcome, EditAuditPlan, EditAuditRecord, EditAuditSpan, EditAuditVerification, EditAuditVersion } from "./edit-audit.ts";
export type { NetworkProject, SiteNetwork } from "./network.ts";
