import { describe, expect, it } from "vitest";
import { buildBetterAuth } from "./index";

// buildBetterAuth() only needs a `database` shape that better-auth's
// kysely-adapter can dialect-sniff (`aggregate in db` → sqlite) — it never
// opens a connection during construction, so a stub object is enough to
// assert on the resulting `auth.options.socialProviders` registration
// without a real DB. See the file-header comment in ./index.ts.
const dummyDatabase = { aggregate: () => undefined };

function build(opts: Partial<Parameters<typeof buildBetterAuth>[0]> = {}) {
  return buildBetterAuth({
    database: dummyDatabase,
    sender: null,
    secret: "test-secret-padded-to-be-long-enough-for-validation",
    ensureTenant: async () => "tn_test",
    ...opts,
  });
}

describe("buildBetterAuth — GitHub social provider", () => {
  it("registers github when both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are provided", () => {
    const auth = build({
      githubClientId: "gh-client-id",
      githubClientSecret: "gh-client-secret",
    });
    expect(auth.options.socialProviders).toHaveProperty("github");
    expect((auth.options.socialProviders as Record<string, { clientId: string }>).github).toMatchObject(
      { clientId: "gh-client-id", clientSecret: "gh-client-secret" },
    );
  });

  it("does not register github when the env is unset", () => {
    const auth = build();
    expect(auth.options.socialProviders ?? {}).not.toHaveProperty("github");
  });

  it("does not register github when only one of the pair is set", () => {
    const auth = build({ githubClientId: "gh-client-id" });
    expect(auth.options.socialProviders ?? {}).not.toHaveProperty("github");
  });

  it("registers google and github independently of one another", () => {
    const auth = build({
      googleClientId: "g-id",
      googleClientSecret: "g-secret",
    });
    expect(auth.options.socialProviders).toHaveProperty("google");
    expect(auth.options.socialProviders ?? {}).not.toHaveProperty("github");
  });
});
