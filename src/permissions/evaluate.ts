/**
 * One decision per request: whether a policy allows a capability, why, and which approval covered it.
 *
 * The order is deliberate. The capability switch is read first, then the capability's own rule (audience, page,
 * path and scope, runner, destination and stage), and only then the approval. A denied capability never becomes
 * allowed because a matching approval exists, and an approved write never covers an execute, a network call, or a
 * publish. Read denials name no label, title, or value the caller may not see; a caller cannot tell a hidden page
 * from a missing one through this layer.
 */
import type {
  AccessAuditRecord,
  AccessCapability,
  AccessDecision,
  AccessDelegationResult,
  AccessPolicy,
  AccessPolicyProblem,
  AccessRequest,
  AccessResource,
  AccessGrant,
  AccessWriteScope,
} from "../contracts/permissions.ts";
import {
  anyReferenceMatches,
  byCodePoint,
  destinationMatches,
  destinationOf,
  pathMatches,
  referencesWithin,
  sitePathProblem,
} from "./match.ts";
import {
  accessPolicyFingerprint,
  readPolicyWithin,
  scopeSize,
} from "./policy.ts";

/** A denied decision, with the rule that refused it. */
function deny(capability: AccessCapability, rule: string, reason: string): AccessDecision {
  return { allowed: false, capability, rule, reason };
}

/** An allowed decision, optionally naming its approval. */
function allow(capability: AccessCapability, rule: string, reason: string, approval?: string): AccessDecision {
  return { allowed: true, capability, rule, reason, ...(approval === undefined ? {} : { approval }) };
}

/**
 * Decides one request. `request.snapshot` is the input snapshot the caller is acting on; an approval made under
 * another snapshot or policy is stale and is refused, so a changed input cannot resume on an old answer.
 */
export function decideAccess(policy: AccessPolicy, request: AccessRequest): AccessDecision {
  const capability = request.capability;
  if (!policy.capabilities[capability]) {
    return deny(capability, `capability.${capability}`, `The policy does not grant the \`${capability}\` capability.`);
  }

  const rule = capabilityRule(policy, request);
  if (!rule.allowed) return rule;

  const approval = approvalFor(policy, request);
  if (approval !== undefined) return approval;
  return allow(capability, rule.rule, rule.reason);
}

/** The capability's own rule, before any approval is considered. */
function capabilityRule(policy: AccessPolicy, request: AccessRequest): AccessDecision {
  switch (request.capability) {
    case "read":
      return readRule(policy, request.resource ?? { kind: "other", id: "content" });
    case "write":
      return writeRule(policy, request);
    case "execute":
      return executeRule(policy, request);
    case "network":
      return networkRule(policy, request);
    case "publish":
      return allow("publish", "publish.capability", "The policy grants publication.");
  }
}

/** Whether a read target is public, in an allowed audience, and on an allowed page, block, collection, or field. */
export function readRule(policy: AccessPolicy, resource: AccessResource): AccessDecision {
  const audiences = resource.audiences ?? [];
  if (audiences.length === 0) {
    if (!policy.read.public) {
      return deny("read", "read.public", "The policy does not read content that has no audience.");
    }
  } else if (!audiences.every((audience) => policy.read.audiences.includes(audience))) {
    return deny("read", "read.audiences", "The resource has an audience the policy does not allow.");
  }

  const page = resource.page ?? (resource.kind === "page" ? resource.id : undefined);
  if (page !== undefined && policy.read.pages !== undefined) {
    if (!anyReferenceMatches(policy.read.pages, page) && !anyReferenceMatches(policy.read.pages, resource.id)) {
      return deny("read", "read.pages", "The policy does not allow this page.");
    }
  }
  if (resource.kind === "block" && policy.read.blocks !== undefined) {
    if (!anyReferenceMatches(policy.read.blocks, resource.id)) {
      return deny("read", "read.blocks", "The policy does not allow this block.");
    }
  }

  const collection = resource.collection;
  if (collection !== undefined && policy.read.collections !== undefined) {
    if (!anyReferenceMatches(policy.read.collections, collection)) {
      return deny("read", "read.collections", "The policy does not allow this collection.");
    }
  }
  if (resource.kind === "field" && collection !== undefined && resource.field !== undefined) {
    const fields = policy.read.fields?.[collection];
    if (fields !== undefined && !anyReferenceMatches(fields, resource.field)) {
      return deny("read", "read.fields", "The policy does not allow this field.");
    }
  }
  return allow("read", "read.allowed", "The policy allows this content.");
}

