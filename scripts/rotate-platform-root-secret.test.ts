import { beforeEach, describe, expect, it, vi } from "vitest";

import { WebCryptoAesGcm } from "../packages/integrations-adapters-cf/src/crypto";
import { rotateColumn } from "./rotate-platform-root-secret";

const OLD_SECRET = "old-secret-padded-to-thirty-two-bytes!!";
const NEW_SECRET = "new-secret-padded-to-thirty-two-bytes!!";
const LABEL = "credentials.auth";

/**
 * In-memory fake of the D1 HTTP API surface this script talks to. Backs a
 * single table `{ id, auth }`; supports exactly the four query shapes
 * `rotateColumn`/`rotateRow` issue (keyset-paginated SELECT, follow-on
 * WHERE id > ? SELECT, CAS UPDATE, single-row re-SELECT).
 */
class FakeD1 {
  rows = new Map<string, string>(); // id -> cipher

  async handle(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
    const s = sql.replace(/\s+/g, " ").trim();

    if (s.startsWith("SELECT auth AS value FROM credentials WHERE id = ?")) {
      const [id] = params as [string];
      return this.rows.has(id) ? [{ value: this.rows.get(id) }] : [];
    }
    if (s.startsWith("SELECT id AS id, auth AS value FROM credentials WHERE id > ?")) {
      const [afterId, limit] = params as [string, number];
      return this.pageAfter(afterId, limit);
    }
    if (s.startsWith("SELECT id AS id, auth AS value FROM credentials ORDER BY id LIMIT ?")) {
      const [limit] = params as [number];
      return this.pageAfter(null, limit);
    }
    if (s.startsWith("UPDATE credentials SET auth = ? WHERE id = ? AND auth = ?")) {
      const [newValue, id, expectedOld] = params as [string, string, string];
      if (this.rows.get(id) === expectedOld) {
        this.rows.set(id, newValue);
      }
      // D1's real API doesn't return affected-row info on this path; the
      // script re-selects afterward, so this handler intentionally mirrors
      // that (no info returned here).
      return [];
    }
    throw new Error(`FakeD1: unhandled SQL: ${s}`);
  }

  private pageAfter(afterId: string | null, limit: number): Array<Record<string, unknown>> {
    const ids = [...this.rows.keys()].sort();
    const start = afterId === null ? 0 : ids.findIndex((id) => id > afterId);
    return ids
      .slice(start === -1 ? ids.length : start, (start === -1 ? ids.length : start) + limit)
      .map((id) => ({ id, value: this.rows.get(id) }));
  }
}

let fakeDb: FakeD1;

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { sql: string; params: unknown[] };
      const results = await fakeDb.handle(body.sql, body.params);
      return new Response(
        JSON.stringify({ success: true, result: [{ results }] }),
      );
    }),
  );
}

async function seedRow(id: string, plaintext: string, crypto: WebCryptoAesGcm) {
  fakeDb.rows.set(id, await crypto.encrypt(plaintext));
}

function baseOpts(overrides: Partial<Parameters<typeof rotateColumn>[0]> = {}) {
  return {
    accountId: "acct",
    token: "tok",
    dbId: "db",
    table: "credentials",
    idColumn: "id",
    cipherColumn: "auth",
    oldCrypto: new WebCryptoAesGcm(OLD_SECRET, LABEL),
    newCrypto: new WebCryptoAesGcm(NEW_SECRET, LABEL),
    pageSize: 200,
    dryRun: false,
    continueOnError: false,
    ...overrides,
  };
}

