/**
 * The task-context contract: entry points, their transitive dependencies, sourced fragments, what
 * was left out and why, token accounting, answerability, and the request a gap turns into.
 *
 * Every fragment carries the exact file, span, block or record id, and build snapshot it came from,
 * so a claim can be traced to the same text the build wrote. Omitted inputs carry one of four
 * reasons and never appear as fragments. Private fields appear in neither.
 */
import type { ContextRequest, TaskKind } from "../contracts/context-request.ts";
import type { BlockReference, SourcePos } from "../contracts/index.ts";

/** What one selected graph node stands for. */
export type ContextEntryKind =
  | "page"
  | "block"
  | "record"
  | "collection"
  | "symbol"
  | "file"
  | "include"
  | "api"
  | "check"
  | "lineage"
  | "evidence"
  | "field";

/** One directly relevant page, block, record, collection, symbol, or file, and why it was chosen. */
export interface ContextEntry {
  /** The graph node id, so the selection names one node of one snapshot. */
  readonly id: string;
  readonly kind: ContextEntryKind;
  /** A readable name, from the page title, block id, record id, or symbol name. */
  readonly label: string;
  /** Why the entry point was selected, such as `scope.page`, `goal.match`, or `acceptance.review`. */
  readonly reason: string;
  /** Where the entry was read from, when the node has a source position. */
  readonly pos?: SourcePos;
  /** The page or API URL the entry publishes, when it has one. */
  readonly url?: string;
}

/** One edge the closure followed, so a refill can explain why a new fragment appeared. */
export interface ContextDependency {
  readonly from: string;
  readonly to: string;
  /** The graph edge kind, such as `links`, `includes`, `renders`, `documents`, or `checks`. */
  readonly edge: string;
  /** The stable reason code, such as `dependency.link` or `dependency.data`. */
  readonly reason: string;
  readonly pos?: SourcePos;
}

/** Why an input is not in the pack. Private fields are never named here. */
export type ContextOmissionReason = "budget" | "permission" | "scope" | "irrelevance";

/** One input that is not in the pack, with the exact reason. */
export interface ContextOmission {
  /** The reference or node id that was left out. */
  readonly ref: string;
  /** What it is, so a reader can act without guessing. */
  readonly kind: ContextEntryKind | "fragment" | "task";
  readonly reason: ContextOmissionReason;
  /** One sentence naming what happened and what would change it. */
  readonly detail: string;
  /** The references the omitted fragment would have answered, so a gap can be tied to a criterion. */
  readonly answers?: readonly string[];
}

/** The precise origin of one fragment: the same text the build wrote, at the same place. */
export interface ContextSourceMeta {
  /** The source path, relative to the site root, with forward slashes. */
  readonly file: string;
  /** `path:line:column-endLine:endColumn`. */
  readonly span: string;
  /** The block id, when the fragment is one block or one heading section. */
  readonly block?: string;
  /** The record id, when the fragment is a data record. */
  readonly record?: string;
  /** The build identity the text was read from. */
  readonly snapshot: string;
}

/** One sourced piece of context. */
export interface ContextFragment {
  /** Stable id: `page:<source>`, `block:<id>`, `record:<collection>/<id>`, or `lineage:<...>`. */
  readonly id: string;
  readonly kind: ContextEntryKind | "page" | "block";
  readonly title: string;
  /** The exact Markdown the build's source produced for this fragment. */
  readonly content: string;
  readonly source: ContextSourceMeta;
  /** The estimator's count for {@link content}. */
  readonly tokens: number;
  /** Why the fragment is in the pack: `scope.block`, `dependency.link`, `lineage.rule`, and the like. */
  readonly reason: string;
  /** The entries or dependency ids that pulled the fragment in, in closure order. */
  readonly via: readonly string[];
  /** The task references this fragment answers, for answerability. */
  readonly refs: readonly string[];
}

