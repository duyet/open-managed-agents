// Unit tests for the auto-clone synthesis helper. No Durable Object needed —
// see the file-level comment in env-repo-resource.ts.

import { describe, expect, it } from "vitest";
import { synthesizeEnvRepoResource } from "./env-repo-resource";

describe("synthesizeEnvRepoResource", () => {
  it("returns null when no git_repo is configured", () => {
    expect(synthesizeEnvRepoResource(undefined, [])).toBeNull();
  });

  it("returns null when git_repo has no url", () => {
    expect(synthesizeEnvRepoResource({ url: "" }, [])).toBeNull();
  });

  it("synthesizes a github_repository resource defaulting mount_path to /workspace", () => {
    const result = synthesizeEnvRepoResource(
      { url: "https://github.com/acme/widgets" },
      [],
    );
    expect(result).toEqual({
      type: "github_repository",
      url: "https://github.com/acme/widgets",
      mount_path: "/workspace",
      credential_id: undefined,
    });
  });

  it("carries branch through as a checkout spec", () => {
    const result = synthesizeEnvRepoResource(
      { url: "https://github.com/acme/widgets", branch: "develop" },
      [],
    );
    expect(result).toMatchObject({
      checkout: { type: "branch", name: "develop" },
    });
  });

  it("carries credential_id through onto the synthesized resource", () => {
    const result = synthesizeEnvRepoResource(
      { url: "https://github.com/acme/widgets", credential_id: "cred_xxx" },
      [],
    );
    expect(result).toMatchObject({ credential_id: "cred_xxx" });
  });

  it("respects a custom mount_path", () => {
    const result = synthesizeEnvRepoResource(
      { url: "https://github.com/acme/widgets", mount_path: "/home/user/repo" },
      [],
    );
    expect(result).toMatchObject({ mount_path: "/home/user/repo" });
  });

  it("returns null when an existing github_repository resource already targets the same mount path", () => {
    const result = synthesizeEnvRepoResource(
      { url: "https://github.com/acme/widgets" },
      [{ type: "github_repository", url: "https://github.com/other/repo", mount_path: "/workspace" }],
    );
    expect(result).toBeNull();
  });

  it("returns null when an existing github_repo (legacy type alias) resource targets the same default mount path", () => {
    const result = synthesizeEnvRepoResource(
      { url: "https://github.com/acme/widgets" },
      [{ type: "github_repo", url: "https://github.com/other/repo" }],
    );
    expect(result).toBeNull();
  });

  it("still synthesizes when an existing repo resource targets a different mount path", () => {
    const result = synthesizeEnvRepoResource(
      { url: "https://github.com/acme/widgets" },
      [{ type: "github_repository", url: "https://github.com/other/repo", mount_path: "/mnt/other" }],
    );
    expect(result).not.toBeNull();
  });

  it("ignores non-repo resources when checking for a collision", () => {
    const result = synthesizeEnvRepoResource(
      { url: "https://github.com/acme/widgets" },
      [{ type: "file", mount_path: "/workspace" }],
    );
    expect(result).not.toBeNull();
  });
});
