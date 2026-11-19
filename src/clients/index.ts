/** The client surface: adapters, detection, fallbacks, generated configuration, secrets, skills, and versions. */
export {
  ADAPTER_PROTOCOL_VERSIONS,
  CAPABILITY_KEYS,
  CLIENT_ADAPTERS,
  CLIENT_IDS,
  GENERIC_ADAPTER,
  adapterOf,
  validateCapabilities,
  validateClientDescriptor,
  type ClientId,
} from "./registry.ts";
export { checkClientContractVersion, CLIENT_CONTRACT_VERSION, SUPPORTED_CONTRACT_VERSIONS, type ClientVersionResult } from "./version.ts";
export { clientReport, fallbacksOf } from "./fallback.ts";
export { detectClient, isKnownClient, MIZZEN_EXPERIMENT, type DetectOptions } from "./detect.ts";
export { CLIENTS, clientConfig, clientConfigValue, isClient, supportedClients, type Client, type ClientServerConfig } from "./config.ts";
export { CLIENT_REDACTED, envReference, redactClientConfig, redactClientText, resolveEnvReferences, type EnvResolution } from "./secrets.ts";
export { readSkillPackage, SKILL_PACKAGE_DIR, SkillPackageError, type SkillPackage } from "./skill.ts";
