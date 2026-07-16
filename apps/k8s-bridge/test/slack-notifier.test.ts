import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackNotifier } from "../src/slack-notifier";

describe("SlackNotifier", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends sandbox_crashed only when it is in notifyOn", async () => {
    const notifier = new SlackNotifier("https://hooks.slack/webhook", ["sandbox_crashed"]);
    await notifier.notifySandboxCrashed("sess_1", "CrashLoopBackOff");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.slack/webhook");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.text).toContain("sess_1");
    expect(body.text).toContain("CrashLoopBackOff");
  });

  it("does not send an event that isn't in notifyOn", async () => {
    const notifier = new SlackNotifier("https://hooks.slack/webhook", ["box_created"]);
    await notifier.notifySandboxOOM("sess_1", "512Mi", "512Mi");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("formats sandbox_oom with used/limit memory", async () => {
    const notifier = new SlackNotifier("https://hooks.slack/webhook", ["sandbox_oom"]);
    await notifier.notifySandboxOOM("sess_1", "512Mi", "1Gi");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toBe("🔥 Sandbox `sess_1` OOM-killed (used 512Mi of 1Gi)");
  });

  it("formats sandbox_pending with duration", async () => {
    const notifier = new SlackNotifier("https://hooks.slack/webhook", ["sandbox_pending"]);
    await notifier.notifySandboxPending("sess_1", 45);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toBe("⏳ Sandbox `sess_1` pending for 45s");
  });

  it("formats cluster_low_capacity with cpu/mem percentages", async () => {
    const notifier = new SlackNotifier("https://hooks.slack/webhook", ["cluster_low_capacity"]);
    await notifier.notifyClusterLowCapacity(92, 88);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toBe("🚨 Cluster capacity critical: 92% CPU, 88% memory used");
  });

  it("debounces repeated notifications for the same sandbox within the window", async () => {
    const notifier = new SlackNotifier("https://hooks.slack/webhook", ["sandbox_crashed"], 30_000);
    await notifier.notifySandboxCrashed("sess_1", "CrashLoopBackOff");
    await notifier.notifySandboxCrashed("sess_1", "CrashLoopBackOff");
    await notifier.notifySandboxCrashed("sess_1", "CrashLoopBackOff");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not debounce across different sandboxes", async () => {
    const notifier = new SlackNotifier("https://hooks.slack/webhook", ["sandbox_crashed"], 30_000);
    await notifier.notifySandboxCrashed("sess_1", "CrashLoopBackOff");
    await notifier.notifySandboxCrashed("sess_2", "CrashLoopBackOff");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not debounce across different event types for the same sandbox", async () => {
    const notifier = new SlackNotifier("https://hooks.slack/webhook", ["sandbox_crashed", "sandbox_oom"], 30_000);
    await notifier.notifySandboxCrashed("sess_1", "CrashLoopBackOff");
    await notifier.notifySandboxOOM("sess_1", "512Mi", "512Mi");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends again once the debounce window has elapsed", async () => {
    vi.useFakeTimers();
    const notifier = new SlackNotifier("https://hooks.slack/webhook", ["sandbox_crashed"], 1_000);
    await notifier.notifySandboxCrashed("sess_1", "CrashLoopBackOff");
    vi.advanceTimersByTime(1_001);
    await notifier.notifySandboxCrashed("sess_1", "CrashLoopBackOff");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does not debounce events without a debounce key (e.g. cluster_low_capacity)", async () => {
    const notifier = new SlackNotifier("https://hooks.slack/webhook", ["cluster_low_capacity"], 30_000);
    await notifier.notifyClusterLowCapacity(95, 60);
    await notifier.notifyClusterLowCapacity(95, 60);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("resolves even when the underlying fetch call rejects (fail-open)", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const notifier = new SlackNotifier("https://hooks.slack/webhook", ["sandbox_crashed"]);
    await expect(notifier.notifySandboxCrashed("sess_1", "boom")).rejects.toThrow();
  });
});