/** One stored reference resolved against this build, including a moved or removed block. */
export interface ContextReference {
  readonly block: string;
  /** The page the reference was recorded against; `""` when the lock never saw it. */
  readonly page: string;
  readonly status: "resolved" | "removed" | "unknown";
  readonly url?: string;
  readonly source?: string;
  readonly moved?: boolean;
}

/** What one acceptance criterion's evidence looks like in this pack. */
export interface ContextCriterionAnswer {
  readonly id: string;
  readonly statement: string;
  readonly satisfied: boolean;
  /** The references the statement names, or the whole scope when it names none. */
  readonly evidence: readonly string[];
  /** The references with no fragment; empty when satisfied. */
  readonly shortage: readonly string[];
}

/** Whether the pack can answer the task, and exactly what is missing when it cannot. */
export interface ContextAnswerability {
  readonly complete: boolean;
  readonly criteria: readonly ContextCriterionAnswer[];
  /** Every missing reference, in criterion order, without repeats. */
  readonly shortages: readonly string[];
}

/** What a gap asks the caller to do, so the agent never guesses a source. */
export interface ContextRequestAction {
  /** `scope` to widen the task, `approval` to raise the budget or grant access, `evidence` to supply an input. */
  readonly kind: "scope" | "approval" | "evidence";
  /** The reference or resource the request is about. */
  readonly ref: string;
  /** Why it is missing, in one sentence. */
  readonly detail: string;
  /** The concrete action that would unblock the pack. */
  readonly action: string;
}

/** The token accounting of one compiled pack, split so no cost is hidden. */
export interface ContextAccounting {
  readonly requested: number;
  /** The sum of the selected fragments' own estimates. */
  readonly fragments: number;
  /** The title, headings, and separators of the Markdown template. */
  readonly template: number;
  /** The estimator margin the final serialization carries. */
  readonly safety: number;
  /** `fragments + template + safety`; the number to compare with client-reported usage. */
  readonly used: number;
  readonly remaining: number;
  /** `used` grown by the documented estimator margin, rounded up. */
  readonly upper: number;
  readonly method: string;
  readonly margin: number;
  /** One entry per selected fragment, in pack order. */
  readonly perFragment: readonly { readonly id: string; readonly tokens: number }[];
}

/** The deterministic cache identity and the inputs that invalidate it. */
export interface ContextCache {
  /** SHA-256 over the task request, build snapshot, budget, and selected fragment ids. */
  readonly key: string;
  /** Sorted source paths, record ids, and references the pack read. */
  readonly dependencies: readonly string[];
}

/** A compiled task context. */
export interface CompiledContext {
  readonly version: 1;
  /** The documentation build identity, also repeated on every fragment. */
  readonly snapshot: string;
  /** The task's input snapshot id, so a refill can tell an unchanged task from unchanged docs. */
  readonly taskSnapshot: string;
  readonly task: {
    readonly idempotencyKey: string;
    readonly goal: string;
    readonly kind: TaskKind;
  };
  /** The request the task became; the same shape `mizzen pack --request` reads. */
  readonly request: ContextRequest;
  /** The directly relevant entry points, in reason order. */
  readonly entries: readonly ContextEntry[];
  /** The dependency edges the closure followed, in discovery order. */
  readonly dependencies: readonly ContextDependency[];
  readonly fragments: readonly ContextFragment[];
  readonly omitted: readonly ContextOmission[];
  /** The task's block references resolved against this build. */
  readonly references: readonly ContextReference[];
  /** Blocks the lock recorded that the build no longer has, by id. */
  readonly removedReferences: readonly string[];
  readonly accounting: ContextAccounting;
  readonly answerability: ContextAnswerability;
  readonly requests: readonly ContextRequestAction[];
  readonly cache: ContextCache;
  /** The decisions in effect for this task, as active rules, and the history that is not active. */
  readonly decisions?: import("../decisions/context.ts").ContextDecisions;
  /** The ready-to-paste Markdown pack. */
  readonly markdown: string;
}

/** A stored reference plus the page the lock recorded it on, if any. */
export interface TaskBlockReference extends BlockReference {
  readonly source?: string;
}
