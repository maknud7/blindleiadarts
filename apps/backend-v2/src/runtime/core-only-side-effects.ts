import type { DbId } from "../contracts/scoring.js";
import type {
  CanonicalEloPort,
  CanonicalPlayoffPort,
  CanonicalProjectionPort,
  CanonicalScoringStatePort,
} from "../service/canonical-scoring-service.js";

/**
 * Temporary adapters used only behind MySqlCoreOnlyMutationGuard.
 *
 * The guard restricts writes to isolated E2E tournaments that have no season,
 * playoff, automatic playoff or production/user routing. Keeping these adapters
 * explicit makes the remaining missing side effects visible in the composition
 * root rather than hiding them inside the scoring repository. Realtime has its
 * own real adapter and is no longer represented here.
 */
export class CoreOnlyCanonicalSideEffects
implements CanonicalPlayoffPort, CanonicalEloPort, CanonicalProjectionPort {
  constructor(private readonly state: CanonicalScoringStatePort) {}

  async assertUndoAllowed(kioskId: DbId): Promise<DbId | null> {
    return this.state.targetMatchIdForKiosk(kioskId, true);
  }

  async afterMutation(_matchId: DbId | null, _wasUndo: boolean): Promise<void> {}

  async applyCompletedMatch(_matchId: DbId): Promise<void> {}

  async revertMatch(_matchId: DbId): Promise<void> {}

  async syncTournamentElo(_matchId: DbId | null): Promise<void> {}

  async reconcileLinearRanking(_matchId: DbId | null): Promise<void> {}
}
