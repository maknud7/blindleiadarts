import type { DbId } from "../contracts/scoring.js";
import type {
  CanonicalPlayoffPort,
  CanonicalRankingPort,
  CanonicalScoringStatePort,
} from "../service/canonical-scoring-service.js";

/**
 * Temporary adapters used only behind MySqlCoreOnlyMutationGuard.
 *
 * Season ELO, tournament ELO and realtime now have real adapters. The remaining
 * no-op surface is intentionally limited to playoff reconciliation and linear
 * ranking until those final side-effect migrations are complete.
 */
export class CoreOnlyCanonicalSideEffects
implements CanonicalPlayoffPort, CanonicalRankingPort {
  constructor(private readonly state: CanonicalScoringStatePort) {}

  async assertUndoAllowed(kioskId: DbId): Promise<DbId | null> {
    return this.state.targetMatchIdForKiosk(kioskId, true);
  }

  async afterMutation(_matchId: DbId | null, _wasUndo: boolean): Promise<void> {}

  async reconcileLinearRanking(_matchId: DbId | null): Promise<void> {}
}
