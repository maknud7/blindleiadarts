<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

use Blindleia\Dartkiosk\Api\Repository\ExternalReferenceRepository;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

final class ChallongeImportService
{
    private mysqli $connection;
    private string $tablePrefix;
    private ExternalReferenceRepository $externalReferences;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
        $this->externalReferences = new ExternalReferenceRepository($database);
    }

    /**
     * @param array<string, mixed> $tournament
     * @param array<int, array<string, mixed>> $participants
     * @param array<int, array<string, mixed>> $matches
     * @return array<string, mixed>
     */
    public function importTournament(array $tournament, array $participants, array $matches): array
    {
        $context = $this->ensureDefaultContext();
        $tournamentId = $this->upsertTournament($context['club_id'], $context['season_id'], $tournament);

        $playerMap = [];
        $participantCount = 0;

        foreach ($participants as $participant) {
            $externalId = (string) ($participant['id'] ?? '');
            if ($externalId === '') {
                continue;
            }

            $playerId = $this->upsertPlayer($context['club_id'], $participant);
            $this->externalReferences->upsert('challonge', 'participant', $externalId, 'player', $playerId);
            $this->upsertTournamentPlayer($tournamentId, $playerId, $participant);
            $playerMap[$externalId] = $playerId;
            $participantCount++;
        }

        $importedMatches = 0;
        $skippedMatches = 0;

        foreach ($matches as $match) {
            $result = $this->upsertMatch($tournamentId, $match, $playerMap);
            if ($result) {
                $importedMatches++;
            } else {
                $skippedMatches++;
            }
        }

        return [
            'club_id' => $context['club_id'],
            'season_id' => $context['season_id'],
            'tournament_id' => $tournamentId,
            'participants_imported' => $participantCount,
            'matches_imported' => $importedMatches,
            'matches_skipped' => $skippedMatches,
        ];
    }

    /**
     * @return array{club_id:int,season_id:int}
     */
    private function ensureDefaultContext(): array
    {
        $clubId = $this->findFirstClubId();

        if ($clubId === null) {
            $clubId = $this->createDefaultClub();
        }

        $seasonId = $this->findActiveSeasonId($clubId);

        if ($seasonId === null) {
            $seasonId = $this->createDefaultSeason($clubId);
        }

        return [
            'club_id' => $clubId,
            'season_id' => $seasonId,
        ];
    }

    private function findFirstClubId(): ?int
    {
        $sql = sprintf('SELECT id FROM `%1$sclubs` ORDER BY id ASC LIMIT 1', $this->tablePrefix);
        $result = $this->connection->query($sql);
        $row = $result?->fetch_assoc();
        return $row !== null ? (int) $row['id'] : null;
    }

    private function createDefaultClub(): int
    {
        $name = 'Blindleia Dartklubb';
        $slug = 'blindleia-dartklubb';

        $sql = sprintf('INSERT INTO `%1$sclubs` (name, slug) VALUES (?, ?)', $this->tablePrefix);
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('ss', $name, $slug);
        $statement->execute();
        $id = (int) $statement->insert_id;
        $statement->close();

        return $id;
    }

    private function findActiveSeasonId(int $clubId): ?int
    {
        $sql = sprintf(
            'SELECT id
             FROM `%1$sseasons`
             WHERE club_id = ?
             ORDER BY is_active DESC, id DESC
             LIMIT 1',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('i', $clubId);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc() ?: null;
        $statement->close();

        return $row !== null ? (int) $row['id'] : null;
    }

    private function createDefaultSeason(int $clubId): int
    {
        $year = date('Y');
        $name = $year . ' Season';
        $startsOn = $year . '-01-01';
        $endsOn = $year . '-12-31';
        $isActive = 1;

        $sql = sprintf(
            'INSERT INTO `%1$sseasons` (club_id, name, starts_on, ends_on, is_active)
             VALUES (?, ?, ?, ?, ?)',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('isssi', $clubId, $name, $startsOn, $endsOn, $isActive);
        $statement->execute();
        $id = (int) $statement->insert_id;
        $statement->close();

        return $id;
    }

    /**
     * @param array<string, mixed> $tournament
     */
    private function upsertTournament(int $clubId, int $seasonId, array $tournament): int
    {
        $externalId = (string) ($tournament['id'] ?? '');
        $attributes = is_array($tournament['attributes'] ?? null) ? $tournament['attributes'] : [];
        $existingId = $externalId !== ''
            ? $this->externalReferences->findInternalId('challonge', 'tournament', $externalId)
            : null;

        $name = (string) ($attributes['name'] ?? ('Challonge Tournament ' . $externalId));
        $slug = $this->slugify('challonge-' . ($attributes['url'] ?? $externalId ?: $name));
        $status = $this->normalizeTournamentStatus((string) ($attributes['state'] ?? 'draft'));
        $providerSystem = 'challonge';
        $providerMetadata = json_encode($tournament, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        if ($existingId !== null) {
            $sql = sprintf(
                'UPDATE `%1$stournaments`
                 SET club_id = ?, season_id = ?, name = ?, slug = ?, provider_system = ?, provider_metadata = ?, status = ?
                 WHERE id = ?',
                $this->tablePrefix
            );
            $statement = $this->connection->prepare($sql);
            $statement->bind_param('iisssssi', $clubId, $seasonId, $name, $slug, $providerSystem, $providerMetadata, $status, $existingId);
            $statement->execute();
            $statement->close();
            return $existingId;
        }

        $sql = sprintf(
            'INSERT INTO `%1$stournaments`
             (club_id, season_id, name, slug, provider_system, provider_metadata, status)
             VALUES (?, ?, ?, ?, ?, ?, ?)',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('iisssss', $clubId, $seasonId, $name, $slug, $providerSystem, $providerMetadata, $status);
        $statement->execute();
        $id = (int) $statement->insert_id;
        $statement->close();

        if ($externalId !== '') {
            $this->externalReferences->upsert('challonge', 'tournament', $externalId, 'tournament', $id);
        }

        return $id;
    }

    /**
     * @param array<string, mixed> $participant
     */
    private function upsertPlayer(int $clubId, array $participant): int
    {
        $externalId = (string) ($participant['id'] ?? '');
        $attributes = is_array($participant['attributes'] ?? null) ? $participant['attributes'] : [];
        $existingId = $externalId !== ''
            ? $this->externalReferences->findInternalId('challonge', 'participant', $externalId)
            : null;

        $displayName = (string) ($attributes['name'] ?? ('Participant ' . $externalId));

        if ($existingId !== null) {
            $sql = sprintf(
                'UPDATE `%1$splayers`
                 SET club_id = ?, display_name = ?, is_active = 1
                 WHERE id = ?',
                $this->tablePrefix
            );
            $statement = $this->connection->prepare($sql);
            $statement->bind_param('isi', $clubId, $displayName, $existingId);
            $statement->execute();
            $statement->close();
            return $existingId;
        }

        $sql = sprintf(
            'INSERT INTO `%1$splayers` (club_id, display_name, is_active)
             VALUES (?, ?, 1)',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('is', $clubId, $displayName);
        $statement->execute();
        $id = (int) $statement->insert_id;
        $statement->close();

        return $id;
    }

    /**
     * @param array<string, mixed> $participant
     */
    private function upsertTournamentPlayer(int $tournamentId, int $playerId, array $participant): void
    {
        $attributes = is_array($participant['attributes'] ?? null) ? $participant['attributes'] : [];
        $seed = isset($attributes['seed']) ? (int) $attributes['seed'] : null;
        $status = 'registered';

        $selectSql = sprintf(
            'SELECT id FROM `%1$stournament_players` WHERE tournament_id = ? AND player_id = ? LIMIT 1',
            $this->tablePrefix
        );
        $select = $this->connection->prepare($selectSql);
        $select->bind_param('ii', $tournamentId, $playerId);
        $select->execute();
        $result = $select->get_result();
        $existing = $result->fetch_assoc() ?: null;
        $select->close();

        if ($existing !== null) {
            $sql = sprintf(
                'UPDATE `%1$stournament_players` SET seed = ?, status = ? WHERE id = ?',
                $this->tablePrefix
            );
            $statement = $this->connection->prepare($sql);
            $existingId = (int) $existing['id'];
            $statement->bind_param('isi', $seed, $status, $existingId);
            $statement->execute();
            $statement->close();
            return;
        }

        $sql = sprintf(
            'INSERT INTO `%1$stournament_players` (tournament_id, player_id, seed, status)
             VALUES (?, ?, ?, ?)',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('iiis', $tournamentId, $playerId, $seed, $status);
        $statement->execute();
        $statement->close();
    }

    /**
     * @param array<string, mixed> $match
     * @param array<string, int> $playerMap
     */
    private function upsertMatch(int $tournamentId, array $match, array $playerMap): bool
    {
        $externalId = (string) ($match['id'] ?? '');
        $attributes = is_array($match['attributes'] ?? null) ? $match['attributes'] : [];
        $playerAExternalId = (string) ($attributes['player1_id'] ?? '');
        $playerBExternalId = (string) ($attributes['player2_id'] ?? '');

        if ($playerAExternalId === '' || $playerBExternalId === '') {
            return false;
        }

        if (!isset($playerMap[$playerAExternalId], $playerMap[$playerBExternalId])) {
            return false;
        }

        $playerAId = $playerMap[$playerAExternalId];
        $playerBId = $playerMap[$playerBExternalId];
        $winnerExternalId = (string) ($attributes['winner_id'] ?? '');
        $winnerPlayerId = $winnerExternalId !== '' && isset($playerMap[$winnerExternalId]) ? $playerMap[$winnerExternalId] : null;
        $existingId = $externalId !== ''
            ? $this->externalReferences->findInternalId('challonge', 'match', $externalId)
            : null;

        $status = $this->normalizeMatchStatus($attributes);
        $roundLabel = isset($attributes['round']) ? 'Round ' . $attributes['round'] : null;
        $bracketLabel = isset($attributes['identifier']) ? (string) $attributes['identifier'] : null;
        $bestOfLegs = 3;
        $legsToWin = 2;
        $startsAt = isset($attributes['underway_at']) ? $this->normalizeDateTime($attributes['underway_at']) : null;
        $finishedAt = isset($attributes['completed_at']) ? $this->normalizeDateTime($attributes['completed_at']) : null;

        if ($existingId !== null) {
            $sql = sprintf(
                'UPDATE `%1$smatches`
                 SET tournament_id = ?, round_label = ?, bracket_label = ?, status = ?, best_of_legs = ?, legs_to_win = ?, player_a_id = ?, player_b_id = ?, winner_player_id = ?, starts_at = ?, finished_at = ?
                 WHERE id = ?',
                $this->tablePrefix
            );
            $statement = $this->connection->prepare($sql);
            $statement->bind_param(
                'isssiiiisssi',
                $tournamentId,
                $roundLabel,
                $bracketLabel,
                $status,
                $bestOfLegs,
                $legsToWin,
                $playerAId,
                $playerBId,
                $winnerPlayerId,
                $startsAt,
                $finishedAt,
                $existingId
            );
            $statement->execute();
            $statement->close();
            return true;
        }

        $sql = sprintf(
            'INSERT INTO `%1$smatches`
             (tournament_id, round_label, bracket_label, status, best_of_legs, legs_to_win, player_a_id, player_b_id, winner_player_id, starts_at, finished_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            $this->tablePrefix
        );
        $statement = $this->connection->prepare($sql);
        $statement->bind_param(
            'isssiiiisss',
            $tournamentId,
            $roundLabel,
            $bracketLabel,
            $status,
            $bestOfLegs,
            $legsToWin,
            $playerAId,
            $playerBId,
            $winnerPlayerId,
            $startsAt,
            $finishedAt
        );
        $statement->execute();
        $id = (int) $statement->insert_id;
        $statement->close();

        if ($externalId !== '') {
            $this->externalReferences->upsert('challonge', 'match', $externalId, 'match', $id);
        }

        return true;
    }

    private function normalizeTournamentStatus(string $value): string
    {
        $value = strtolower(trim($value));
        return match ($value) {
            'complete', 'completed', 'finalized' => 'completed',
            'underway', 'in_progress', 'active' => 'in_progress',
            'archived' => 'archived',
            'pending', 'awaiting_review', 'checking_in' => 'ready',
            default => 'draft',
        };
    }

    /**
     * @param array<string, mixed> $attributes
     */
    private function normalizeMatchStatus(array $attributes): string
    {
        if (($attributes['winner_id'] ?? null) !== null || ($attributes['completed_at'] ?? null) !== null) {
            return 'completed';
        }

        if (($attributes['underway_at'] ?? null) !== null) {
            return 'in_progress';
        }

        return 'pending';
    }

    private function normalizeDateTime(mixed $value): ?string
    {
        if (!is_string($value) || trim($value) === '') {
            return null;
        }

        return date('Y-m-d H:i:s', strtotime($value));
    }

    private function slugify(string $value): string
    {
        $value = strtolower($value);
        $value = preg_replace('/[^a-z0-9]+/', '-', $value) ?? 'item';
        $value = trim($value, '-');
        return $value !== '' ? substr($value, 0, 180) : 'item';
    }
}