/** Whether both the resolved path and the semantic scope allow a write. */
export function writeRule(policy: AccessPolicy, request: AccessRequest): AccessDecision {
  const path = request.path;
  if (path === undefined) return deny("write", "write.path", "A write needs a site-relative path.");
  const problem = sitePathProblem(path);
  if (problem !== undefined) return deny("write", "write.path", `The write path is refused because ${problem}.`);
  if (!policy.write.paths.some((pattern) => pathMatches(pattern, path))) {
    return deny("write", "write.path", "The policy does not allow this path.");
  }
  const wanted = request.scope;
  if (wanted === undefined || scopeSize(wanted) === 0) {
    return deny("write", "write.scope", "A write needs a semantic scope; an allowed path alone is not enough.");
  }
  if (!writeScopeWithin(policy.write.scope, wanted, path)) {
    return deny("write", "write.scope", "The policy does not allow this write's scope.");
  }
  return allow("write", "write.allowed", "Both the path and the scope allow this write.");
}

/** True when every reference of `wanted` is allowed by `granted`; a file scope must also name the path. */
export function writeScopeWithin(
  granted: AccessWriteScope,
  wanted: AccessWriteScope,
  path: string,
): boolean {
  let covered = false;

  if (granted.files.length > 0) {
    if (!referencesWithin(granted.files, wanted.files)) return false;
    if (wanted.files.length > 0 && !granted.files.some((pattern) => pathMatches(pattern, path))) return false;
    if (wanted.files.length > 0) covered = true;
  }

  for (const key of ["pages", "blocks", "collections"] as const) {
    if (wanted[key].length === 0) continue;
    if (granted[key].length === 0) continue;
    if (!referencesWithin(granted[key], wanted[key])) return false;
    covered = true;
  }

  // A caller that supplies only files is covered by a file grant; with no file grant it needs a semantic category.
  if (wanted.files.length > 0 && granted.files.length === 0) covered = false;
  return covered;
}

/** Whether a named runner is granted, and whether its inputs and resources are inside the grant. */
export function executeRule(policy: AccessPolicy, request: AccessRequest): AccessDecision {
  const name = request.runner;
  if (name === undefined || name.trim() === "") {
    return deny("execute", "execute.runner", "Executing needs the name of a granted runner.");
  }
  const grant = policy.check.runners.find((runner) => runner.name === name);
  if (grant === undefined) {
    return deny("execute", "execute.runner", "The policy does not grant this runner.");
  }
  if (!namesWithin(grant.inputs, request.inputs ?? [])) {
    return deny("execute", "execute.inputs", "The runner grant does not allow every input.");
  }
  if (!namesWithin(grant.resources, request.resources ?? [])) {
    return deny("execute", "execute.resources", "The runner grant does not allow every resource.");
  }
  // A runner grant is exactly this runner; it never becomes a shell and never reaches the network by itself.
  return allow("execute", "execute.allowed", "The policy grants this runner with these inputs and resources.");
}

/** True when every requested name is covered by a grant entry; `*` and `**` cover every name. */
export function namesWithin(granted: readonly string[], wanted: readonly string[]): boolean {
  if (granted.includes("*") || granted.includes("**")) return true;
  return wanted.every((name) => granted.some((allowed) => allowed === name || pathMatches(allowed, name)));
}

