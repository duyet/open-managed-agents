// Public surface of @duyet/oma-session-runtime.
//
// Phase 2 of the unified-runtime refactor: SessionStateMachine + the
// shared RuntimeAdapterImpl land here so apps/main-node (Node) can
// adopt them. Phase 3 swaps apps/agent's SessionDO to use the same
// SessionStateMachine.
//
// See nifty-prancing-flamingo.md plan for the full architecture.

export {
  recoverInterruptedState,
  type RecoveryReport,
  type RecoveryWarning,
} from "./recovery";

export type { RuntimeAdapter, TurnId, OrphanTurn } from "./ports";
export { RuntimeAdapterImpl, type RuntimeAdapterOptions } from "./adapter";
export {
  SessionStateMachine,
  type SessionMachineDeps,
  type HarnessRunFn,
} from "./machine";

export {
  fireAgentHook,
  makePreToolPayload,
  makePostToolPayload,
  type AgentHookConfig,
} from "./hooks";

export {
  runWithTurnWatchdog,
  resolveTurnTimeoutMs,
  TurnWatchdogTimeoutError,
  DEFAULT_TURN_TIMEOUT_MS,
} from "./watchdog";

export type {
  SessionRouter,
  SessionInitParams,
  SessionEventsQuery,
  SessionEventsPage,
  SessionFullStatus,
  SessionExecResult,
  SessionAppendResult,
  SessionStreamFrame,
  SessionStreamHandle,
  FileIdResolver,
} from "./router";

