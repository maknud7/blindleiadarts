import { createHash, randomBytes } from "node:crypto";

import { DomainValidationError } from "../domain/errors.js";

export interface TournamentSeedCandidate {
  tournament_player_id: string;
  player_id: string;
  display_name: string;
  nickname: string | null;
  elo_rating: number;
  elo_rating_source: string;
  seed_number?: number;
  seed_rating?: number;
  group_position?: number;
}

export interface TournamentGroupAllocation {
  mode: "random" | "elo_snake" | "elo_pots";
  draw_seed: string;
  groups: Array<{
    name: string;
    sort_order: number;
    players: TournamentSeedCandidate[];
  }>;
}

export class TournamentGroupService {
  allocate(
    registrations: TournamentSeedCandidate[],
    groupCount: number,
    modeInput: string,
    drawSeedInput: unknown = null,
  ): TournamentGroupAllocation {
    const mode = modeInput.trim().toLowerCase();
    if (mode !== "random" && mode !== "elo_snake" && mode !== "elo_pots") {
      throw new DomainValidationError("invalid_group_draw_mode", "Unsupported group draw mode.");
    }
    const players = registrations.map((player) => ({ ...player }));
    if (players.length < 2) {
      throw new DomainValidationError("insufficient_group_players", "At least two registered players are required.");
    }
    if (!Number.isInteger(groupCount) || groupCount < 1 || groupCount > players.length) {
      throw new DomainValidationError(
        "invalid_group_count",
        "Group count must be between 1 and the number of players.",
      );
    }
    if (Math.floor(players.length / groupCount) < 4) {
      throw new DomainValidationError("group_too_small", "Hver gruppe må ha minst 4 spillere.");
    }

    const drawSeed = drawSeedInput == null || String(drawSeedInput).trim() === ""
      ? randomUnsigned63()
      : unsignedDecimal(drawSeedInput, "draw_seed");
    const seeded = withSeedNumbers(players);
    const groups: TournamentGroupAllocation["groups"] = Array.from({ length: groupCount }, (_, index) => ({
      name: groupName(index),
      sort_order: index + 1,
      players: [],
    }));

    if (mode === "elo_snake") {
      seeded.forEach((player, index) => {
        const cycle = Math.floor(index / groupCount);
        const offset = index % groupCount;
        const groupIndex = cycle % 2 === 0 ? offset : groupCount - 1 - offset;
        groups[groupIndex]?.players.push(player);
      });
    } else if (mode === "elo_pots") {
      for (let start = 0, potIndex = 0; start < seeded.length; start += groupCount, potIndex += 1) {
        const pot = seeded.slice(start, start + groupCount).sort((a, b) =>
          randomKey(drawSeed, potIndex, a.player_id).localeCompare(randomKey(drawSeed, potIndex, b.player_id)),
        );
        pot.forEach((player, offset) => groups[offset]?.players.push(player));
      }
    } else {
      const randomized = [...seeded].sort((a, b) =>
        randomKey(drawSeed, 0, a.player_id).localeCompare(randomKey(drawSeed, 0, b.player_id)),
      );
      randomized.forEach((player, index) => groups[index % groupCount]?.players.push(player));
    }

    for (const group of groups) {
      group.players.forEach((player, index) => {
        player.group_position = index + 1;
      });
    }

    return { mode, draw_seed: drawSeed, groups };
  }

  roundRobin(players: Array<{ player_id: string }>): Array<Array<{ player_a_id: string; player_b_id: string }>> {
    const ids = players
      .map((player) => unsignedDecimal(player.player_id, "player_id"))
      .filter((value) => value !== "0");
    if (ids.length < 2) return [];

    const rotation: Array<string | null> = [...ids];
    if (rotation.length % 2 === 1) rotation.push(null);
    const roundCount = rotation.length - 1;
    const half = rotation.length / 2;
    const rounds: Array<Array<{ player_a_id: string; player_b_id: string }>> = [];

    for (let round = 0; round < roundCount; round += 1) {
      const pairs: Array<{ player_a_id: string; player_b_id: string }> = [];
      for (let index = 0; index < half; index += 1) {
        let a = rotation[index] ?? null;
        let b = rotation[rotation.length - 1 - index] ?? null;
        if (a !== null && b !== null) {
          if (round % 2 === 1 && index === 0) [a, b] = [b, a];
          pairs.push({ player_a_id: a, player_b_id: b });
        }
      }
      rounds.push(pairs);
      const fixed = rotation.shift() ?? null;
      const last = rotation.pop() ?? null;
      rotation.unshift(last);
      rotation.unshift(fixed);
    }
    return rounds;
  }
}

function withSeedNumbers(players: TournamentSeedCandidate[]): TournamentSeedCandidate[] {
  const sorted = [...players].sort((a, b) => {
    if (b.elo_rating !== a.elo_rating) return b.elo_rating - a.elo_rating;
    const name = a.display_name.localeCompare(b.display_name, "nb", { sensitivity: "base" });
    if (name !== 0) return name;
    const aId = BigInt(a.player_id);
    const bId = BigInt(b.player_id);
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });
  return sorted.map((player, index) => ({
    ...player,
    seed_number: index + 1,
    seed_rating: player.elo_rating,
  }));
}

function randomKey(drawSeed: string, potIndex: number, playerId: string): string {
  return createHash("sha256").update(`${drawSeed}:${potIndex}:${playerId}`).digest("hex");
}

function randomUnsigned63(): string {
  const bytes = randomBytes(8);
  bytes[0] = (bytes[0] ?? 0) & 0x7f;
  const value = BigInt(`0x${bytes.toString("hex")}`);
  return (value === 0n ? 1n : value).toString(10);
}

function unsignedDecimal(value: unknown, name: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[0-9]+$/.test(normalized)) {
    throw new DomainValidationError("invalid_id", `${name} must be an unsigned decimal integer.`, 400);
  }
  const parsed = BigInt(normalized);
  if (parsed < 0n || parsed > 18446744073709551615n) {
    throw new DomainValidationError("invalid_id", `${name} is outside BIGINT UNSIGNED range.`, 400);
  }
  return parsed.toString(10);
}

function groupName(index: number): string {
  let name = "";
  let value = index;
  do {
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return `Gruppe ${name}`;
}
