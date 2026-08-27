<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;
use mysqli_sql_exception;
use RuntimeException;
use Throwable;

final class PlayerIdentityRepository
{
    private mysqli $connection;
    private string $prefix;
    private string $identityPrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->prefix = $database->tablePrefix();
        $this->identityPrefix = $database->identityTablePrefix();
        foreach ([$this->prefix, $this->identityPrefix] as $prefix) {
            if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
                throw new RuntimeException('Invalid database table prefix.');
            }
        }
    }

    /** @return array<int,array<string,mixed>> */
    public function duplicateCandidates(int $clubId): array
    {
        $players = $this->prefix . 'players';
        $matches = $this->prefix . 'matches';
        $visits = $this->prefix . 'visits';
        $tournamentPlayers = $this->prefix . 'tournament_players';
        $elo = $this->prefix . 'elo_current_ratings';

        $eloJoin = $this->tableExists($elo)
            ? "LEFT JOIN (SELECT player_id, COUNT(*) AS elo_seasons, MAX(rating) AS top_elo FROM `{$elo}` GROUP BY player_id) er ON er.player_id=p.id"
            : '';
        $eloSelect = $this->tableExists($elo)
            ? 'COALESCE(er.elo_seasons,0) AS elo_seasons, er.top_elo AS top_elo,'
            : '0 AS elo_seasons, NULL AS top_elo,';

        $sql = "SELECT
                    p.id,
                    p.club_id,
                    p.display_name,
                    p.first_name,
                    p.last_name,
                    p.nickname,
                    p.avatar_url,
                    p.member_id,
                    p.member_link_source,
                    p.is_active,
                    {$eloSelect}
                    COALESCE(mc.match_count,0) AS match_count,
                    COALESCE(vc.visit_count,0) AS visit_count,
                    COALESCE(tc.tournament_count,0) AS tournament_count
                FROM `{$players}` p
                INNER JOIN (
                    SELECT club_id, LOWER(TRIM(display_name)) AS normalized_name
                    FROM `{$players}`
                    WHERE club_id=? AND merged_into_player_id IS NULL
                    GROUP BY club_id, LOWER(TRIM(display_name))
                    HAVING COUNT(*) > 1
                ) dup ON dup.club_id=p.club_id AND dup.normalized_name=LOWER(TRIM(p.display_name))
                LEFT JOIN (
                    SELECT player_id, COUNT(*) AS match_count FROM (
                        SELECT player_a_id AS player_id FROM `{$matches}`
                        UNION ALL SELECT player_b_id AS player_id FROM `{$matches}`
                    ) x GROUP BY player_id
                ) mc ON mc.player_id=p.id
                LEFT JOIN (SELECT player_id, COUNT(*) AS visit_count FROM `{$visits}` GROUP BY player_id) vc ON vc.player_id=p.id
                LEFT JOIN (SELECT player_id, COUNT(*) AS tournament_count FROM `{$tournamentPlayers}` GROUP BY player_id) tc ON tc.player_id=p.id
                {$eloJoin}
                WHERE p.club_id=? AND p.merged_into_player_id IS NULL
                ORDER BY LOWER(p.display_name),
                         (p.member_id IS NOT NULL) DESC,
                         p.is_active DESC,
                         COALESCE(mc.match_count,0) DESC,
                         p.id";

        $statement = $this->connection->prepare($sql);
        $statement->bind_param('ii', $clubId, $clubId);
        $statement->execute();
        $rows = $statement->get_result()->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        $accountIds = $this->accountPlayerIds(array_map(static fn(array $row): int => (int) $row['id'], $rows));
        foreach ($rows as &$row) {
            $id = (int) $row['id'];
            $row['id'] = $id;
            $row['club_id'] = (int) $row['club_id'];
            $row['member_id'] = $row['member_id'] !== null ? (int) $row['member_id'] : null;
            $row['is_active'] = (int) $row['is_active'];
            $row['match_count'] = (int) $row['match_count'];
            $row['visit_count'] = (int) $row['visit_count'];
            $row['tournament_count'] = (int) $row['tournament_count'];
            $row['elo_seasons'] = (int) $row['elo_seasons'];
            $row['has_account'] = isset($accountIds[$id]);
            $row['canonical_score'] = ($row['has_account'] ? 1000000 : 0)
                + ($row['member_id'] !== null ? 500000 : 0)
                + ((int) $row['is_active'] * 100000)
                + ((int) $row['match_count'] * 100)
                + (int) $row['visit_count'];
        }
        unset($row);
        return $rows;
    }

    /** @return array<string,mixed> */
    public function preview(int $clubId, int $sourceId, int $targetId): array
    {
        if ($sourceId <= 0 || $targetId <= 0 || $sourceId === $targetId) {
            throw new ValidationException('Velg to forskjellige spillere.');
        }
        $source = $this->player($sourceId);
        $target = $this->player($targetId);
        if ($source === null || $target === null) {
            throw new ValidationException('Fant ikke begge spillerne.');
        }
        if ((int) $source['club_id'] !== $clubId || (int) $target['club_id'] !== $clubId) {
            throw new ValidationException('Begge spillerne må tilhøre valgt klubb.');
        }
        if ($source['merged_into_player_id'] !== null || $target['merged_into_player_id'] !== null) {
            throw new ValidationException('En av spillerne er allerede slått sammen.');
        }

        $conflicts = [];
        if ($source['member_id'] !== null && $target['member_id'] !== null && (int) $source['member_id'] !== (int) $target['member_id']) {
            $conflicts[] = [
                'code' => 'different_members',
                'message' => 'Spillerne er koblet til to forskjellige medlemmer.',
            ];
        }

        $this->appendPairConflict(
            $conflicts,
            $this->prefix . 'tournament_players',
            'tournament_id',
            'player_id',
            $sourceId,
            $targetId,
            'same_tournament',
            'Begge spiller-ID-ene er registrert i samme turnering.'
        );
        $this->appendPairConflict(
            $conflicts,
            $this->prefix . 'elo_current_ratings',
            'season_id',
            'player_id',
            $sourceId,
            $targetId,
            'same_elo_season',
            'Begge spiller-ID-ene har gjeldende ELO i samme sesong.'
        );

        $ranking = $this->prefix . 'season_ranking_events';
        if ($this->tableExists($ranking)) {
            $sql = "SELECT COUNT(*) AS c
                    FROM `{$ranking}` a
                    INNER JOIN `{$ranking}` b
                      ON b.tournament_id=a.tournament_id AND b.ruleset=a.ruleset
                    WHERE a.player_id=? AND b.player_id=?";
            if ($this->scalarCount($sql, $sourceId, $targetId) > 0) {
                $conflicts[] = [
                    'code' => 'same_ranking_event',
                    'message' => 'Begge spiller-ID-ene har seriepoeng i samme turnering.',
                ];
            }
        }

        $playoffEntries = $this->prefix . 'tournament_playoff_entries';
        $this->appendPairConflict(
            $conflicts,
            $playoffEntries,
            'playoff_id',
            'player_id',
            $sourceId,
            $targetId,
            'same_playoff',
            'Begge spiller-ID-ene finnes i samme sluttspill.'
        );

        if ($this->identityPrefix === $this->prefix) {
            $users = $this->prefix . 'user_accounts';
            if ($this->tableExists($users)) {
                $sql = "SELECT COUNT(*) AS c FROM `{$users}` WHERE player_id IN (?,?)";
                if ($this->scalarCount($sql, $sourceId, $targetId) > 1) {
                    $conflicts[] = [
                        'code' => 'two_accounts',
                        'message' => 'Begge spiller-ID-ene er koblet til hver sin brukerkonto.',
                    ];
                }
            }
        }

        $references = $this->referenceCounts($sourceId);
        return [
            'source' => $source,
            'target' => $target,
            'references' => $references,
            'conflicts' => $conflicts,
            'safe_to_merge' => $conflicts === [],
        ];
    }

    /** @return array<string,mixed> */
    public function merge(int $clubId, int $sourceId, int $targetId, ?int $userAccountId, ?string $reason = null): array
    {
        $preview = $this->preview($clubId, $sourceId, $targetId);
        if (!($preview['safe_to_merge'] ?? false)) {
            throw new ValidationException('Sammenslåingen har konflikter som må ryddes først.');
        }

        $source = $preview['source'];
        $target = $preview['target'];
        $players = $this->prefix . 'players';
        $merges = $this->prefix . 'player_identity_merges';

        $this->connection->begin_transaction();
        try {
            // Fill canonical identity metadata only when the target has no value.
            $statement = $this->connection->prepare(
                "UPDATE `{$players}` t
                 INNER JOIN `{$players}` s ON s.id=?
                 SET t.first_name=COALESCE(t.first_name,s.first_name),
                     t.last_name=COALESCE(t.last_name,s.last_name),
                     t.nickname=COALESCE(t.nickname,s.nickname),
                     t.avatar_url=COALESCE(t.avatar_url,s.avatar_url),
                     t.member_id=COALESCE(t.member_id,s.member_id),
                     t.member_link_source=COALESCE(t.member_link_source,s.member_link_source),
                     t.member_linked_at=COALESCE(t.member_linked_at,s.member_linked_at),
                     t.is_active=1
                 WHERE t.id=?"
            );
            $statement->bind_param('ii', $sourceId, $targetId);
            $statement->execute();
            $statement->close();

            $moved = [];
            foreach ($this->foreignKeyReferences() as $reference) {
                $table = $reference['table'];
                $column = $reference['column'];
                if ($table === $players && $column === 'merged_into_player_id') continue;
                $statement = $this->connection->prepare("UPDATE `{$table}` SET `{$column}`=? WHERE `{$column}`=?");
                $statement->bind_param('ii', $targetId, $sourceId);
                $statement->execute();
                $affected = $statement->affected_rows;
                $statement->close();
                if ($affected > 0) $moved[$table . '.' . $column] = $affected;
            }

            $external = $this->prefix . 'external_references';
            if ($this->tableExists($external)) {
                $statement = $this->connection->prepare(
                    "UPDATE `{$external}` SET internal_id=?
                     WHERE internal_id=? AND internal_entity_type IN ('player','players')"
                );
                $statement->bind_param('ii', $targetId, $sourceId);
                $statement->execute();
                if ($statement->affected_rows > 0) $moved['external_references.internal_id'] = $statement->affected_rows;
                $statement->close();
            }

            $statement = $this->connection->prepare(
                "UPDATE `{$players}`
                 SET is_active=0, merged_into_player_id=?, merged_at=NOW()
                 WHERE id=? AND merged_into_player_id IS NULL"
            );
            $statement->bind_param('ii', $targetId, $sourceId);
            $statement->execute();
            if ($statement->affected_rows !== 1) {
                $statement->close();
                throw new RuntimeException('Klarte ikke å markere kilde-ID som sammenslått.');
            }
            $statement->close();

            $summary = json_encode([
                'references_before' => $preview['references'],
                'moved' => $moved,
            ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            $reason = trim((string) $reason);
            $sourceName = (string) $source['display_name'];
            $targetName = (string) $target['display_name'];
            $statement = $this->connection->prepare(
                "INSERT INTO `{$merges}`
                    (club_id,source_player_id,target_player_id,source_display_name,target_display_name,merged_by_user_account_id,reason,summary_json)
                 VALUES (?,?,?,?,?,?,?,?)"
            );
            $statement->bind_param(
                'iiississ',
                $clubId,
                $sourceId,
                $targetId,
                $sourceName,
                $targetName,
                $userAccountId,
                $reason,
                $summary
            );
            $statement->execute();
            $mergeId = (int) $statement->insert_id;
            $statement->close();

            $this->connection->commit();
            return [
                'merge_id' => $mergeId,
                'source_player_id' => $sourceId,
                'target_player_id' => $targetId,
                'moved' => $moved,
            ];
        } catch (Throwable $error) {
            $this->connection->rollback();
            if ($error instanceof mysqli_sql_exception && (int) $error->getCode() === 1062) {
                throw new ValidationException('Sammenslåingen kolliderer med eksisterende turnerings- eller rankingdata. Ingen data ble endret.');
            }
            throw $error;
        }
    }

    /** @return array<string,mixed>|null */
    private function player(int $id): ?array
    {
        $players = $this->prefix . 'players';
        $statement = $this->connection->prepare(
            "SELECT id,club_id,display_name,first_name,last_name,nickname,avatar_url,member_id,member_link_source,is_active,merged_into_player_id,merged_at
             FROM `{$players}` WHERE id=? LIMIT 1"
        );
        $statement->bind_param('i', $id);
        $statement->execute();
        $row = $statement->get_result()->fetch_assoc() ?: null;
        $statement->close();
        if ($row === null) return null;
        $row['id'] = (int) $row['id'];
        $row['club_id'] = $row['club_id'] !== null ? (int) $row['club_id'] : null;
        $row['member_id'] = $row['member_id'] !== null ? (int) $row['member_id'] : null;
        $row['is_active'] = (int) $row['is_active'];
        $row['merged_into_player_id'] = $row['merged_into_player_id'] !== null ? (int) $row['merged_into_player_id'] : null;
        return $row;
    }

    /** @param array<int,array<string,mixed>> $conflicts */
    private function appendPairConflict(array &$conflicts, string $table, string $scopeColumn, string $playerColumn, int $sourceId, int $targetId, string $code, string $message): void
    {
        if (!$this->tableExists($table)) return;
        $sql = "SELECT COUNT(*) AS c FROM `{$table}` a INNER JOIN `{$table}` b ON b.`{$scopeColumn}`=a.`{$scopeColumn}` WHERE a.`{$playerColumn}`=? AND b.`{$playerColumn}`=?";
        if ($this->scalarCount($sql, $sourceId, $targetId) > 0) {
            $conflicts[] = ['code' => $code, 'message' => $message];
        }
    }

    private function scalarCount(string $sql, int $a, int $b): int
    {
        $statement = $this->connection->prepare($sql);
        $statement->bind_param('ii', $a, $b);
        $statement->execute();
        $row = $statement->get_result()->fetch_assoc() ?: [];
        $statement->close();
        return (int) ($row['c'] ?? 0);
    }

    /** @return array<string,int> */
    private function referenceCounts(int $playerId): array
    {
        $counts = [];
        foreach ($this->foreignKeyReferences() as $reference) {
            $table = $reference['table'];
            $column = $reference['column'];
            if ($table === $this->prefix . 'players' && $column === 'merged_into_player_id') continue;
            $statement = $this->connection->prepare("SELECT COUNT(*) AS c FROM `{$table}` WHERE `{$column}`=?");
            $statement->bind_param('i', $playerId);
            $statement->execute();
            $count = (int) (($statement->get_result()->fetch_assoc()['c'] ?? 0));
            $statement->close();
            if ($count > 0) $counts[$table . '.' . $column] = $count;
        }
        return $counts;
    }

    /** @return array<int,array{table:string,column:string}> */
    private function foreignKeyReferences(): array
    {
        $players = $this->prefix . 'players';
        $statement = $this->connection->prepare(
            'SELECT TABLE_NAME,COLUMN_NAME
             FROM information_schema.KEY_COLUMN_USAGE
             WHERE TABLE_SCHEMA=DATABASE()
               AND REFERENCED_TABLE_SCHEMA=DATABASE()
               AND REFERENCED_TABLE_NAME=?
               AND REFERENCED_COLUMN_NAME="id"
             ORDER BY TABLE_NAME,COLUMN_NAME'
        );
        $statement->bind_param('s', $players);
        $statement->execute();
        $rows = $statement->get_result()->fetch_all(MYSQLI_ASSOC);
        $statement->close();
        return array_map(static fn(array $row): array => [
            'table' => (string) $row['TABLE_NAME'],
            'column' => (string) $row['COLUMN_NAME'],
        ], $rows);
    }

    /** @param int[] $playerIds @return array<int,bool> */
    private function accountPlayerIds(array $playerIds): array
    {
        if ($playerIds === [] || $this->identityPrefix !== $this->prefix) return [];
        $users = $this->prefix . 'user_accounts';
        if (!$this->tableExists($users)) return [];
        $ids = array_values(array_unique(array_filter(array_map('intval', $playerIds))));
        if ($ids === []) return [];
        $list = implode(',', $ids);
        $result = $this->connection->query("SELECT player_id FROM `{$users}` WHERE player_id IN ({$list})");
        $found = [];
        while ($row = $result->fetch_assoc()) $found[(int) $row['player_id']] = true;
        return $found;
    }

    private function tableExists(string $table): bool
    {
        $statement = $this->connection->prepare(
            'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1'
        );
        $statement->bind_param('s', $table);
        $statement->execute();
        $exists = $statement->get_result()->fetch_assoc() !== null;
        $statement->close();
        return $exists;
    }
}
