import type { MySqlSessionProvider, QueryResultRow, TablePrefix } from "./contracts.js";

export class MySqlMembershipEligibilityRepository {
  constructor(
    private readonly sessions: MySqlSessionProvider,
    private readonly prefix: TablePrefix,
  ) {}

  async forPlayer(playerIdInput: unknown): Promise<Record<string, unknown>> {
    const playerId = decimalId(playerIdInput);
    if (playerId === null) return unavailable("player_missing");
    const player = await this.sessions.withConnection(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT id, club_id, member_id, display_name FROM \`${this.prefix}players\` WHERE id = ? LIMIT 1`,
        [playerId],
      );
      return rows[0] ?? null;
    });
    if (!player) return unavailable("player_not_found");
    const clubId = decimalId(player.club_id);
    const memberId = decimalId(player.member_id);
    if (memberId === null) {
      return { ...unavailable("member_not_linked"), club_id: safeNumber(clubId), player_id: safeNumber(playerId) };
    }
    return this.forMember(memberId, clubId, playerId);
  }

  async forMember(memberId: string, clubId: string | null, playerId: string | null): Promise<Record<string, unknown>> {
    const snapshot = await this.sessions.withConnection(async (db) => {
      const members = await db.query<QueryResultRow>(
        `SELECT id, medlemsnummer, navn, innmeldingsdato, betalingsstatus_override,
                kontingent_start, kontingent_slutt, maanedsbelop
           FROM \`medlemmer\` WHERE id = ? LIMIT 1`,
        [memberId],
      );
      const member = members[0] ?? null;
      if (!member) return null;
      const memberNumber = decimalId(member.medlemsnummer);
      const paymentRows = memberNumber === null ? [] : await db.query<QueryResultRow>(
        `SELECT periode, SUM(belop) AS paid FROM \`kontingentbetalinger\`
          WHERE medlemsnummer = ? GROUP BY periode`,
        [memberNumber],
      );
      const payments: Record<string, number> = {};
      for (const row of paymentRows) {
        const period = String(row.periode ?? "").trim();
        const match = /^(0[1-9]|1[0-2])-(\d{2})$/.exec(period);
        if (!match) continue;
        payments[`20${match[2]}-${match[1]}`] = Number(row.paid ?? 0) || 0;
      }
      const tableExists = await db.query<QueryResultRow>(
        "SELECT 1 AS present FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'stripe_abonnementer' LIMIT 1",
      );
      let stripe: Record<string, unknown> | null = null;
      if (tableExists.length > 0) {
        const stripeRows = await db.query<QueryResultRow>(
          `SELECT status, cancel_at_period_end, ended_at, updated_at FROM \`stripe_abonnementer\`
            WHERE member_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`,
          [memberId],
        );
        const row = stripeRows[0];
        if (row) {
          const status = String(row.status ?? "unknown").trim().toLowerCase();
          stripe = {
            status,
            active: status === "active" || status === "trialing",
            problem: ["past_due", "unpaid", "incomplete", "paused"].includes(status),
            cancel_at_period_end: String(row.cancel_at_period_end ?? "0") === "1",
            ended_at: row.ended_at ?? null,
            updated_at: row.updated_at ?? null,
          };
        }
      }
      let blockAfter = 3;
      if (clubId !== null) {
        const settings = await db.query<QueryResultRow>(
          `SELECT setting_value FROM \`${this.prefix}settings\`
            WHERE club_id = ? AND setting_key = 'membership.registration_block_after_missed_months' LIMIT 1`,
          [clubId],
        );
        if (settings[0]?.setting_value != null && String(settings[0].setting_value).trim() !== "") {
          blockAfter = Math.max(0, Math.min(12, Number(settings[0].setting_value) || 0));
        }
      }
      return { member, payments, stripe, blockAfter };
    });

    if (snapshot === null) {
      return { ...unavailable("member_not_found"), club_id: safeNumber(clubId), player_id: safeNumber(playerId), member_id: safeNumber(memberId) };
    }
    return evaluateMember(snapshot.member, snapshot.payments, snapshot.stripe, snapshot.blockAfter, clubId, playerId);
  }

  async registerPlayer(tournamentIdInput: unknown, playerIdInput: unknown): Promise<Record<string, unknown>> {
    const tournamentId = decimalId(tournamentIdInput);
    const playerId = decimalId(playerIdInput);
    if (tournamentId === null || playerId === null) throw new TypeError("Tournament and player ids are required.");
    await this.sessions.withTransaction(async (db) => {
      const rows = await db.query<QueryResultRow>(
        `SELECT id FROM \`${this.prefix}tournament_players\`
          WHERE tournament_id = ? AND player_id = ? LIMIT 1`,
        [tournamentId, playerId],
      );
      const existingId = decimalId(rows[0]?.id);
      if (existingId !== null) {
        await db.execute(`UPDATE \`${this.prefix}tournament_players\` SET status = 'registered' WHERE id = ?`, [existingId]);
      } else {
        await db.execute(
          `INSERT INTO \`${this.prefix}tournament_players\` (tournament_id, player_id, status) VALUES (?, ?, 'registered')`,
          [tournamentId, playerId],
        );
      }
    });
    return { tournament_id: safeNumber(tournamentId), player_id: safeNumber(playerId), status: "registered" };
  }
}

