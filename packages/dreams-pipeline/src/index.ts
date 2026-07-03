// Public surface of @duyet/oma-dreams-pipeline.
//
// The portable pipeline used by apps/main. Hosts construct a service
// container, pick a curator backend, and call `runDream` — the steps in
// between are runtime-agnostic.
//
// Spec: https://platform.claude.com/docs/en/managed-agents/dreams

export * from "./steps";
export * from "./curator";
export * from "./dream-runner";
