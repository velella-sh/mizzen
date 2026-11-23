import type { Ajv2020 as AjvClass } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { createRequire } from "node:module";
import { checkAsOf } from "../dates/as-of.ts";
import { canonicalJson, sha256 } from "../data/lock.ts";

interface Target {
  readonly surface: string;
  readonly behavior: string;
}

interface TestName {
  readonly suite: string;
  readonly name: string;
}

export interface TestResult extends TestName {
  readonly outcome: "passed" | "failed" | "skipped";
}

type Payload =
  | { readonly kind: "test"; readonly payload: {
    readonly schema: "test-json@1" | "junit@1";
    readonly results: readonly TestResult[] | string;
    readonly catalog: readonly (TestName & Target)[];
  } }
  | { readonly kind: "ci"; readonly payload: {
    readonly schema: "ci-run@1";
    readonly runId: string;
    readonly commit: string;
    readonly configSha256: string;
    readonly workflow: string;
    readonly artifactSha256: string;
    readonly outcome: "passed" | "failed" | "skipped";
    readonly targets: readonly Target[];
  } }
  | { readonly kind: "benchmark"; readonly payload: {
    readonly schema: "benchmark@1";
    readonly metric: string;
    readonly unit: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly raw: readonly number[];
    readonly value: number;
    readonly run: string;
    readonly targets: readonly Target[];
  } };

export type Envelope = Payload & {
  readonly version: 1;
  readonly id: string;
  readonly origin: string;
  readonly snapshot: string;
  readonly executedAt: string;
  readonly payloadSha256: string;
};

export interface EvidenceLock {
  readonly version: 1;
  readonly snapshot: { readonly id: string; readonly commit: string; readonly configSha256: string };
  readonly maxAgeDays: number;
  readonly pins: Readonly<Record<string, { readonly sha256: string; readonly artifactSha256?: string }>>;
  readonly surfaces: readonly string[];
  readonly claims: readonly (Target & {
    readonly id: string;
    readonly subject: { readonly kind: "page" | "behavior"; readonly id: string };
    readonly evidence: readonly string[];
  })[];
}

const Ajv = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof AjvClass;
const ajv = new Ajv({ strict: true, ownProperties: true });
const text = { type: "string", pattern: "\\S" };
const string = { type: "string" };
const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
const commit = { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" };
const version = { type: "integer", const: 1 };
const outcome = { enum: ["passed", "failed", "skipped"] };
const number = { type: "number" };
const target = { surface: text, behavior: text };
const testName = { suite: string, name: text };

function object(properties: Record<string, object>, required = Object.keys(properties)): object {
  return { type: "object", properties, required, additionalProperties: false };
}

function list(items: object, minItems = 0, uniqueItems = false): object {
  return { type: "array", items, minItems, uniqueItems };
}

const common = { version, id: text, origin: text, snapshot: text, executedAt: text, payloadSha256: hash };
function envelope(kind: Envelope["kind"], payload: object): object {
  return object({ ...common, kind: { const: kind }, payload });
}

const envelopeSchema = {
  oneOf: [
    envelope("test", {
      oneOf: [
        object({
          schema: { const: "test-json@1" },
          results: list(object({ ...testName, outcome })),
          catalog: list(object({ ...testName, ...target }), 1),
        }),
        object({
          schema: { const: "junit@1" },
          results: text,
          catalog: list(object({ ...testName, ...target }), 1),
        }),
      ],
    }),
    envelope("ci", object({
      schema: { const: "ci-run@1" }, runId: text, commit, configSha256: hash, workflow: text,
      artifactSha256: hash, outcome, targets: list(object(target), 1),
    })),
    envelope("benchmark", object({
      schema: { const: "benchmark@1" }, metric: text, unit: text, value: number,
      environment: { type: "object", minProperties: 1, additionalProperties: text },
      raw: list(number, 1), run: text, targets: list(object(target), 1),
    })),
  ],
};

const lockSchema = object({
  version,
  snapshot: object({ id: text, commit, configSha256: hash }),
  maxAgeDays: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  pins: {
    type: "object", propertyNames: text,
    additionalProperties: object({ sha256: hash, artifactSha256: hash }, ["sha256"]),
  },
  surfaces: list(text, 0, true),
  claims: list(object({
    ...target,
    id: text,
    subject: object({ kind: { enum: ["page", "behavior"] }, id: text }),
    evidence: list(text, 1, true),
  })),
});

let validateEnvelope: ValidateFunction<Envelope> | undefined;
let validateLock: ValidateFunction<EvidenceLock> | undefined;

function httpsUrl(value: string): boolean {
  const url = URL.parse(value);
  return url !== null && url.protocol === "https:" && url.username === "" && url.password === "";
}

export function readEnvelope(value: unknown): Envelope {
  validateEnvelope ??= ajv.compile<Envelope>(envelopeSchema);
  if (!validateEnvelope(value)) throw new Error("Invalid evidence envelope or payload schema.");
  const time = Date.parse(value.executedAt);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value.executedAt)
      || checkAsOf(value.executedAt.slice(0, 10)) !== undefined
      || !Number.isFinite(time)
      || new Date(time).toISOString().slice(0, 19) !== value.executedAt.slice(0, 19)) {
    throw new Error("Evidence executedAt must be a valid UTC timestamp.");
  }
  if (!httpsUrl(value.origin) || (value.kind === "benchmark" && !httpsUrl(value.payload.run))) {
    throw new Error("Evidence origin and benchmark run must be HTTPS URLs without credentials.");
  }
  if (sha256(canonicalJson(value.payload)) !== value.payloadSha256) {
    throw new Error(`Evidence "${value.id}" payload SHA-256 does not match.`);
  }
  return value;
}

export function readEvidenceLock(value: unknown): EvidenceLock {
  validateLock ??= ajv.compile<EvidenceLock>(lockSchema);
  if (!validateLock(value)) throw new Error("Invalid evidence.lock.json format.");
  const ids = new Set<string>();
  for (const claim of value.claims) {
    if (ids.has(claim.id)) throw new Error(`Duplicate evidence claim "${claim.id}".`);
    ids.add(claim.id);
  }
  return value;
}