function evaluateMember(
  member: QueryResultRow,
  payments: Record<string, number>,
  stripe: Record<string, unknown> | null,
  blockAfter: number,
  clubId: string | null,
  playerId: string | null,
): Record<string, unknown> {
  const current = currentMonthOslo();
  const previous = addMonths(current, -1);
  const monthlyAmount = Math.max(0.01, Number(member.maanedsbelop ?? 200) || 200);
  const startRaw = String(member.kontingent_start ?? member.innmeldingsdato ?? current.key).trim() || current.key;
  const duesStart = monthFromDate(startRaw) ?? current;
  const endRaw = String(member.kontingent_slutt ?? "").trim();
  const duesEnd = endRaw === "" ? null : monthFromDate(endRaw);
  const memberId = decimalId(member.id);
  const memberNumber = decimalId(member.medlemsnummer);
  const currentPaid = payments[current.key] ?? 0;
  const previousPaid = payments[previous.key] ?? 0;
  const currentRemaining = Math.max(0, monthlyAmount - currentPaid);
  const previousRemaining = Math.max(0, monthlyAmount - previousPaid);
  const activeStripe = stripe?.active === true;
  const stripeProblem = stripe?.problem === true;
  const missedClosedMonths = consecutiveUnpaid(payments, previous, duesStart, duesEnd);
  const override = String(member.betalingsstatus_override ?? "automatisk").trim().toLowerCase() || "automatisk";

  const base: Record<string, unknown> = {
    player_id: safeNumber(playerId),
    club_id: safeNumber(clubId),
    member_id: safeNumber(memberId),
    member_number: safeNumber(memberNumber),
    member_name: String(member.navn ?? ""),
    member_active: true,
    status_override: override,
    dues_start: `${duesStart.key}-01`,
    dues_end: duesEnd ? `${duesEnd.key}-01` : null,
    monthly_amount: monthlyAmount,
    current_period: current.key,
    current_period_label: periodLabel(current),
    current_paid: round2(currentPaid),
    current_remaining: round2(currentRemaining),
    previous_period: previous.key,
    previous_period_label: periodLabel(previous),
    previous_paid: round2(previousPaid),
    previous_remaining: round2(previousRemaining),
    missed_closed_months: missedClosedMonths,
    block_after_missed_months: blockAfter,
    stripe,
  };

  if (override === "inaktiv" || (duesEnd !== null && compareMonth(duesEnd, current) < 0)) {
    return status(base, "blocked", "membership_inactive", false, true, "Medlemskapet må avklares", "Medlemskapet står som inaktivt. Kontakt klubben før du melder deg på nye turneringer.", false);
  }
  if (override === "ikke_fast") return status(base, "exempt", "payment_not_required", true, false, null, null);
  if (compareMonth(duesStart, current) > 0) return status(base, "not_due", "dues_not_started", true, false, null, null);

  const hasCurrentPayment = currentPaid > 0.001;
  if (!activeStripe && !hasCurrentPayment && blockAfter > 0 && missedClosedMonths >= blockAfter) {
    return status(base, "blocked", "payment_too_far_overdue", false, true, "Kontingenten må ordnes", `Vi har ikke registrert betaling de siste ${missedClosedMonths} avsluttede månedene. Ordne kontingenten før du melder deg på nye turneringer.`);
  }
  if (stripeProblem) return status(base, "payment_problem", "stripe_needs_attention", true, true, "Fast betaling trenger oppfølging", "Stripe-avtalen krever oppfølging. Du kan fortsatt melde deg på, men betalingsavtalen bør ordnes.");
  if (activeStripe) return status(base, "ok", "active_autodebit", true, false, null, null);
  if (compareMonth(previous, duesStart) >= 0 && previousRemaining > 0.001) {
    return status(base, "overdue", "previous_period_incomplete", true, true, "Kontingent mangler", `${periodLabel(previous)} er ikke fullt registrert. Du kan fortsatt melde deg på nå, men betalingen bør ordnes.`);
  }
  if (currentRemaining > 0.001) {
    return status(base, "due", "current_period_incomplete", true, true, "Kontingent denne måneden", `Vi mangler ${money(currentRemaining)} for ${periodLabel(current).toLowerCase()}. Påmelding er fortsatt åpen.`);
  }
  return status(base, "ok", "paid", true, false, null, null);
}

