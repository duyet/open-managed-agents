// Node adapter that resolves tenant via the same `membership` table the
// auth middleware uses on Node. The CF adapter reads `user.tenantId`
// because better-auth-on-D1 still owns the user row; on Node we live next
// to the membership table directly, so a one-row JOIN against that is
// the simpler answer and matches what the auth bootstrap sets up.

import type { SqlClient } from "@duyet/oma-sql-client";
import type { TenantResolver } from "@duyet/oma-integrations-core";

export class SqlMembershipTenantResolver implements TenantResolver {
  constructor(private readonly db: SqlClient) {}

  async resolveByUserId(userId: string): Promise<string> {
    const row = await this.db
      .prepare(
        `SELECT tenant_id FROM membership
          WHERE user_id = ?
          ORDER BY created_at ASC, tenant_id ASC LIMIT 1`,
      )
      .bind(userId)
      .first<{ tenant_id: string }>();
    if (!row?.tenant_id) {
      throw new Error(
        `TenantResolver: no membership for userId=${userId} (user must complete auth bootstrap)`,
      );
    }
    return row.tenant_id;
  }
}
