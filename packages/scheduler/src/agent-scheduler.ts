import { nanoid } from "nanoid";
import { getLogger } from "@duyet/oma-observability";

const log = getLogger("scheduler.agent-scheduler");

export interface ScheduleConfig {
  id: string;
  agentId: string;
  cronExpression: string;
  input: string;
  maxSessions: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ScheduleStore {
  insert(config: Omit<ScheduleConfig, "id" | "created_at" | "updated_at">): Promise<string>;
  findByAgentId(agentId: string): Promise<ScheduleConfig[]>;
  findById(id: string): Promise<ScheduleConfig | null>;
  findDue(now: string): Promise<ScheduleConfig[]>;
  update(id: string, patch: Partial<ScheduleConfig>): Promise<void>;
  delete(id: string): Promise<void>;
  deleteByAgentId(agentId: string): Promise<void>;
}

export interface SessionCreator {
  createSession(agentId: string, input: string): Promise<string>;
  sendMessage(sessionId: string, message: string): Promise<void>;
}

interface AgentSchedulerDeps {
  store: ScheduleStore;
  sessionCreator: SessionCreator;
}

export class AgentScheduler {
  private store: ScheduleStore;
  private sessionCreator: SessionCreator;

  constructor(deps: AgentSchedulerDeps) {
    this.store = deps.store;
    this.sessionCreator = deps.sessionCreator;
  }

  async create(config: {
    agentId: string;
    cronExpression: string;
    input: string;
    maxSessions?: number;
    enabled?: boolean;
  }): Promise<ScheduleConfig> {
    const id = `sch_${nanoid(24)}`;
    const now = new Date().toISOString();

    const row: Omit<ScheduleConfig, "id" | "created_at" | "updated_at"> = {
      agentId: config.agentId,
      cronExpression: config.cronExpression,
      input: config.input,
      maxSessions: config.maxSessions ?? 1,
      enabled: config.enabled ?? true,
    };

    await this.store.insert(row);

    log.info(
      { agent_id: config.agentId, cron: config.cronExpression, schedule_id: id },
      "schedule created",
    );

    return {
      id,
      ...row,
      created_at: now,
      updated_at: now,
    };
  }

  async list(agentId: string): Promise<ScheduleConfig[]> {
    return this.store.findByAgentId(agentId);
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(id);
    log.info({ schedule_id: id }, "schedule deleted");
  }

  async onTick(id: string): Promise<void> {
    const config = await this.store.findById(id);
    if (!config || !config.enabled) return;

    log.info(
      { schedule_id: id, agent_id: config.agentId, cron: config.cronExpression },
      "schedule tick",
    );

    try {
      const sessionId = await this.sessionCreator.createSession(
        config.agentId,
        config.input,
      );
      await this.sessionCreator.sendMessage(sessionId, config.input);
    } catch (err) {
      log.error(
        { err, schedule_id: id, agent_id: config.agentId },
        "schedule tick failed",
      );
    }
  }

  async tickDue(): Promise<void> {
    const now = new Date().toISOString();
    const due = await this.store.findDue(now);
    for (const config of due) {
      await this.onTick(config.id);
    }
  }
}

export function parseCronExpression(expression: string): {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
} {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron expression: "${expression}". Expected 5 fields (minute hour dom month dow).`,
    );
  }
  return {
    minute: parts[0],
    hour: parts[1],
    dayOfMonth: parts[2],
    month: parts[3],
    dayOfWeek: parts[4],
  };
}
