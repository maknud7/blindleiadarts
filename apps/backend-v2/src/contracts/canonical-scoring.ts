import type { DbId, VisitInput } from "./scoring.js";

export type ScoringSource = "manual" | "scolia" | "import" | "api";

export interface StartMatchCommand {
  kiosk_id: DbId;
  source: ScoringSource;
}

export interface RecordVisitCommand {
  kiosk_id: DbId;
  source: ScoringSource;
  payload: VisitInput;
}

export interface UndoVisitCommand {
  kiosk_id: DbId;
  source: ScoringSource;
}

/**
 * Source-agnostic mutation boundary matching today's CanonicalScoringService.
 * Adapters normalize input before calling this port; ELO, playoff reconciliation,
 * projections and realtime refresh stay behind the canonical scoring boundary.
 */
export interface CanonicalScoringPort {
  startMatch(command: StartMatchCommand): Promise<void> | void;
  recordVisit(command: RecordVisitCommand): Promise<void> | void;
  undoLastVisit(command: UndoVisitCommand): Promise<void> | void;
}
