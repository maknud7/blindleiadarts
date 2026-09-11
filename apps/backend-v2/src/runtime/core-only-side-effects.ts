import type { DbId } from "../contracts/scoring.js";
import type {
  CanonicalPlayoffPort,
  CanonicalScoringStatePort,
} from "../service/canonical-scoring-service.js";

/**
 * Temporary adapter used only behind MySqlCoreOnlyMutationGuard.
 *
 * Realtime, season ELO, tournament ELO and linear ranking now have real
 * adapters. Playoff reconciliation is the final remaining canonical no-op and
 * keeps production scoring writes compile-time blocked until it is migrated.
 */
export class CoreOnlyCanonicalSideEffects implements CanonicalPlayoffPort {
  constructor(private readonly state: CanonicalScoringStatePort) {}

  async assertUndoAllowed(kioskId: DbId): Promise<DbId | null> {
    return this.state.targetMatchIdForKiosk(kioskId, true);
  }

  async afterMutation(_matchId: DbId | null, _wasUndo: boolean): Promise<void> {}
}
