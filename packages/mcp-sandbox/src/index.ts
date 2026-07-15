import { z } from "zod";
import { tool } from "ai";
import type { McpSandboxContext, ActiveSandbox, SandboxHandle } from "./types";

export type { McpSandboxContext, ActiveSandbox, SandboxHandle } from "./types";

export function createSandboxManager(ctx: McpSandboxContext) {
  const activeBoxes = new Map<string, ActiveSandbox>();

  return {
    listProviders() {
      return ctx.registry.list().map((p) => ({
        id: p.id,
        type: p.type,
        label: p.label,
        description: p.description,
        is_system: p.isSystem,
        tenant_id: p.tenantId ?? null,
      }));
    },

    getProvider(id: string) {
      const p = ctx.registry.get(id);
      if (!p) return null;
      return {
        id: p.id,
        type: p.type,
        label: p.label,
        description: p.description,
        is_system: p.isSystem,
        tenant_id: p.tenantId ?? null,
      };
    },

    async createSandbox(
      providerId: string,
      config: { sessionId?: string; workdir?: string } = {},
    ): Promise<SandboxHandle> {
      const sid = config.sessionId ?? crypto.randomUUID();
      const workdir = config.workdir ?? "/tmp";
      const executor = await ctx.registry.createExecutor(providerId, { sessionId: sid, workdir }, {});
      const id = crypto.randomUUID();

      activeBoxes.set(id, {
        id,
        providerId,
        executor,
        createdAt: new Date().toISOString(),
      });

      return { id, provider_id: providerId, created_at: new Date().toISOString() };
    },

    async exec(sandboxId: string, command: string, timeout?: number): Promise<{ stdout: string; exit_code: number }> {
      const box = activeBoxes.get(sandboxId);
      if (!box) throw new Error(`Sandbox not found: ${sandboxId}`);
      try {
        const stdout = await box.executor.exec(command, timeout);
        return { stdout, exit_code: 0 };
      } catch (err) {
        return {
          stdout: err instanceof Error ? err.message : String(err),
          exit_code: 1,
        };
      }
    },

    async readFile(sandboxId: string, path: string): Promise<string> {
      const box = activeBoxes.get(sandboxId);
      if (!box) throw new Error(`Sandbox not found: ${sandboxId}`);
      return box.executor.readFile(path);
    },

    async writeFile(sandboxId: string, path: string, content: string): Promise<string> {
      const box = activeBoxes.get(sandboxId);
      if (!box) throw new Error(`Sandbox not found: ${sandboxId}`);
      return box.executor.writeFile(path, content);
    },

    async destroySandbox(sandboxId: string): Promise<void> {
      const box = activeBoxes.get(sandboxId);
      if (!box) throw new Error(`Sandbox not found: ${sandboxId}`);
      await box.executor.destroy?.();
      activeBoxes.delete(sandboxId);
    },

    listActiveSandboxes(): { id: string; provider_id: string; created_at: string }[] {
      return Array.from(activeBoxes.values()).map((b) => ({
        id: b.id,
        provider_id: b.providerId,
        created_at: b.createdAt,
      }));
    },
  };
}

export type SandboxManager = ReturnType<typeof createSandboxManager>;

type ToolSet = Record<string, any>;

export function buildSandboxMcpTools(manager: ReturnType<typeof createSandboxManager> | null): ToolSet {
  if (!manager) return {};

  const tools: ToolSet = {};

  const safe = <Args>(fn: (args: Args) => Promise<string>): ((args: Args) => Promise<string>) =>
    async (args: Args) => {
      try {
        return await fn(args);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    };

  tools.mcp__sandbox__list_providers = tool({
    description: "List all registered sandbox providers (system + BYOK). Returns id, type, label, and system/BYOK status.",
    inputSchema: z.object({}),
    execute: safe(async () => {
      return JSON.stringify(manager.listProviders(), null, 2);
    }),
  });

  tools.mcp__sandbox__create = tool({
    description:
      "Create a new sandbox from a registered provider. Returns a sandbox handle with id, provider_id, and created_at. " +
      "Use the returned id in subsequent mcp__sandbox__exec/read/write/destroy calls.",
    inputSchema: z.object({
      provider_id: z.string().describe("Registered provider id (see list_providers)"),
      workdir: z.string().optional().describe("Working directory inside the sandbox (default /tmp)"),
    }),
    execute: safe(async ({ provider_id, workdir }: { provider_id: string; workdir?: string }) => {
      const handle = await manager.createSandbox(provider_id, { workdir });
      return JSON.stringify(handle, null, 2);
    }),
  });

  tools.mcp__sandbox__exec = tool({
    description:
      "Execute a shell command in an active sandbox. Returns stdout and exit code. " +
      "Bounded by an optional timeout (default 120s, max 600s).",
    inputSchema: z.object({
      sandbox_id: z.string().describe("Sandbox id returned from create"),
      command: z.string().describe("Shell command to execute"),
      timeout: z.number().optional().describe("Timeout in ms (default 120000, max 600000)"),
    }),
    execute: safe(async ({ sandbox_id, command, timeout }: { sandbox_id: string; command: string; timeout?: number }) => {
      const result = await manager.exec(sandbox_id, command, timeout);
      return `exit=${result.exit_code}\n${result.stdout}`;
    }),
  });

  tools.mcp__sandbox__read_file = tool({
    description: "Read a file from an active sandbox filesystem. Returns the full file content.",
    inputSchema: z.object({
      sandbox_id: z.string().describe("Sandbox id returned from create"),
      path: z.string().describe("Absolute file path inside the sandbox"),
    }),
    execute: safe(async ({ sandbox_id, path }: { sandbox_id: string; path: string }) => {
      return manager.readFile(sandbox_id, path);
    }),
  });

  tools.mcp__sandbox__write_file = tool({
    description: "Write content to a file in an active sandbox. Creates parent directories automatically.",
    inputSchema: z.object({
      sandbox_id: z.string().describe("Sandbox id returned from create"),
      path: z.string().describe("Absolute file path inside the sandbox"),
      content: z.string().describe("File content to write"),
    }),
    execute: safe(async ({ sandbox_id, path, content }: { sandbox_id: string; path: string; content: string }) => {
      return manager.writeFile(sandbox_id, path, content);
    }),
  });

  tools.mcp__sandbox__destroy = tool({
    description: "Destroy an active sandbox. Frees all resources. Subsequent operations on this sandbox id will fail.",
    inputSchema: z.object({
      sandbox_id: z.string().describe("Sandbox id to destroy"),
    }),
    execute: safe(async ({ sandbox_id }: { sandbox_id: string }) => {
      await manager.destroySandbox(sandbox_id);
      return `Sandbox ${sandbox_id} destroyed.`;
    }),
  });

  tools.mcp__sandbox__list_active = tool({
    description: "List all currently active sandboxes (id, provider_id, created_at).",
    inputSchema: z.object({}),
    execute: safe(async () => {
      const boxes = manager.listActiveSandboxes();
      if (boxes.length === 0) return "No active sandboxes.";
      return JSON.stringify(boxes, null, 2);
    }),
  });

  return tools;
}
