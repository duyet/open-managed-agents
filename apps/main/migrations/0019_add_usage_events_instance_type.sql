-- 0019_add_usage_events_instance_type.sql — track sandbox instance type
-- for per-resource-class billing.
--
-- The usage_events table now carries the sandbox/container instance type
-- (e.g. "lite", "basic", "standard-1") so the billing worker can apply
-- rates per instance class. NULL for legacy rows and non-sandbox kinds
-- (session_alive_seconds, browser_active_seconds).

ALTER TABLE usage_events ADD COLUMN instance_type TEXT;
