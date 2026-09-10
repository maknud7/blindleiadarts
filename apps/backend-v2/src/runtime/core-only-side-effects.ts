import type { DbId } from "../contracts/scoring.js";
import type {
  CanonicalEloPort,
  CanonicalPlayoffPort,
  CanonicalProjectionPort,
  CanonicalRealtimePort,
  CanonicalScoringStatePort,
} from "../service/canonical-scoring-service.js";

/**
 * Temporary adapters used only behind MySqlCoreOnlyMutationGuard.
 *
 * The guard restricts writes to isolated E2E tournaments that have no season,
 * playoff, automatic playoff or production/user routing. Keeping these adapters
 * explicit makes the missing side effects visible in the composition root rather
 * than hiding them inside the scoring repository.
 */
export class CoreOnlyCanonicalSideEffects
implements CanonicalPlayoffPort, CanonicalEloPort, CanonicalProjectionPort, CanonicalRealtimePort {
  constructor(private readonly state: CanonicalScoringStatePort) {}

  async assertUndoAllowed(kioskId: DbId): Promise<DbId | null> {
    return this.state.targetMatchIdForKiosk(kioskId, true);
  }

  async afterMutation(_matchId: DbId | null, _wasUndo: boolean): Promise<void> {}

  async applyCompletedMatch(_matchId: DbId): Promise<void> {}

  async revertMatch(_matchId: DbId): Promise<void> {}

  async syncTournamentElo(_matchId: DbId | null): Promise<void> {}

  async reconcileLinearRanking(_matchId: DbId | null): Promise<void> {}

  async publishRefresh(_input: Parameters<CanonicalRealtimePort["publishRefresh"]>[0]): Promise<void> {}
}
