-- Session token usage columns (Observability analytics tab).
--
-- Cumulative model token usage for the whole session, summed from
-- span.model_request_end events by RuntimeAdapterImpl.endTurn/terminate on
-- every idle/destroyed/terminated transition (the same write path that
-- already refreshes stop_reason / tool_call_count / message_count in 0002).
--
-- Lets GET /v1/analytics/overview and GET /v1/agents/:id/analytics aggregate
-- token totals + per-session percentiles across sessions from the shared
-- control-plane D1 without replaying per-session DO event logs.

ALTER TABLE `sessions` ADD `input_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `output_tokens` integer DEFAULT 0 NOT NULL;
