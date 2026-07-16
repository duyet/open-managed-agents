-- 0028_publication_environment.sql — publications carry an optional
-- environment binding (issue #225).
--
-- POST /p/:slug/sessions (the public chat surface) forwards no
-- environment_id today, so a published *cloud* agent 400s at session-create
-- ("environment_id is required for cloud agents"). Mirrors how deployments
-- carry environment_id (0023_deployments.sql), set at publish time; here it's
-- nullable because a local-runtime (self-hosted) published agent never needs
-- one.

ALTER TABLE agent_publication ADD COLUMN environment_id TEXT;