/** Whether the destination and stage are both allowed. */
export function networkRule(policy: AccessPolicy, request: AccessRequest): AccessDecision {
  const destination = request.destination;
  if (destination === undefined || destination.trim() === "") {
    return deny("network", "network.destination", "Network access needs a destination.");
  }
  if (!policy.network.destinations.some((pattern) => destinationMatches(pattern, destination))) {
    return deny("network", "network.destination", "The policy does not allow this destination.");
  }
  const stage = request.stage;
  if (stage === undefined || !policy.network.stages.includes(stage)) {
    return deny("network", "network.stage", "The policy does not allow network access in this stage.");
  }
  return allow("network", "network.allowed", "The policy allows this destination in this stage.");
}

/**
 * The approval rule, or undefined when no approval is needed or one covers the request.
 *
 * A grant is filtered by capability first, so an approved read cannot authorize a write. A grant made under another
 * snapshot or policy is stale: it is named as stale and never allowed.
 */
function approvalFor(policy: AccessPolicy, request: AccessRequest): AccessDecision | undefined {
  if (!policy.approvals[request.capability]) return undefined;
  const fingerprint = accessPolicyFingerprint(policy);
  const grants = (request.approvals ?? []).filter((grant) => grant.capability === request.capability);
  if (grants.length === 0) {
    return deny(
      request.capability,
      "approval.required",
      `The policy requires a separate approval for \`${request.capability}\`; none was supplied.`,
    );
  }

  const rejected = grants.find((grant) => grant.decision === "rejected" && covers(grant, request));
  if (rejected !== undefined) {
    return deny(request.capability, "approval.rejected", `Approval \`${rejected.id}\` was rejected.`);
  }

  const stale = grants.find(
    (grant) =>
      grant.decision === "approved" &&
      (grant.snapshot !== request.snapshot || grant.policy !== fingerprint),
  );
  if (stale !== undefined) {
    return deny(
      request.capability,
      "approval.stale",
      `Approval \`${stale.id}\` was made under another snapshot or policy; ask again for the current inputs.`,
    );
  }

  const approved = grants.find((grant) => grant.decision === "approved" && covers(grant, request));
  if (approved === undefined) {
    return deny(
      request.capability,
      "approval.scope",
      `No approval for \`${request.capability}\` covers this request; one approval never covers another scope.`,
    );
  }
  const reason = `Approval \`${approved.id}\` covers this ${request.capability} request.`;
  return allow(request.capability, "approval.granted", reason, approved.id);
}

/** Whether a grant's details cover the request; the capability was already matched. */
function covers(grant: AccessGrant, request: AccessRequest): boolean {
  switch (request.capability) {
    case "write": {
      if (request.path === undefined) return false;
      const files = grant.files ?? [];
      return files.some((file) => pathMatches(file, request.path!));
    }
    case "execute":
      return grant.runner === undefined || grant.runner === request.runner;
    case "network":
      return (
        grant.destination !== undefined &&
        request.destination !== undefined &&
        destinationMatches(grant.destination, destinationOf(request.destination)) &&
        (grant.stage === undefined || grant.stage === request.stage)
      );
    default:
      return true;
  }
}

/** True when a grant is still valid under this policy and snapshot. */
export function approvalValid(grant: AccessGrant, policy: AccessPolicy, snapshot: string): boolean {
  return (
    grant.decision === "approved" &&
    grant.snapshot === snapshot &&
    grant.policy === accessPolicyFingerprint(policy)
  );
}

/**
 * Delegates a policy to a subtask. The child keeps only what the parent already grants; any widening is a located
 * problem and no policy is returned. A successful child records the parent's fingerprint, so its audit lines show
 * where its authority came from.
 */
