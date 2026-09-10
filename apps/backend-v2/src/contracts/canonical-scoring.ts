import type { DbId, EvaluatedVisit, VisitInput } from "./scoring.js";

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

export type StartMatchResult =
  | { readonly kind: "no_match" }
  | { readonly kind: "started"; readonly match_id: DbId; readonly leg_id: DbId };

export type RecordVisitResult =
  | { readonly kind: "duplicate" }
  | {
      readonly kind: "recorded";
      readonly match_id: DbId;
      readonly leg_id: DbId;
      readonly player_id: DbId;
      readonly evaluation: EvaluatedVisit;
      readonly match_completed: boolean;
    };

export type UndoVisitResult =
  | { readonly kind: "no_visit" }
  | {
      readonly kind: "undone";
      readonly match_id: DbId;
      readonly leg_id: DbId;
      readonly visit_id: DbId;
    };

/**
 * Source-agnostic mutation boundary matching today's CanonicalScoringService.
 * Adapters normalize input before calling this port; ELO, playoff reconciliation,
 * projections and realtime refresh stay behind the canonical scoring boundary.
 */
export interface CanonicalScoringPort {
  startMatch(command: StartMatchCommand): Promise<StartMatchResult> | StartMatchResult;
  recordVisit(command: RecordVisitCommand): Promise<RecordVisitResult> | RecordVisitResult;
  undoLastVisit(command: UndoVisitCommand): Promise<UndoVisitResult> | UndoVisitResult;
}
