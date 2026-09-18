import type { IncomingMessage } from "node:http";

import type { MySqlSessionProvider, TablePrefix } from "../mysql/contracts.js";
import type { MySqlIdentityAuthRepository } from "../mysql/identity-auth-repository.js";
import type { MySqlScoliaKioskAuthRepository } from "../mysql/scolia-kiosk-auth-repository.js";
import { MySqlTournamentBoardAdminRepository } from "../mysql/tournament-board-admin-repository.js";
import { MySqlTournamentHardDeleteRepository } from "../mysql/tournament-hard-delete-repository.js";
import type { MySqlTournamentOperationsRepository } from "../mysql/tournament-operations-repository.js";
import type { MySqlTournamentPlayoffRepository } from "../mysql/tournament-playoff-repository.js";
import type { BackendRuntimeConfig } from "./config.js";
import { TournamentBoardAdminRouter } from "./tournament-board-admin-router.js";
import { TournamentOperationsLegacyRouter, type TournamentOperationsRouteResult } from "./tournament-operations-legacy-router.js";
import type { TournamentRealtimePublisher } from "./tournament-realtime-publisher.js";

export type { TournamentOperationsRouteResult } from "./tournament-operations-legacy-router.js";

export class TournamentOperationsRouter {
  private readonly boardAdmin: TournamentBoardAdminRouter;
  private readonly legacy: TournamentOperationsLegacyRouter;

  constructor(
    config: BackendRuntimeConfig,
    identityRepository: MySqlIdentityAuthRepository,
    kioskAuth: MySqlScoliaKioskAuthRepository,
    operations: MySqlTournamentOperationsRepository,
    playoffs: MySqlTournamentPlayoffRepository,
    realtime: TournamentRealtimePublisher,
  ) {
    // The legacy operations repository already owns the canonical shared session provider.
    // Reuse it so this migration does not create a second pool/connection budget.
    const shared = operations as unknown as { sessions: MySqlSessionProvider; prefix: TablePrefix };
    const boardRepository = new MySqlTournamentBoardAdminRepository(shared.sessions, shared.prefix);
    const hardDeleteRepository = new MySqlTournamentHardDeleteRepository(shared.sessions, shared.prefix);
    this.boardAdmin = new TournamentBoardAdminRouter(config, identityRepository, boardRepository, realtime);
    this.legacy = new TournamentOperationsLegacyRouter(
      config,
      identityRepository,
      kioskAuth,
      operations,
      playoffs,
      hardDeleteRepository,
      realtime,
    );
  }

  async handle(method: string, path: string, request: IncomingMessage): Promise<TournamentOperationsRouteResult | null> {
    const migrated = await this.boardAdmin.handle(method, path, request);
    if (migrated !== null) return migrated;
    return this.legacy.handle(method, path, request);
  }
}
