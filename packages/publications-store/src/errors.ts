/** Typed errors so HTTP handlers can map to status codes without leaking internals. */

export class PublicationNotFoundError extends Error {
  readonly code = "publication_not_found";
  constructor(message = "Publication not found") {
    super(message);
  }
}

/** Slug already taken (unique index violation on insert or slug update). */
export class PublicationSlugConflictError extends Error {
  readonly code = "publication_slug_conflict";
  constructor(message = "Slug already in use") {
    super(message);
  }
}
