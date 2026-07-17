---
name: api-design
description: Design HTTP/REST APIs that are consistent, predictable, and safe to evolve. Trigger when the user asks to "design an API", "add an endpoint", "design a REST route", "what should this return", or is shaping request/response contracts, status codes, pagination, versioning, or errors. Covers resource modeling, status codes, error shape, pagination, idempotency, and backward-compatible change.
---

# api-design

A good API is **boring**: a caller who has used one endpoint can guess the next
one. Consistency beats cleverness. Design the contract — URLs, status codes,
request and response shapes — before you write the handler, because the contract
is the part you can't change later without breaking clients.

## Resources and methods

- **Model nouns, not verbs.** `/orders/{id}/items`, not `/getOrderItems`. The
  HTTP method is the verb.
- **Use methods for their meaning:** `GET` read (no side effects), `POST`
  create / non-idempotent action, `PUT` full replace, `PATCH` partial update,
  `DELETE` remove.
- **`GET` is safe and idempotent** — never mutate state in a `GET`. `PUT`,
  `DELETE`, and (ideally) `PATCH` are idempotent: calling twice lands in the
  same state. `POST` is not — protect creates with an idempotency key (below).
- **Plural collections, stable IDs.** `/users`, `/users/{id}`. Nest only for
  genuine ownership (`/users/{id}/sessions`); don't nest more than one level —
  prefer query filters (`/sessions?user_id=…`) over deep trees.

## Status codes

Say what happened with the code, not just the body.

- `200` OK · `201` Created (+ `Location` header) · `202` Accepted (async) ·
  `204` No Content (successful `DELETE`/empty).
- `400` malformed request · `401` unauthenticated · `403` authenticated but
  not allowed · `404` not found · `409` conflict (duplicate, version clash) ·
  `422` well-formed but semantically invalid · `429` rate-limited (+
  `Retry-After`).
- `500` you broke · `502`/`503`/`504` upstream/unavailable. Never return `200`
  with an error inside — that defeats every client's error handling.

## One error shape, everywhere

Pick a single envelope and use it for *every* error, so clients parse one thing:

```json
{
  "error": {
    "code": "insufficient_credits",
    "message": "Balance 3 is below the 10 required for this action.",
    "details": { "balance": 3, "required": 10 }
  }
}
```

- **`code`** is a stable, machine-readable string clients branch on — it never
  changes wording. **`message`** is human-readable and may change. **`details`**
  is optional structured context (which field, which limit).
- Validation errors list every offending field at once, not just the first.
- Never leak stack traces, SQL, or internal hostnames in the message.

## Pagination, filtering, shaping

- **Paginate every list endpoint** from day one — an unbounded list is a
  latent outage. Prefer **cursor** pagination (opaque `cursor` +`limit`,
  returns `next_cursor`) over `offset`/`page` for large or mutating sets: it's
  stable under inserts and cheap at depth.
- Filter and sort with query params (`?status=active&sort=-created_at`); keep
  names consistent across endpoints.
- Return a consistent list envelope (`{ "data": [...], "next_cursor": "..." }`)
  so pagination looks the same everywhere.

## Safe to change

- **Additive-only by default.** Adding an optional field or a new endpoint is
  safe. Removing/renaming a field, tightening validation, or changing a type is
  breaking — version it (`/v2/…` or a header) instead of mutating `/v1`.
- **Clients must ignore unknown fields** — document that so you can add later.
- **Never recycle the meaning of a field or an error `code`.** Old clients
  still believe the old meaning.
- **Defaults are forever.** A default page size, sort order, or timezone is part
  of the contract; changing it silently breaks callers who relied on it.

## Also get right

- **Idempotency for creates:** accept an `Idempotency-Key` header on `POST` and
  return the same result for a repeated key — makes client retries safe.
- **Validate at the boundary.** Reject unknown/invalid input with `400`/`422`
  before any work; don't trust the client.
- **Timestamps in UTC ISO-8601** (`2026-04-29T12:00:00Z`). Money in minor units
  (integer cents), never floats.
- **Auth** via `Authorization` header, never in the URL/query (URLs get logged).
- **Rate-limit** and signal it (`429` + `Retry-After`); document the limits.
