import type {
  CanonicalScoringPort,
  RecordVisitCommand,
  StartMatchCommand,
  UndoVisitCommand,
} from "../contracts/canonical-scoring.js";
import type { DbId } from "../contracts/scoring.js";
import type {
  MySqlCanonicalScoringRepository,
  RecordVisitWriteResult,
  StartMatchWriteResult,
  UndoVisitWriteResult,
} from "../mysql/canonical-scoring-repository.js";

export interface StartScoringState {
  readonly id: DbId;
  readonly status: "assigned" | "in_progress";
  readonly has_open_leg: boolean;
}

export interface CanonicalScoringStatePort {
  startState(kioskId: DbId): Promise<StartScoringState | null>;
  targetMatchIdForKiosk(kioskId: DbId, includeCompleted: boolean): Promise<DbId | null>;
  matchIsCompleted(matchId: DbId): Promise<boolean>;
}

export interface CanonicalPlayoffPort {
  assertUndoAllowed(kioskId: DbId): Promise<DbId | null>;
  afterMutation(matchId: DbId | null, wasUndo: boolean): Promise<void>;
}

export interface CanonicalEloPort {
  applyCompletedMatch(matchId: DbId): Promise<void>;
  revertMatch(matchId: DbId): Promise<void>;
}

export interface CanonicalProjectionPort {
  syncTournamentElo(matchId: DbId | null): Promise<void>;
  reconcileLinearRanking(matchId: DbId | null): Promise<void>;
}

export interface CanonicalRealtimePort {
  publishRefresh(input: {
    kiosk_id: DbId;
    match_id: DbId | null;
    source: StartMatchCommand["source"];
    reason: "match_started" | "visit_recorded" | "visit_undone";
  }): Promise<void>;
}

export interface CanonicalScoringRepositoryPort {
  startMatch(command: StartMatchCommand): Promise<StartMatchWriteResult>;
  recordVisit(command: RecordVisitCommand): Promise<RecordVisitWriteResult>;
  undoLastVisit(command: UndoVisitCommand): Promise<UndoVisitWriteResult>;
}

/**
 * Source-agnostic canonical scoring orchestration.
 *
 * The call order intentionally mirrors PHP CanonicalScoringService. Database
 * mutation stays in the scoring repository; ELO, playoff lifecycle, projections
 * and realtime remain post-mutation side effects behind explicit ports so they
 * can be migrated independently without changing kiosk/Scolia callers.
 */
export class CanonicalScoringService implements CanonicalScoringPort {
  constructor(
    private readonly repository: CanonicalScoringRepositoryPort,
    private readonly state: CanonicalScoringStatePort,
    private readonly playoffs: CanonicalPlayoffPort,
    private readonly elo: CanonicalEloPort,
    private readonly projections: CanonicalProjectionPort,
    private readonly realtime: CanonicalRealtimePort,
  ) {}

  async startMatch(command: StartMatchCommand): Promise<void> {
    const before = await this.state.startState(command.kiosk_id);
    await this.repository.startMatch(command);

    // Matches PHP: repeated start calls while an open leg already exists are true
    // no-ops for playoff reconciliation and realtime publication.
    if (before === null || (before.status === "in_progress" && before.has_open_leg)) {
      return;
    }

    await this.playoffs.afterMutation(before.id, false);
    await this.realtime.publishRefresh({
      kiosk_id: command.kiosk_id,
      match_id: before.id,
      source: command.source,
      reason: "match_started",
    });
  }

  async recordVisit(command: RecordVisitCommand): Promise<void> {
    // PHP resolves the target before recording. Preserve that detail so a retry
    // after checkout still reconciles/publishes against the same completed match.
    const matchId = await this.state.targetMatchIdForKiosk(command.kiosk_id, false);
    await this.repository.recordVisit(command);

    if (matchId !== null && await this.state.matchIsCompleted(matchId)) {
      await this.elo.applyCompletedMatch(matchId);
    }

    await this.playoffs.afterMutation(matchId, false);
    await this.projections.syncTournamentElo(matchId);
    await this.projections.reconcileLinearRanking(matchId);
    await this.realtime.publishRefresh({
      kiosk_id: command.kiosk_id,
      match_id: matchId,
      source: command.source,
      reason: "visit_recorded",
    });
  }

  async undoLastVisit(command: UndoVisitCommand): Promise<void> {
    // The playoff guard must execute before canonical state is mutated.
    const matchId = await this.playoffs.assertUndoAllowed(command.kiosk_id);
    await this.repository.undoLastVisit(command);

    if (matchId !== null) {
      await this.elo.revertMatch(matchId);
    }

    await this.playoffs.afterMutation(matchId, true);
    await this.projections.syncTournamentElo(matchId);
    await this.projections.reconcileLinearRanking(matchId);
    await this.realtime.publishRefresh({
      kiosk_id: command.kiosk_id,
      match_id: matchId,
      source: command.source,
      reason: "visit_undone",
    });
  }
}

// Compile-time compatibility assertion without constructing the concrete class.
type RepositoryCompatibility = MySqlCanonicalScoringRepository extends CanonicalScoringRepositoryPort ? true : never;
const repositoryCompatibility: RepositoryCompatibility = true;
void repositoryCompatibility;
