// Adapter wiring for the publications-store. Both CF (D1) and self-host
// (any OmaDb — typically Drizzle-wrapped better-sqlite3 or postgres-js)
// factories live here behind a single SqlPublicationRepo class.

export { SqlPublicationRepo } from "./sql-publication-repo";

import { SqlPublicationRepo } from "./sql-publication-repo";
import { drizzle } from "drizzle-orm/d1";
import type { OmaDb } from "@duyet/oma-db-schema";
import type { Logger } from "../ports";
import { PublicationService } from "../service";

export function createCfPublicationService(
  deps: { db: D1Database },
  opts?: { logger?: Logger },
): PublicationService {
  const drz = drizzle(deps.db);
  return new PublicationService({
    repo: new SqlPublicationRepo(drz),
    logger: opts?.logger,
  });
}

export function createSqlitePublicationService(
  deps: { db: OmaDb },
  opts?: { logger?: Logger },
): PublicationService {
  return new PublicationService({
    repo: new SqlPublicationRepo(deps.db),
    logger: opts?.logger,
  });
}
