import { buildManifest as buildSlackManifest, type SlackManifestInput } from "./oauth/manifest";

export function generateSlackManifest(config: SlackManifestInput): Record<string, unknown> {
  return buildSlackManifest(config);
}

export type { SlackManifestInput } from "./oauth/manifest";
