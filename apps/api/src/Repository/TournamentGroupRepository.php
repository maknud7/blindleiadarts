<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Service\TournamentGroupService;
use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;
use Throwable;

final class TournamentGroupRepository
{
    private mysqli $connection;
    private string $tablePrefix;
    private TournamentGroupService $groupService;
    /** @var array<string, array{rating:float,played:int}> */
    private array $eloBaseline = [];

    public function __construct(Database $database, ?TournamentGroupService $groupService = null)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
        $this->groupService = $groupService ?? new TournamentGroupService();
        $this->loadEloBaseline();
    }

    /** @return array<string, mixed>|null */
    public function findTournament(int $tournamentId): ?array
    {
        $sql = sprintf(
            'SELECT id, club_id, season_id, name, status, start_at, end_at,
                    registration_opens_at, registration_closes_at, max_players,
                    group_count, group_draw_mode, group_draw_seed, group_drawn_at
             FROM `%1$stournaments` WHERE id=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        return $row;
    }

    /** @return array<int, array<string, mixed>> */
    public function listRegistrationTournamentsByClubId(int $clubId): array
    {
        $sql = sprintf(
            'SELECT t.id, t.club_id, t.season_id, t.name, t.slug, t.status, t.start_at, t.end_at,
                    t.registration_opens_at, t.registration_closes_at, t.max_players,
                    t.group_count, t.group_draw_mode, t.group_drawn_at,
                    COUNT(DISTINCT CASE WHEN tp.status IN ("registered","checked_in","paused") THEN tp.id END) AS registration_count,
                    COUNT(DISTINCT CASE WHEN tp.status = "waitlisted" THEN tp.id END) AS waitlist_count
             FROM `%1$stournaments` t
             LEFT JOIN `%1$stournament_players` tp ON tp.tournament_id=t.id
             WHERE t.club_id=? AND t.status <> "archived"
             GROUP BY t.id, t.club_id, t.season_id, t.name, t.slug, t.status, t.start_at, t.end_at,
                      t.registration_opens_at, t.registration_closes_at, t.max_players,
                      t.group_count, t.group_draw_mode, t.group_drawn_at
             ORDER BY COALESCE(t.start_at, "2999-12-31 23:59:59") ASC, t.id DESC',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $clubId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();
        foreach ($rows as &$row) {
            $row['registration_state'] = $this->registrationState($row);
        }
        unset($row);
        return $rows;
    }

    /** @return array<string, mixed> */
    public function updateRegistrationSettings(int $tournamentId, array $payload): array
    {
        $tournament = $this->requireTournament($tournamentId);
        $opensAt = $this->nullableDateTime($payload['registration_opens_at'] ?? $tournament['registration_opens_at'] ?? null);
        $closesAt = $this->nullableDateTime($payload['registration_closes_at'] ?? $tournament['registration_closes_at'] ?? null);
        $maxPlayers = array_key_exists('max_players', $payload)
            ? $this->nullablePositiveInt($payload['max_players'])
            : ($tournament['max_players'] !== null ? (int) $tournament['max_players'] : null);

        if ($opensAt !== null && $closesAt !== null && strtotime($opensAt) >= strtotime($closesAt)) {
            throw new ValidationException('invalid_registration_window', 'Registration closing time must be after opening time.');
        }

        $sql = sprintf(
            'UPDATE `%1$stournaments`
             SET registration_opens_at=?, registration_closes_at=?, max_players=?
             WHERE id=?',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ssii', $opensAt, $closesAt, $maxPlayers, $tournamentId);
        $stmt->execute();
        $stmt->close();
        return $this->requireTournament($tournamentId);
    }

    /** @return array<string, mixed> */
    public function registerPlayer(int $tournamentId, int $playerId, string $source = 'player'): array
    {
        $tournament = $this->requireTournament($tournamentId);
        if ($this->matchCount($tournamentId) > 0) {
            throw new ValidationException('registration_locked_by_matches', 'Registration changes are locked after matches have been created.');
        }
        if ($source !== 'admin') {
            $this->assertRegistrationOpen($tournament);
        }
        $this->assertPlayerBelongsToTournamentClub($playerId, (int) $tournament['club_id']);

        $status = 'registered';
        $maxPlayers = $tournament['max_players'] !== null ? (int) $tournament['max_players'] : null;
        if ($maxPlayers !== null && $this->confirmedRegistrationCount($tournamentId, $playerId) >= $maxPlayers) {
            $status = 'waitlisted';
        }

        $sql = sprintf(
            'INSERT INTO `%1$stournament_players` (tournament_id, player_id, status, registration_source)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE status=VALUES(status), registration_source=VALUES(registration_source),
                                     seed=NULL, seed_rating=NULL, seed_rating_source=NULL, updated_at=NOW()',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iiss', $tournamentId, $playerId, $status, $source);
        $stmt->execute();
        $stmt->close();
        $this->invalidateGroupDraw($tournamentId);

        return [
            'tournament_id' => $tournamentId,
            'player_id' => $playerId,
            'status' => $status,
            'registration_source' => $source,
        ];
    }

    /** @return array<string, mixed> */
    public function checkInPlayer(int $tournamentId, int $playerId): array
    {
        $this->requireTournament($tournamentId);
        $sql = sprintf(
            'SELECT id, status FROM `%1$stournament_players` WHERE tournament_id=? AND player_id=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ii', $tournamentId, $playerId);
        $stmt->execute();
        $registration = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();

        if ($registration === null) {
            throw new ValidationException('registration_required_before_check_in', 'Register for the tournament before checking in.', 422);
        }
        $status = (string) ($registration['status'] ?? '');
        if ($status === 'waitlisted') {
            throw new ValidationException('registration_waitlisted', 'Waitlisted players cannot check in until they have a confirmed place.', 422);
        }
        if (!in_array($status, ['registered', 'checked_in'], true)) {
            throw new ValidationException('registration_not_checkin_eligible', 'This registration cannot be checked in.', 422);
        }

        if ($status !== 'checked_in') {
            $update = $this->connection->prepare(sprintf(
                'UPDATE `%1$stournament_players` SET status="checked_in" WHERE id=?',
                $this->tablePrefix
            ));
            $registrationId = (int) $registration['id'];
            $update->bind_param('i', $registrationId);
            $update->execute();
            $update->close();
        }

        return [
            'tournament_id' => $tournamentId,
            'player_id' => $playerId,
            'status' => 'checked_in',
        ];
    }

    /** @return array<string, mixed> */
    public function withdrawPlayer(int $tournamentId, int $playerId): array
    {
        $this->requireTournament($tournamentId);
        if ($this->matchCount($tournamentId) > 0) {
            throw new ValidationException('registration_locked_by_matches', 'Registration changes are locked after matches have been created.');
        }

        $sql = sprintf(
            'UPDATE `%1$stournament_players`
             SET status="withdrawn", seed=NULL, seed_rating=NULL, seed_rating_source=NULL
             WHERE tournament_id=? AND player_id=? AND status <> "withdrawn"',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('ii', $tournamentId, $playerId);
        $stmt->execute();
        $affected = $stmt->affected_rows;
        $stmt->close();
        if ($affected === 0) {
            throw new ValidationException('registration_not_found', 'Active registration was not found.', 404);
        }

        $promoted = $this->promoteWaitlistedPlayer($tournamentId);
        $this->invalidateGroupDraw($tournamentId);
        return [
            'tournament_id' => $tournamentId,
            'player_id' => $playerId,
            'status' => 'withdrawn',
            'promoted_player_id' => $promoted,
        ];
    }

    /** @return array<string, mixed> */
    public function drawGroups(int $tournamentId, int $groupCount, string $mode, ?int $drawSeed = null): array
    {
        $tournament = $this->requireTournament($tournamentId);
        if ($this->matchCount($tournamentId) > 0) {
            throw new ValidationException('groups_locked_by_matches', 'Groups cannot be redrawn after matches have been created.');
        }

        $registrations = $this->listSeedCandidates(
            $tournamentId,
            $tournament['season_id'] !== null ? (int) $tournament['season_id'] : null
        );
        $allocation = $this->groupService->allocate($registrations, $groupCount, $mode, $drawSeed);

        $this->connection->begin_transaction();
        try {
            $delete = $this->connection->prepare(sprintf(
                'DELETE FROM `%1$stournament_groups` WHERE tournament_id=?',
                $this->tablePrefix
            ));
            $delete->bind_param('i', $tournamentId);
            $delete->execute();
            $delete->close();

            $clear = $this->connection->prepare(sprintf(
                'UPDATE `%1$stournament_players`
                 SET seed=NULL, seed_rating=NULL, seed_rating_source=NULL
                 WHERE tournament_id=?',
                $this->tablePrefix
            ));
            $clear->bind_param('i', $tournamentId);
            $clear->execute();
            $clear->close();

            foreach ($allocation['groups'] as $group) {
                $groupId = $this->insertGroup(
                    $tournamentId,
                    (string) $group['name'],
                    (int) $group['sort_order'],
                    (string) $allocation['mode'],
                    (int) $allocation['draw_seed']
                );
                foreach ($group['players'] as $player) {
                    $this->insertGroupPlayer($groupId, $player);
                    $this->snapshotTournamentSeed($tournamentId, $player);
                }
            }

            $sql = sprintf(
                'UPDATE `%1$stournaments`
                 SET group_count=?, group_draw_mode=?, group_draw_seed=?, group_drawn_at=NOW()
                 WHERE id=?',
                $this->tablePrefix
            );
            $stmt = $this->connection->prepare($sql);
            $modeValue = (string) $allocation['mode'];
            $seedValue = (int) $allocation['draw_seed'];
            $stmt->bind_param('isii', $groupCount, $modeValue, $seedValue, $tournamentId);
            $stmt->execute();
            $stmt->close();
            $this->connection->commit();
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }

        return $this->getGroups($tournamentId);
    }

    /** @return array<string, mixed> */
    public function generateRoundRobin(int $tournamentId, int $bestOfLegs): array
    {
        $this->requireTournament($tournamentId);
        if ($bestOfLegs < 1 || $bestOfLegs > 21 || $bestOfLegs % 2 === 0) {
            throw new ValidationException('invalid_best_of_legs', 'best_of_legs must be an odd number between 1 and 21.');
        }
        if ($this->matchCount($tournamentId) > 0) {
            throw new ValidationException('matches_already_exist', 'Round robin cannot be generated because this tournament already has matches.');
        }

        $groups = $this->getGroups($tournamentId)['groups'];
        if ($groups === []) {
            throw new ValidationException('groups_required', 'Draw groups before generating round robin matches.');
        }

        $legsToWin = intdiv($bestOfLegs, 2) + 1;
        $created = 0;
        $this->connection->begin_transaction();
        try {
            foreach ($groups as $group) {
                $rounds = $this->groupService->roundRobin($group['players']);
                foreach ($rounds as $roundIndex => $pairs) {
                    foreach ($pairs as $pair) {
                        $roundNumber = $roundIndex + 1;
                        $roundLabel = (string) $group['name'] . ' · Runde ' . $roundNumber;
                        $bracketLabel = (string) $group['name'];
                        $status = 'pending';
                        $sql = sprintf(
                            'INSERT INTO `%1$smatches`
                             (tournament_id, tournament_group_id, round_label, round_number, bracket_label, status,
                              best_of_legs, legs_to_win, player_a_id, player_b_id)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                            $this->tablePrefix
                        );
                        $stmt = $this->connection->prepare($sql);
                        $groupId = (int) $group['id'];
                        $a = (int) $pair['player_a_id'];
                        $b = (int) $pair['player_b_id'];
                        $stmt->bind_param(
                            'iisissiiii',
                            $tournamentId,
                            $groupId,
                            $roundLabel,
                            $roundNumber,
                            $bracketLabel,
                            $status,
                            $bestOfLegs,
                            $legsToWin,
                            $a,
                            $b
                        );
                        $stmt->execute();
                        $stmt->close();
                        $created++;
                    }
                }
            }
            $this->connection->commit();
        } catch (Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }

        return [
            'tournament_id' => $tournamentId,
            'created_match_count' => $created,
            'best_of_legs' => $bestOfLegs,
        ];
    }

    /** @return array{tournament:array<string,mixed>,groups:array<int,array<string,mixed>>} */
    public function getGroups(int $tournamentId): array
    {
        $tournament = $this->requireTournament($tournamentId);
        $sql = sprintf(
            'SELECT g.id AS group_id, g.name AS group_name, g.sort_order, g.draw_mode, g.draw_seed, g.generated_at,
                    gp.position, gp.seed_number, gp.seed_rating, gp.seed_rating_source,
                    tp.id AS tournament_player_id, tp.status AS registration_status,
                    p.id AS player_id, p.display_name, p.nickname
             FROM `%1$stournament_groups` g
             LEFT JOIN `%1$stournament_group_players` gp ON gp.group_id=g.id
             LEFT JOIN `%1$stournament_players` tp ON tp.id=gp.tournament_player_id
             LEFT JOIN `%1$splayers` p ON p.id=tp.player_id
             WHERE g.tournament_id=?
             ORDER BY g.sort_order ASC, gp.position ASC',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();

        $groups = [];
        foreach ($rows as $row) {
            $groupId = (int) $row['group_id'];
            if (!isset($groups[$groupId])) {
                $groups[$groupId] = [
                    'id' => $groupId,
                    'name' => $row['group_name'],
                    'sort_order' => (int) $row['sort_order'],
                    'draw_mode' => $row['draw_mode'],
                    'draw_seed' => (int) $row['draw_seed'],
                    'generated_at' => $row['generated_at'],
                    'players' => [],
                ];
            }
            if ($row['player_id'] !== null) {
                $groups[$groupId]['players'][] = [
                    'tournament_player_id' => (int) $row['tournament_player_id'],
                    'player_id' => (int) $row['player_id'],
                    'display_name' => $row['display_name'],
                    'nickname' => $row['nickname'],
                    'registration_status' => $row['registration_status'],
                    'position' => (int) $row['position'],
                    'seed_number' => $row['seed_number'] !== null ? (int) $row['seed_number'] : null,
                    'seed_rating' => $row['seed_rating'] !== null ? (float) $row['seed_rating'] : null,
                    'seed_rating_source' => $row['seed_rating_source'],
                ];
            }
        }

        return ['tournament' => $tournament, 'groups' => array_values($groups)];
    }

    /** @return array<int, array<string, mixed>> */
    private function listSeedCandidates(int $tournamentId, ?int $seasonId): array
    {
        $sql = sprintf(
            'SELECT tp.id AS tournament_player_id, tp.player_id, p.display_name, p.nickname,
                    (SELECT rs.points FROM `%1$sranking_snapshots` rs
                      WHERE rs.player_id=p.id AND rs.ranking_type="elo"
                        AND (? IS NULL OR rs.season_id=? OR rs.season_id IS NULL)
                      ORDER BY CASE WHEN rs.season_id <=> ? THEN 0 ELSE 1 END, rs.calculated_at DESC, rs.id DESC
                      LIMIT 1) AS elo_rating
             FROM `%1$stournament_players` tp
             INNER JOIN `%1$splayers` p ON p.id=tp.player_id
             WHERE tp.tournament_id=? AND tp.status IN ("registered","checked_in")
             ORDER BY p.display_name ASC',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iiii', $seasonId, $seasonId, $seasonId, $tournamentId);
        $stmt->execute();
        $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $stmt->close();

        foreach ($rows as &$row) {
            if ($row['elo_rating'] !== null) {
                $row['elo_rating'] = (float) $row['elo_rating'];
                $row['elo_rating_source'] = 'ranking_snapshot';
                continue;
            }
            $key = mb_strtolower(trim((string) $row['display_name']), 'UTF-8');
            if (isset($this->eloBaseline[$key])) {
                $row['elo_rating'] = $this->eloBaseline[$key]['rating'];
                $row['elo_rating_source'] = 'mandagsserien_2026_08_24';
            } else {
                $row['elo_rating'] = 1000.0;
                $row['elo_rating_source'] = 'default_1000';
            }
        }
        unset($row);
        return $rows;
    }

    /** @param array<string, mixed> $player */
    private function insertGroupPlayer(int $groupId, array $player): void
    {
        $sql = sprintf(
            'INSERT INTO `%1$stournament_group_players`
             (group_id, tournament_player_id, position, seed_number, seed_rating, seed_rating_source)
             VALUES (?, ?, ?, ?, ?, ?)',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $registrationId = (int) $player['tournament_player_id'];
        $position = (int) $player['group_position'];
        $seedNumber = (int) $player['seed_number'];
        $seedRating = (float) $player['seed_rating'];
        $source = (string) ($player['elo_rating_source'] ?? 'default_1000');
        $stmt->bind_param('iiiids', $groupId, $registrationId, $position, $seedNumber, $seedRating, $source);
        $stmt->execute();
        $stmt->close();
    }

    /** @param array<string, mixed> $player */
    private function snapshotTournamentSeed(int $tournamentId, array $player): void
    {
        $sql = sprintf(
            'UPDATE `%1$stournament_players`
             SET seed=?, seed_rating=?, seed_rating_source=?
             WHERE tournament_id=? AND id=?',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $seedNumber = (int) $player['seed_number'];
        $seedRating = (float) $player['seed_rating'];
        $source = (string) ($player['elo_rating_source'] ?? 'default_1000');
        $registrationId = (int) $player['tournament_player_id'];
        $stmt->bind_param('idsii', $seedNumber, $seedRating, $source, $tournamentId, $registrationId);
        $stmt->execute();
        $stmt->close();
    }

    private function insertGroup(int $tournamentId, string $name, int $sortOrder, string $mode, int $drawSeed): int
    {
        $sql = sprintf(
            'INSERT INTO `%1$stournament_groups` (tournament_id, name, sort_order, draw_mode, draw_seed)
             VALUES (?, ?, ?, ?, ?)',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('isisi', $tournamentId, $name, $sortOrder, $mode, $drawSeed);
        $stmt->execute();
        $id = (int) $stmt->insert_id;
        $stmt->close();
        return $id;
    }

    /** @return array<string, mixed> */
    private function requireTournament(int $tournamentId): array
    {
        $tournament = $this->findTournament($tournamentId);
        if ($tournament === null) {
            throw new ValidationException('tournament_not_found', 'Tournament was not found.', 404);
        }
        return $tournament;
    }

    /** @param array<string, mixed> $tournament */
    private function assertRegistrationOpen(array $tournament): void
    {
        $state = $this->registrationState($tournament);
        if ($state === 'not_open') {
            throw new ValidationException('registration_not_open', 'Registration has not opened yet.');
        }
        if ($state === 'closed') {
            throw new ValidationException('registration_closed', 'Registration is closed.');
        }
    }

    /** @param array<string, mixed> $tournament */
    private function registrationState(array $tournament): string
    {
        if (in_array((string) ($tournament['status'] ?? ''), ['completed', 'archived'], true)) {
            return 'closed';
        }
        $now = time();
        $opens = $tournament['registration_opens_at'] ?? null;
        $closes = $tournament['registration_closes_at'] ?? null;
        if (is_string($opens) && $opens !== '' && strtotime($opens) > $now) {
            return 'not_open';
        }
        if (is_string($closes) && $closes !== '' && strtotime($closes) < $now) {
            return 'closed';
        }
        return 'open';
    }

    private function confirmedRegistrationCount(int $tournamentId, int $excludePlayerId = 0): int
    {
        $sql = sprintf(
            'SELECT COUNT(*) AS cnt FROM `%1$stournament_players`
             WHERE tournament_id=? AND status IN ("registered","checked_in","paused") AND (?=0 OR player_id<>?)',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('iii', $tournamentId, $excludePlayerId, $excludePlayerId);
        $stmt->execute();
        $count = (int) ($stmt->get_result()->fetch_assoc()['cnt'] ?? 0);
        $stmt->close();
        return $count;
    }

    private function promoteWaitlistedPlayer(int $tournamentId): ?int
    {
        $tournament = $this->requireTournament($tournamentId);
        $maxPlayers = $tournament['max_players'] !== null ? (int) $tournament['max_players'] : null;
        if ($maxPlayers === null || $this->confirmedRegistrationCount($tournamentId) >= $maxPlayers) {
            return null;
        }

        $sql = sprintf(
            'SELECT id, player_id FROM `%1$stournament_players`
             WHERE tournament_id=? AND status="waitlisted"
             ORDER BY created_at ASC, id ASC LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row === null) {
            return null;
        }

        $update = $this->connection->prepare(sprintf(
            'UPDATE `%1$stournament_players` SET status="registered" WHERE id=?',
            $this->tablePrefix
        ));
        $id = (int) $row['id'];
        $update->bind_param('i', $id);
        $update->execute();
        $update->close();
        return (int) $row['player_id'];
    }

    private function assertPlayerBelongsToTournamentClub(int $playerId, int $clubId): void
    {
        $sql = sprintf('SELECT club_id FROM `%1$splayers` WHERE id=? LIMIT 1', $this->tablePrefix);
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $playerId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row === null || ($row['club_id'] !== null && (int) $row['club_id'] !== $clubId)) {
            throw new ValidationException('player_not_in_club', 'Player does not belong to the tournament club.');
        }
    }

    private function invalidateGroupDraw(int $tournamentId): void
    {
        $delete = $this->connection->prepare(sprintf(
            'DELETE FROM `%1$stournament_groups` WHERE tournament_id=?',
            $this->tablePrefix
        ));
        $delete->bind_param('i', $tournamentId);
        $delete->execute();
        $delete->close();

        $clearPlayers = $this->connection->prepare(sprintf(
            'UPDATE `%1$stournament_players`
             SET seed=NULL, seed_rating=NULL, seed_rating_source=NULL
             WHERE tournament_id=?',
            $this->tablePrefix
        ));
        $clearPlayers->bind_param('i', $tournamentId);
        $clearPlayers->execute();
        $clearPlayers->close();

        $clearTournament = $this->connection->prepare(sprintf(
            'UPDATE `%1$stournaments`
             SET group_count=NULL, group_draw_mode=NULL, group_draw_seed=NULL, group_drawn_at=NULL
             WHERE id=?',
            $this->tablePrefix
        ));
        $clearTournament->bind_param('i', $tournamentId);
        $clearTournament->execute();
        $clearTournament->close();
    }

    private function matchCount(int $tournamentId): int
    {
        $stmt = $this->connection->prepare(sprintf(
            'SELECT COUNT(*) AS cnt FROM `%1$smatches` WHERE tournament_id=?',
            $this->tablePrefix
        ));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $count = (int) ($stmt->get_result()->fetch_assoc()['cnt'] ?? 0);
        $stmt->close();
        return $count;
    }

    private function nullableDateTime(mixed $value): ?string
    {
        if ($value === null || trim((string) $value) === '') {
            return null;
        }
        $timestamp = strtotime((string) $value);
        if ($timestamp === false) {
            throw new ValidationException('invalid_datetime', 'Invalid date/time value.');
        }
        return date('Y-m-d H:i:s', $timestamp);
    }

    private function nullablePositiveInt(mixed $value): ?int
    {
        if ($value === null || $value === '') {
            return null;
        }
        $number = (int) $value;
        if ($number < 2) {
            throw new ValidationException('invalid_max_players', 'max_players must be at least 2 when set.');
        }
        return $number;
    }

    private function loadEloBaseline(): void
    {
        $path = dirname(__DIR__, 2) . '/data/mandagsserien-elo-2026-08-24.php';
        if (!is_file($path)) {
            return;
        }
        $data = require $path;
        foreach ((array) ($data['players'] ?? []) as $player) {
            $name = mb_strtolower(trim((string) ($player['display_name'] ?? '')), 'UTF-8');
            if ($name === '') {
                continue;
            }
            $this->eloBaseline[$name] = [
                'rating' => (float) ($player['rating'] ?? 1000.0),
                'played' => (int) ($player['played'] ?? 0),
            ];
        }
    }
}
