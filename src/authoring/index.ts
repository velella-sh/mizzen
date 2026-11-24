/**
 * Coverage-driven authoring (#1407-#1416): gaps to tasks, a page-type recommendation, an evidence-first outline,
 * export to an external agent, citation and unknown validation, a location plan with conflicts, a preview with a write
 * gate, verification, and a pull-request proposal.
 *
 * Every function is deterministic and local. Draft generation happens outside the engine; no function here calls a
 * model, opens a pull request, or merges one.
 */
export { authoringTasksOf, authoringTaskFor, authoringSnapshot, taskNeedsEvidence, AUTHORING_CHECKS, type AuthoringTaskOptions, type AuthoringTaskResult } from "./tasks.ts";
export { defaultPurpose, recommendPageType } from "./type.ts";
export { limitationsOf, outlineOf, sectionsNeedingEvidence, type AuthoringOutlineInput } from "./outline.ts";
export { authoringExportOf, type AuthoringExportOptions, type AuthoringExportResult } from "./export.ts";
export { claimsIn, citationsIn, isNormativeClaim, parseAuthoringDraft, renderDraftSource, validateAuthoringDraft } from "./draft.ts";
export { locationConflicts, navLinks, proposeLocation, slugSegment, takeLocation, takenLocations, urlWithoutBase, PAGE_TYPE_GROUP, PAGE_TYPE_ROOT, type TakenLocations } from "./location.ts";
export { authoringPreview, type AuthoringPreviewOptions } from "./preview.ts";
export { authoringVerify, type AuthoringVerifyOptions } from "./verify.ts";
export { authoringBranch, authoringProposalOf, type AuthoringProposalOptions } from "./proposal.ts";
export { writeAuthoringDraft, type AuthoringWriteOptions } from "./write.ts";
export { buildMergedSite, outputFileOf, removeMergedSite, type MergedSite, type MergedSiteOptions } from "./build.ts";