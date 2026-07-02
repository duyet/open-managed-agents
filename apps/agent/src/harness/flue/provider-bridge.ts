/**
 * Provider bridge — turns OMA model-card credentials (base URL + API key +
 * model id) into the arguments Flue's `registerProvider(...)` expects, plus
 * the `provider/model` specifier a Flue agent selects with `model: "..."`.
 *
 * This file is intentionally PURE: {@link buildFlueProvider} does no I/O and
 * imports only types, so it is trivially unit-testable and importing it never
 * pulls the `@flue/runtime` value graph into a test worker. The harness
 * (flue-loop.ts) takes the returned `{ providerId, registration }` and makes
 * the single side-effecting `registerProvider(providerId, registration)` call.
 *
 * Most OMA endpoints are OpenAI-compatible gateways, so the default wire
 * protocol is `openai-completions`; callers pointing at an Anthropic-messages
 * endpoint pass `api: "anthropic-messages"`.
 */

import type { HttpProviderRegistration } from "@flue/runtime";

/** Wire protocol slug accepted by Flue's provider registry. */
export type FlueProviderApi = HttpProviderRegistration["api"];

export interface BuildFlueProviderOptions {
  /** Endpoint root, e.g. `https://gateway.example.com/v1`. */
  baseUrl: string;
  /** Upstream API key forwarded on every request. */
  apiKey: string;
  /**
   * Upstream model id exactly as the endpoint expects it (no provider prefix).
   * Becomes the segment after the provider id in the returned specifier.
   */
  model: string;
  /** Wire protocol. Defaults to `openai-completions`. */
  api?: FlueProviderApi;
  /**
   * Provider id used in the model specifier and the registry key. Defaults to
   * `oma`. Each `registerProvider(id, ...)` call replaces the id's previous
   * registration, so a stable id keeps re-registration idempotent.
   */
  providerId?: string;
  /** Extra headers sent on every upstream request. */
  headers?: Record<string, string>;
}

export interface FlueProvider {
  /** Provider id to pass as the first arg of `registerProvider`. */
  providerId: string;
  /** `provider/model` string to assign to a Flue agent's `model`. */
  modelSpecifier: string;
  /** Second arg of `registerProvider` — the HTTP provider registration. */
  registration: HttpProviderRegistration;
}

const DEFAULT_PROVIDER_ID = "oma";
const DEFAULT_API: FlueProviderApi = "openai-completions";

/**
 * Compute the Flue provider registration and model specifier for an OMA model
 * card. Pure — the caller performs the actual `registerProvider(...)` call.
 *
 * @throws if `baseUrl`, `apiKey`, or `model` is blank — a provider id outside
 * Flue's built-in catalog must supply a real endpoint + key, and a blank model
 * would yield an unusable `provider/` specifier.
 */
export function buildFlueProvider(opts: BuildFlueProviderOptions): FlueProvider {
  const providerId = opts.providerId?.trim() || DEFAULT_PROVIDER_ID;
  const baseUrl = opts.baseUrl?.trim();
  const model = opts.model?.trim();

  if (!baseUrl) throw new Error("buildFlueProvider: baseUrl is required");
  if (!opts.apiKey) throw new Error("buildFlueProvider: apiKey is required");
  if (!model) throw new Error("buildFlueProvider: model is required");

  const registration: HttpProviderRegistration = {
    api: opts.api ?? DEFAULT_API,
    baseUrl,
    apiKey: opts.apiKey,
  };
  if (opts.headers && Object.keys(opts.headers).length > 0) {
    registration.headers = opts.headers;
  }

  return {
    providerId,
    modelSpecifier: `${providerId}/${model}`,
    registration,
  };
}