function status(base: Record<string, unknown>, state: string, reason: string, canRegister: boolean, actionRequired: boolean, headline: string | null, message: string | null, memberActive = true): Record<string, unknown> {
  return { ...base, member_active: memberActive, status: state, reason_code: reason, can_register: canRegister, action_required: actionRequired, headline, message };
}
function unavailable(reason: string): Record<string, unknown> {
  return { status: "unavailable", reason_code: reason, member_active: true, can_register: true, action_required: false, headline: null, message: null };
}
interface Month { year: number; month: number; key: string }
function currentMonthOslo(): Month {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  return monthValue(year, month);
}
function monthFromDate(value: string): Month | null {
  const m = /^(\d{4})-(\d{2})/.exec(value);
  if (!m) return null;
  const year = Number(m[1]); const month = Number(m[2]);
  if (!Number.isInteger(year) || month < 1 || month > 12) return null;
  return monthValue(year, month);
}
function monthValue(year: number, month: number): Month { return { year, month, key: `${year}-${String(month).padStart(2, "0")}` }; }
function addMonths(value: Month, delta: number): Month {
  const d = new Date(Date.UTC(value.year, value.month - 1 + delta, 1));
  return monthValue(d.getUTCFullYear(), d.getUTCMonth() + 1);
}
function compareMonth(a: Month, b: Month): number { return (a.year * 12 + a.month) - (b.year * 12 + b.month); }
function consecutiveUnpaid(payments: Record<string, number>, lastClosed: Month, start: Month, end: Month | null): number {
  let cursor = end && compareMonth(end, lastClosed) < 0 ? end : lastClosed;
  let count = 0;
  for (let guard = 0; guard < 24 && compareMonth(cursor, start) >= 0; guard += 1, cursor = addMonths(cursor, -1)) {
    if ((payments[cursor.key] ?? 0) > 0.001) break;
    count += 1;
  }
  return count;
}
const MONTHS = ["", "Januar", "Februar", "Mars", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Desember"];
function periodLabel(value: Month): string { return `${MONTHS[value.month]} ${value.year}`; }
function money(value: number): string {
  const decimals = Math.abs(value - Math.round(value)) < 0.001 ? 0 : 2;
  return `${value.toLocaleString("nb-NO", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} kr`;
}
function round2(value: number): number { return Math.round((value + Number.EPSILON) * 100) / 100; }
function decimalId(value: unknown): string | null { const s=String(value??"").trim(); return /^[1-9][0-9]*$/.test(s)?s:null; }
function safeNumber(value: unknown): number | null { const s=decimalId(value); if(!s)return null; const n=Number(s); return Number.isSafeInteger(n)?n:null; }