export function delegatePolicy(parent: AccessPolicy, child: AccessPolicy): AccessDelegationResult {
  const problems: AccessPolicyProblem[] = [];
  for (const capability of Object.keys(child.capabilities) as AccessCapability[]) {
    if (child.capabilities[capability] && !parent.capabilities[capability]) {
      problems.push({
        path: `/capabilities/${capability}`,
        code: "access-policy.delegation-widen",
        message: `The subtask would gain \`${capability}\`, which the parent policy does not grant.`,
      });
    }
  }
  if (!readPolicyWithin(parent.read, child.read)) {
    problems.push({
      path: "/read",
      code: "access-policy.delegation-widen",
      message: "The subtask read policy reads a page, audience, collection, or field the parent does not allow.",
    });
  }
  if (child.write.paths.length > 0 && !referencesWithin(parent.write.paths, child.write.paths)) {
    problems.push({
      path: "/write/paths",
      code: "access-policy.delegation-widen",
      message: "The subtask would write a path the parent does not allow.",
    });
  }
  for (const key of ["pages", "blocks", "collections", "files"] as const) {
    if (child.write.scope[key].length > 0 && !referencesWithin(parent.write.scope[key], child.write.scope[key])) {
      problems.push({
        path: `/write/scope/${key}`,
        code: "access-policy.delegation-widen",
        message: `The subtask write scope adds a ${key} entry the parent does not allow.`,
      });
    }
  }
  for (const runner of child.check.runners) {
    const allowed = parent.check.runners.find((candidate) => candidate.name === runner.name);
    if (allowed === undefined || !namesWithin(allowed.inputs, runner.inputs) || !namesWithin(allowed.resources, runner.resources)) {
      problems.push({
        path: "/check/runners",
        code: "access-policy.delegation-widen",
        message: "The subtask would run a check, input, or resource the parent does not grant.",
      });
    }
  }
  for (const destination of child.network.destinations) {
    if (!parent.network.destinations.some((pattern) => destinationMatches(pattern, destination))) {
      problems.push({
        path: "/network/destinations",
        code: "access-policy.delegation-widen",
        message: "The subtask would reach a destination the parent does not allow.",
      });
    }
  }
  for (const stage of child.network.stages) {
    if (!parent.network.stages.includes(stage)) {
      problems.push({
        path: "/network/stages",
        code: "access-policy.delegation-widen",
        message: "The subtask would use the network in a stage the parent does not allow.",
      });
    }
  }
  for (const capability of Object.keys(child.approvals) as AccessCapability[]) {
    if (!child.approvals[capability] && parent.approvals[capability]) {
      problems.push({
        path: `/approvals/${capability}`,
        code: "access-policy.delegation-widen",
        message: `The subtask would waive the \`${capability}\` approval the parent requires.`,
      });
    }
  }

  if (problems.length > 0) return { problems };
  return {
    policy: { ...child, delegatedFrom: accessPolicyFingerprint(parent) },
    problems: [],
  };
}

/** One audit line for a decision. It names ids, never content, secrets, or a denied value. */
export function auditOf(policy: AccessPolicy, request: AccessRequest, decision: AccessDecision): AccessAuditRecord {
  const resource =
    request.capability === "read"
      ? request.resource?.kind === "other"
        ? undefined
        : request.resource?.id
      : request.capability === "execute"
        ? request.runner
        : request.capability === "network"
          ? request.destination === undefined
            ? undefined
            : destinationOf(request.destination)
          : request.path;
  return {
    version: 1,
    task: request.task,
    capability: request.capability,
    decision: decision.allowed ? "allow" : "deny",
    rule: decision.rule,
    reason: decision.reason,
    approval: decision.approval ?? null,
    snapshot: request.snapshot,
    policy: accessPolicyFingerprint(policy),
    ...(resource === undefined ? {} : { resource }),
  };
}

/** Audit lines in a stable order: task, capability, then rule. */
export function sortAudit(records: readonly AccessAuditRecord[]): readonly AccessAuditRecord[] {
  return [...records].sort(
    (a, b) => byCodePoint(a.task, b.task) || byCodePoint(a.capability, b.capability) || byCodePoint(a.rule, b.rule),
  );
}
