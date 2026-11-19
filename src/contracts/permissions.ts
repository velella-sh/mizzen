/**
 * The access policy contract: one versioned document that says what a task may read, write, run, reach over the
 * network, and publish, and which of those need a separate approval.
 *
 * The parser in `src/permissions/policy.ts` validates against `schema/access-policy.schema.json`, fills the
 * least-privilege defaults, and refuses a capability that names no usable grant. Every decision it produces names
 * the capability, the rule that allowed or denied it, and the approval used, so an audit line never paraphrases.
 */

/** What a task is allowed to do. Each capability is independent: one never implies another. */
export type AccessCapability = "read" | "write" | "execute" | "network" | "publish";

/** The stage a network destination is approved for. Build, verify, and replay are offline by default. */
export type AccessStage = "build" | "verify" | "replay" | "publish";

/** The semantic thing a read decision is about. */
export type AccessResourceKind = "page" | "block" | "collection" | "record" | "field" | "audience" | "other";

/** One read target, named by its stable id and the page or collection it belongs to. */
export interface AccessResource {
  readonly kind: AccessResourceKind;
  readonly id: string;
  /** The page URL, source path, or id the resource belongs to, when one does. */
  readonly page?: string;
  /** The collection name for a record, field, or collection resource. */
  readonly collection?: string;
  /** The field name for a field resource. */
  readonly field?: string;
  /** Audiences that must all be allowed; absent or empty means public. */
  readonly audiences?: readonly string[];
}

/** The read part: public pages, allowed audiences, and optional page, block, collection, and field allowlists. */
export interface AccessReadPolicy {
  /** Whether content without an audience is readable. Default `true`. */
  readonly public: boolean;
  /** Audiences the task may read; a resource with any other audience is denied. Empty means public only. */
  readonly audiences: readonly string[];
  /** Page allowlist: URLs, source paths, ids, or globs. Absent means every public page. */
  readonly pages?: readonly string[];
  /** Block allowlist. Absent means every block of a readable page. */
  readonly blocks?: readonly string[];
  /** Collection allowlist. Absent means no collection data; an empty list means none. */
  readonly collections?: readonly string[];
  /** Per-collection field allowlist. A collection left out publishes no field. */
  readonly fields?: Readonly<Record<string, readonly string[]>>;
}

/** The semantic half of a write grant: which pages, blocks, collections, or files the write may target. */
export interface AccessWriteScope {
  readonly pages: readonly string[];
  readonly blocks: readonly string[];
  readonly collections: readonly string[];
  readonly files: readonly string[];
}

/** The write part: an allowed path list and a semantic scope. Both must allow the target. */
export interface AccessWritePolicy {
  /** Site-relative paths or globs the task may write. */
  readonly paths: readonly string[];
  /** The pages, blocks, collections, or files the write is about. */
  readonly scope: AccessWriteScope;
}

/** One check runner the task may execute. */
export interface AccessRunnerGrant {
  readonly name: string;
  /** Input names the runner may receive. `*` allows every input the runner declares. */
  readonly inputs: readonly string[];
  /** Resources the runner may read. `*` allows the runner's declared resources, never an arbitrary one. */
  readonly resources: readonly string[];
}

/** The check part: a named runner list. Running a check never grants commands or network access. */
export interface AccessCheckPolicy {
  readonly runners: readonly AccessRunnerGrant[];
}

/** The network part: explicit destinations, limited to explicit stages. Both must match. */
export interface AccessNetworkPolicy {
  readonly destinations: readonly string[];
  readonly stages: readonly AccessStage[];
}

/** Which capabilities need a separate, explicit approval. One answer never covers another capability. */
export interface AccessApprovalPolicy {
  readonly read: boolean;
  readonly write: boolean;
  readonly execute: boolean;
  readonly network: boolean;
  readonly publish: boolean;
}

/** The independent switches. A capability is denied unless its switch is true. */
export interface AccessCapabilities {
  readonly read: boolean;
  readonly write: boolean;
  readonly execute: boolean;
  readonly network: boolean;
  readonly publish: boolean;
}

/** One versioned access policy, with every default filled. */
export interface AccessPolicy {
  readonly version: 1;
  /** The task this policy belongs to, or `site` for the site default. */
  readonly task: string;
  /** The policy this one was delegated from, by fingerprint; absent for a root policy. */
  readonly delegatedFrom?: string;
  readonly capabilities: AccessCapabilities;
  readonly read: AccessReadPolicy;
  readonly write: AccessWritePolicy;
  readonly check: AccessCheckPolicy;
  readonly network: AccessNetworkPolicy;
  readonly approvals: AccessApprovalPolicy;
}

/** One located validation problem. `path` is a JSON Pointer into the parsed document. */
export interface AccessPolicyProblem {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/** A parsed policy, or every reason it was refused. */
export interface AccessPolicyParseResult {
  readonly policy?: AccessPolicy;
  readonly problems: readonly AccessPolicyProblem[];
}

/** One approval already answered for one capability. */
export interface AccessGrant {
  /** Stable request id, unique in the task. */
  readonly id: string;
  readonly capability: AccessCapability;
  readonly principal: string;
  readonly decision: "approved" | "rejected";
  readonly reason: string;
  /** The input snapshot the approval was made under. */
  readonly snapshot: string;
  /** The fingerprint of the access policy the approval was made under. */
  readonly policy: string;
  /** The network destination this approval names, for `network`. */
  readonly destination?: string;
  /** The stage this approval covers, for `network`. */
  readonly stage?: AccessStage;
  /** The files this approval covers, for `write`. */
  readonly files?: readonly string[];
  /** The check runner this approval covers, for `execute`. */
  readonly runner?: string;
}

/** Everything one decision needs. */
export interface AccessRequest {
  readonly capability: AccessCapability;
  readonly task: string;
  readonly snapshot: string;
  /** The resource for `read`. */
  readonly resource?: AccessResource;
  /** The site-relative path for `write`. */
  readonly path?: string;
  /** The semantic scope for `write`. */
  readonly scope?: AccessWriteScope;
  /** The runner name for `execute`. */
  readonly runner?: string;
  readonly inputs?: readonly string[];
  /** Runner resources, checked against the grant's own list. */
  readonly resources?: readonly string[];
  /** The destination for `network`. */
  readonly destination?: string;
  /** The stage for `network`. */
  readonly stage?: AccessStage;
  /** Approvals the caller holds; a stale one never resumes work. */
  readonly approvals?: readonly AccessGrant[];
}

/** Why one request was allowed or denied. */
export interface AccessDecision {
  readonly allowed: boolean;
  readonly capability: AccessCapability;
  /** The rule that decided it, such as `read.audiences` or `approval.required`. */
  readonly rule: string;
  /** One sentence a person can act on; it never repeats denied content. */
  readonly reason: string;
  /** The approval id used, when one was. */
  readonly approval?: string;
}

/** One audit line: the task, capability, decision, rule, and approval, never the content. */
export interface AccessAuditRecord {
  readonly version: 1;
  readonly task: string;
  readonly capability: AccessCapability;
  readonly decision: "allow" | "deny";
  readonly rule: string;
  readonly reason: string;
  readonly approval: string | null;
  readonly snapshot: string;
  readonly policy: string;
  /** A non-sensitive resource id, such as a page URL or runner name; absent when naming it would leak. */
  readonly resource?: string;
}

/** A delegated policy, or every way the child would widen the parent. */
export interface AccessDelegationResult {
  readonly policy?: AccessPolicy;
  readonly problems: readonly AccessPolicyProblem[];
}
