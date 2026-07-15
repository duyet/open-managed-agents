---
title: "Introduction to Open Managed Agents"
description: "Why we're building an open-source meta-harness for AI agents — and why BYOK matters."
publishedAt: 2026-05-08
author: OMA
tags: ["intro", "byok"]
---

Welcome to Open Managed Agents (OMA) — an open-source platform for running
AI agent fleets, designed as a self-hostable alternative to Claude Managed Agents.

## What's a meta-harness?

A **harness** is the loop that runs an agent: read events, build context, call
the model, dispatch tools, persist state, recover from crashes. Most teams
end up writing one. They're roughly the same.

A **meta-harness** is the platform that runs harnesses — sessions, sandboxes,
event log, memory, vaults, tools, integrations. The boring infrastructure
your harness needs but doesn't want to own.

OMA is a meta-harness. Write a harness. Deploy. The platform handles
the rest.

## Why BYOK

We don't want to be in the business of marking up tokens. You already pay
Anthropic / OpenAI / OpenRouter directly. Adding our own token margin on
top would mean a worse rate for the same model, with no value added.

So we charge for what we actually run: the sandbox. Local runtime is free
forever. Cloud sandbox is $0.005/min, billed in 1-minute increments.

## What's next

We're publishing the cloud runtime + Console at oma.duyet.net now (early access)
and the self-host story (Docker + SQLite or Postgres) shortly after. Star
[the repo](https://github.com/duyet/oma) to follow along.
