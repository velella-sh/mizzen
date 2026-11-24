/**
 * Federated knowledge across repositories: a versioned manifest of projects, each publishing a locked bundle of its
 * graph, public surface, behavior contracts, and authorized evidence. A fetch pins the bundles; a build reads only the
 * pins. This index re-exports the engine so a caller imports one module.
 */
export { buildBundle, bundleText, readBundle, BUNDLE_FILE } from "./bundle.ts";
export type { BundleInput, BundleRead } from "./bundle.ts";
export {
  composeFederation,
  composeUnits,
  refreshFederation,
  unitsOf,
  unitOf,
  nodesOf,
  edgesOf,
  readable,
  visibleBundles,
} from "./compose.ts";
export type { RefreshInput } from "./compose.ts";
export {
  byCodePoint,
  bundleDigest,
  compositionDigest,
  compareVersions,
  evidenceDigest,
  federatedId,
  isVersionRange,
  parseFederatedId,
  parseVersionRange,
  versionInRange,
} from "./contract.ts";
export type { QualifiedId } from "./contract.ts";
export { traceEvidenceChain, locate, MAX_CHAIN_LINKS } from "./chain.ts";
export {
  FEDERATION_LOCK_FILE,
  FEDERATION_STORE,
  bundlePath,
  federationLockHash,
  federationLockText,
  isFederationLock,
  loadFederation,
  readFederationLock,
  writeBundle,
  writeFederationLock,
} from "./lock.ts";
export type { FederationLoad } from "./lock.ts";
export { fetchFederation } from "./fetch.ts";
export type { FederationFetchLike, FederationFetchResult, FetchedBundle } from "./fetch.ts";
export {
  FEDERATION_MANIFEST_FILE,
  FEDERATION_ROLES,
  parseFederationManifest,
  projectOf,
  sourceText,
} from "./manifest.ts";
export type { FederationManifestResult, FederationProblem } from "./manifest.ts";
export { compileFederationPack, candidatesOf } from "./pack.ts";
export {
  DEFAULT_FEDERATION_DEPTH,
  DEFAULT_FEDERATION_NODES,
  MAX_FEDERATION_DEPTH,
  MAX_FEDERATION_NODES,
  queryFederation,
  resolveCitation,
} from "./query.ts";
export {
  REFERENCE_STATUSES,
  federatedReferenceOf,
  isFederatedId,
  pinnedSnapshot,
  readReference,
  resolveReference,
  selectSnapshot,
} from "./reference.ts";
export type { VersionDecision } from "./reference.ts";
