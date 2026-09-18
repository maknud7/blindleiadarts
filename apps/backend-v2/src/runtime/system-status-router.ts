import type { IncomingMessage } from "node:http";

import type { MySqlClubAdminRepository } from "../mysql/club-admin-repository.js";
import type { MySqlEquipmentAdminRepository } from "../mysql/equipment-admin-repository.js";
import type { IdentityUser, MySqlIdentityAuthRepository } from "../mysql/identity-auth-repository.js";
import type { MySqlScoliaDashboardRepository } from "../mysql/scolia-dashboard-repository.js";
import type { MySqlTournamentCatalogReadRepository } from "../mysql/tournament-catalog-read-repository.js";
import {
  mutationsAllowed,
  RuntimeAccessError,
  type BackendRuntimeConfig,
} from "./config.js";

export interface SystemStatusRouteResult {
  readonly statusCode: number;
  readonly payload: Record<string, unknown>;
}

export class SystemStatusRouter {
  constructor(
    private readonly config: BackendRuntimeConfig,
    private readonly identityRepository: MySqlIdentityAuthRepository,
    private readonly clubs: MySqlClubAdminRepository,
    private readonly tournaments: MySqlTournamentCatalogReadRepository,
    private readonly equipment: MySqlEquipmentAdminRepository,
    private readonly scoliaDashboard: MySqlScoliaDashboardRepository,
  ) {}

  async handle(
    method: string,
    path: string,
    request: IncomingMessage,
  ): Promise<SystemStatusRouteResult | null> {
    if (method !== "GET" || path !== "/v1/system/status") return null;

    const admin = await this.requireAdmin(request);
    const url = new URL(request.url ?? path, "http://backend-v2.internal");
    const clubId = positiveQueryId(url.searchParams.get("club_id"));
    if (clubId !== null) this.requireClubScope(admin, clubId);

    const databaseConnected = await this.clubs.ping();
    const clubItems = await this.clubs.list();
    const pendingPairings = await this.equipment.listAllPendingPairingRequests();

    let clubStatus: Record<string, unknown> | null = null;
    if (clubId !== null) {
      const club = await this.clubs.findById(clubId);
      if (club !== null) {
        const dashboard = await this.tournaments.getClubDashboard(clubId);
        const activeScreenTournament = await this.tournaments.findScreenTournamentByClubId(clubId);
        const clubPendingPairings = (await this.equipment.listPendingPairingRequests(clubId))
          .filter((item) => String(item.club_id ?? "") === clubId);
        const screenDevices = await this.scoliaDashboard.listScreenDevices(clubId);
        clubStatus = {
          club,
          dashboard,
          active_screen_tournament: activeScreenTournament,
          pending_pairing_requests: clubPendingPairings.length,
          screen_devices: screenDevices,
        };
      }
    }

    const realtimeEnabled = this.config.realtime.websocketUrl !== null;
    return {
      statusCode: 200,
      payload: {
        ok: true,
        environment: this.config.environment,
        server_time: new Date().toISOString(),
        services: [
          {
            key: "api",
            label: "Backend v2 API",
            status: "ok",
            detail: `Backend-v2 responderer og kjører i ${this.config.environment}.`,
          },
          {
            key: "database",
            label: "Database",
            status: databaseConnected ? "ok" : "error",
            detail: databaseConnected ? "Databaseforbindelse er oppe." : "Databaseforbindelsen svarer ikke.",
          },
          {
            key: "realtime",
            label: "Realtime relay",
            status: realtimeEnabled ? "ok" : "warning",
            detail: realtimeEnabled
              ? "Websocket/SSE er konfigurert."
              : "Fallback til polling. Ingen websocket-URL konfigurert.",
          },
          {
            key: "screen",
            label: "Venue screen",
            status: "ok",
            detail: "/live/ er canonical vegg- og livevisning.",
          },
        ],
        summary: {
          clubs: clubItems.length,
          pending_pairing_requests: pendingPairings.length,
        },
        club: clubStatus,
      },
    };
  }

  private async requireAdmin(request: IncomingMessage): Promise<IdentityUser> {
    const token = bearerToken(request);
    if (token === null) {
      throw new RuntimeAccessError(
        401,
        "missing_bearer_token",
        "Authorization header with Bearer token is required.",
      );
    }
    const user = await this.identityRepository.findBySessionToken(token, this.identityTouchAllowed());
    if (user === null) throw new RuntimeAccessError(401, "invalid_session", "Session token is invalid or expired.");
    const role = String(user.role ?? "player");
    if (role !== "club_admin" && role !== "super_admin") {
      throw new RuntimeAccessError(403, "admin_required", "Admin role is required for this endpoint.");
    }
    return user;
  }

  private requireClubScope(user: IdentityUser, clubId: string): void {
    if (String(user.role ?? "") === "super_admin") return;
    if (String(user.role ?? "") === "club_admin" && String(user.player_club_id ?? "") === clubId) return;
    throw new RuntimeAccessError(
      403,
      "club_admin_scope_denied",
      "This admin account does not manage the selected club.",
    );
  }

  private identityTouchAllowed(): boolean {
    return (
      (this.config.environment === "prod" && this.config.prefixes.identity === "bd_prod_" && mutationsAllowed(this.config)) ||
      (this.config.environment === "test" && this.config.prefixes.identity === "bd_test_" && mutationsAllowed(this.config))
    );
  }
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = header(request, "authorization")?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const token = match?.[1]?.trim() ?? "";
  return token === "" ? null : token;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function positiveQueryId(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}