describe("rotate-platform-root-secret", () => {
  beforeEach(() => {
    fakeDb = new FakeD1();
    installFetchMock();
  });

  it("round-trips: old-key decrypt -> new-key encrypt -> new-key decrypt == original plaintext", async () => {
    const oldCrypto = new WebCryptoAesGcm(OLD_SECRET, LABEL);
    const newCrypto = new WebCryptoAesGcm(NEW_SECRET, LABEL);
    await seedRow("cred_1", "super-secret-token-value", oldCrypto);

    const result = await rotateColumn(baseOpts());

    expect(result.rotated).toBe(1);
    expect(result.failures).toHaveLength(0);

    const rotatedCipher = fakeDb.rows.get("cred_1")!;
    // The rotated ciphertext is unreadable under OLD ...
    await expect(oldCrypto.decrypt(rotatedCipher)).rejects.toThrow();
    // ... and decrypts to the exact original plaintext under NEW.
    await expect(newCrypto.decrypt(rotatedCipher)).resolves.toBe(
      "super-secret-token-value",
    );
  });

  it("is idempotent: running rotation twice does not corrupt or double-encrypt", async () => {
    const oldCrypto = new WebCryptoAesGcm(OLD_SECRET, LABEL);
    const newCrypto = new WebCryptoAesGcm(NEW_SECRET, LABEL);
    await seedRow("cred_1", "value-one", oldCrypto);
    await seedRow("cred_2", "value-two", oldCrypto);

    const first = await rotateColumn(baseOpts());
    expect(first.rotated).toBe(2);
    expect(first.alreadyRotated).toBe(0);

    const cipherAfterFirst1 = fakeDb.rows.get("cred_1");
    const cipherAfterFirst2 = fakeDb.rows.get("cred_2");

    const second = await rotateColumn(baseOpts());
    expect(second.rotated).toBe(0);
    expect(second.alreadyRotated).toBe(2);
    expect(second.failures).toHaveLength(0);

    // Ciphertext is untouched by the second pass — no double-encryption.
    expect(fakeDb.rows.get("cred_1")).toBe(cipherAfterFirst1);
    expect(fakeDb.rows.get("cred_2")).toBe(cipherAfterFirst2);

    await expect(newCrypto.decrypt(fakeDb.rows.get("cred_1")!)).resolves.toBe("value-one");
    await expect(newCrypto.decrypt(fakeDb.rows.get("cred_2")!)).resolves.toBe("value-two");
  });

  it("resumes correctly after an interrupted run (partial rotation, then finish)", async () => {
    const oldCrypto = new WebCryptoAesGcm(OLD_SECRET, LABEL);
    const newCrypto = new WebCryptoAesGcm(NEW_SECRET, LABEL);
    await seedRow("cred_1", "alpha", oldCrypto);
    await seedRow("cred_2", "beta", oldCrypto);
    await seedRow("cred_3", "gamma", oldCrypto);

    // Simulate "interruption": manually rotate only the first row, as if a
    // previous run got partway through and crashed.
    fakeDb.rows.set("cred_1", await newCrypto.encrypt("alpha"));

    const resumed = await rotateColumn(baseOpts());
    expect(resumed.alreadyRotated).toBe(1); // cred_1, detected via try-NEW-first
    expect(resumed.rotated).toBe(2); // cred_2, cred_3

    for (const [id, plaintext] of [
      ["cred_1", "alpha"],
      ["cred_2", "beta"],
      ["cred_3", "gamma"],
    ] as const) {
      await expect(newCrypto.decrypt(fakeDb.rows.get(id)!)).resolves.toBe(plaintext);
    }
  });

  it("dry-run reports counts but writes nothing", async () => {
    const oldCrypto = new WebCryptoAesGcm(OLD_SECRET, LABEL);
    await seedRow("cred_1", "untouched-value", oldCrypto);
    const cipherBefore = fakeDb.rows.get("cred_1");

    const result = await rotateColumn(baseOpts({ dryRun: true }));

    expect(result.wouldRotate).toBe(1);
    expect(result.rotated).toBe(0);
    // Ciphertext identical to what was seeded — no write occurred.
    expect(fakeDb.rows.get("cred_1")).toBe(cipherBefore);
    await expect(oldCrypto.decrypt(fakeDb.rows.get("cred_1")!)).resolves.toBe(
      "untouched-value",
    );
  });

  it("aborts loudly (default) on a row undecryptable under either key, without touching later rows", async () => {
    const oldCrypto = new WebCryptoAesGcm(OLD_SECRET, LABEL);
    const wrongKeyCrypto = new WebCryptoAesGcm("totally-different-key-not-old-or-new!!", LABEL);
    // cred_1 encrypted with neither OLD nor NEW — simulates a bad/wrong old
    // secret being supplied, or a corrupt row.
    await seedRow("cred_1", "corrupt-or-wrong-key", wrongKeyCrypto);
    await seedRow("cred_2", "would-have-rotated-fine", oldCrypto);

    const result = await rotateColumn(baseOpts());

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.id).toBe("cred_1");
    // Fails loud: cred_2 (which sorts after cred_1 and would decrypt fine)
    // must NOT have been rotated — the default behavior stops the run
    // rather than silently skipping the bad row and continuing.
    expect(result.rotated).toBe(0);
    await expect(oldCrypto.decrypt(fakeDb.rows.get("cred_2")!)).resolves.toBe(
      "would-have-rotated-fine",
    );
  });

  it("--continue-on-error collects failures but still rotates the decryptable rows", async () => {
    const oldCrypto = new WebCryptoAesGcm(OLD_SECRET, LABEL);
    const newCrypto = new WebCryptoAesGcm(NEW_SECRET, LABEL);
    const wrongKeyCrypto = new WebCryptoAesGcm("totally-different-key-not-old-or-new!!", LABEL);
    await seedRow("cred_1", "bad-row", wrongKeyCrypto);
    await seedRow("cred_2", "good-row", oldCrypto);

    const result = await rotateColumn(baseOpts({ continueOnError: true }));

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.id).toBe("cred_1");
    expect(result.rotated).toBe(1);
    await expect(newCrypto.decrypt(fakeDb.rows.get("cred_2")!)).resolves.toBe("good-row");
  });

  it("detects a concurrent write during rotation as a conflict instead of clobbering it", async () => {
    const oldCrypto = new WebCryptoAesGcm(OLD_SECRET, LABEL);
    await seedRow("cred_1", "will-race", oldCrypto);

    const realFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    // Simulate a live write landing on this exact row between our read and
    // our CAS write, by mutating the fake table out from under the UPDATE.
    let updateSeen = false;
    vi.mocked(realFetch).mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { sql: string; params: unknown[] };
      if (body.sql.includes("UPDATE") && !updateSeen) {
        updateSeen = true;
        // A concurrent writer changes the row to something else first.
        fakeDb.rows.set("cred_1", await oldCrypto.encrypt("raced-value"));
      }
      const results = await fakeDb.handle(body.sql, body.params);
      return new Response(JSON.stringify({ success: true, result: [{ results }] }));
    });

    const result = await rotateColumn(baseOpts());

    expect(result.conflicts).toBe(1);
    expect(result.rotated).toBe(0);
    // The racing writer's value must survive untouched.
    await expect(oldCrypto.decrypt(fakeDb.rows.get("cred_1")!)).resolves.toBe("raced-value");
  });
});
