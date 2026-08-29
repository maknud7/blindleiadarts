<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Repository;

use Blindleia\Dartkiosk\Api\Support\Database;
use mysqli;

final class TournamentWizardRepository
{
    private mysqli $connection;
    private string $tablePrefix;

    public function __construct(Database $database)
    {
        $this->connection = $database->connection();
        $this->tablePrefix = $database->tablePrefix();
    }

    /** @return array<string,mixed>|null */
    public function getPlan(int $tournamentId): ?array
    {
        $sql = sprintf(
            'SELECT id,club_id,name,status,start_at,
                    planned_group_count,planned_group_draw_mode,planned_group_best_of_legs,
                    planned_qualifiers_per_group,planned_playoff_best_of_legs,
                    planned_tournament_format,planned_starting_score,
                    group_count,group_draw_mode,group_drawn_at
             FROM `%1$stournaments` WHERE id=? LIMIT 1',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row === null) return null;

        return [
            'tournament_id' => (int) $row['id'],
            'club_id' => (int) $row['club_id'],
            'name' => $row['name'],
            'status' => $row['status'],
            'start_at' => $row['start_at'],
            'tournament_format' => (string) $row['planned_tournament_format'],
            'starting_score' => (int) $row['planned_starting_score'],
            'group_count' => $row['planned_group_count'] !== null
                ? (int) $row['planned_group_count']
                : ($row['group_count'] !== null ? (int) $row['group_count'] : 1),
            'group_draw_mode' => $row['planned_group_draw_mode'] ?? $row['group_draw_mode'] ?? 'elo_snake',
            'group_best_of_legs' => $row['planned_group_best_of_legs'] !== null ? (int) $row['planned_group_best_of_legs'] : 3,
            'qualifiers_per_group' => $row['planned_qualifiers_per_group'] !== null ? (int) $row['planned_qualifiers_per_group'] : 2,
            'playoff_best_of_legs' => $row['planned_playoff_best_of_legs'] !== null ? (int) $row['planned_playoff_best_of_legs'] : 3,
            'groups_already_drawn' => $row['group_drawn_at'] !== null,
        ];
    }

    /** @param array<string,mixed> $payload @return array<string,mixed> */
    public function updatePlan(int $tournamentId, array $payload): array
    {
        $current = $this->getPlan($tournamentId);
        if ($current === null) throw new ValidationException('tournament_not_found', 'Turneringen ble ikke funnet.', 404);

        $format = (string) ($payload['tournament_format'] ?? $current['tournament_format']);
        if (!in_array($format, ['groups_playoff','groups_only','single_elimination','swiss'], true)) {
            throw new ValidationException('invalid_tournament_format', 'Ugyldig turneringsformat.');
        }
        $startingScore = (int) ($payload['starting_score'] ?? $current['starting_score']);
        if (!in_array($startingScore, [301, 501, 701, 1001], true)) {
            throw new ValidationException('invalid_starting_score', 'Ugyldig startscore.');
        }
        $groupCount = min(32, max(1, (int) ($payload['group_count'] ?? $current['group_count'])));
        $drawMode = (string) ($payload['group_draw_mode'] ?? $current['group_draw_mode']);
        if (!in_array($drawMode, ['elo_snake','elo_pots','random'], true)) {
            throw new ValidationException('invalid_group_draw_mode', 'Ugyldig gruppetrekkmodus.');
        }
        $groupBestOf = $this->oddBestOf($payload['group_best_of_legs'] ?? $current['group_best_of_legs'], 'gruppespill');
        $qualifiers = min(16, max(1, (int) ($payload['qualifiers_per_group'] ?? $current['qualifiers_per_group'])));
        $playoffBestOf = $this->oddBestOf($payload['playoff_best_of_legs'] ?? $current['playoff_best_of_legs'], 'sluttspill');

        $sql = sprintf(
            'UPDATE `%1$stournaments`
             SET planned_group_count=?,planned_group_draw_mode=?,planned_group_best_of_legs=?,
                 planned_qualifiers_per_group=?,planned_playoff_best_of_legs=?,
                 planned_tournament_format=?,planned_starting_score=?
             WHERE id=?',
            $this->tablePrefix
        );
        $stmt = $this->connection->prepare($sql);
        $stmt->bind_param('isiiisii', $groupCount, $drawMode, $groupBestOf, $qualifiers, $playoffBestOf, $format, $startingScore, $tournamentId);
        $stmt->execute();
        $stmt->close();
        return $this->getPlan($tournamentId) ?? [];
    }

    /** @return array<string,mixed> */
    public function deleteDraftTournament(int $tournamentId): array
    {
        $plan = $this->getPlan($tournamentId);
        if ($plan === null) throw new ValidationException('tournament_not_found', 'Turneringen ble ikke funnet.', 404);
        if ((string) $plan['status'] !== 'draft') {
            throw new ValidationException('tournament_delete_not_allowed', 'Bare turneringer som ikke er startet kan slettes.', 409);
        }

        $stmt = $this->connection->prepare(sprintf('SELECT COUNT(*) AS c FROM `%1$smatches` WHERE tournament_id=?', $this->tablePrefix));
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $matchCount = (int) (($stmt->get_result()->fetch_assoc()['c'] ?? 0));
        $stmt->close();
        if ($matchCount > 0) {
            throw new ValidationException('tournament_delete_has_matches', 'Turneringen har kamper og kan ikke slettes. Arkiver den i stedet.', 409);
        }

        $this->connection->begin_transaction();
        try {
            $schema = $this->connection->query('SELECT DATABASE() AS db')->fetch_assoc()['db'] ?? '';
            $parentTable = $this->tablePrefix . 'tournaments';
            $sql = 'SELECT TABLE_NAME,COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE '
                . 'WHERE REFERENCED_TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME=? AND REFERENCED_COLUMN_NAME="id"';
            $fk = $this->connection->prepare($sql);
            $fk->bind_param('ss', $schema, $parentTable);
            $fk->execute();
            $result = $fk->get_result();
            $children = [];
            while ($row = $result->fetch_assoc()) $children[] = $row;
            $fk->close();

            foreach ($children as $child) {
                $table = str_replace('`', '``', (string) $child['TABLE_NAME']);
                $column = str_replace('`', '``', (string) $child['COLUMN_NAME']);
                $delete = $this->connection->prepare("DELETE FROM `{$table}` WHERE `{$column}`=?");
                $delete->bind_param('i', $tournamentId);
                $delete->execute();
                $delete->close();
            }

            $deleteTournament = $this->connection->prepare(sprintf('DELETE FROM `%1$stournaments` WHERE id=? AND status="draft"', $this->tablePrefix));
            $deleteTournament->bind_param('i', $tournamentId);
            $deleteTournament->execute();
            if ($deleteTournament->affected_rows !== 1) {
                $deleteTournament->close();
                throw new ValidationException('tournament_delete_failed', 'Turneringen kunne ikke slettes.', 409);
            }
            $deleteTournament->close();
            $this->connection->commit();
        } catch (\Throwable $error) {
            $this->connection->rollback();
            throw $error;
        }

        return ['deleted' => true, 'tournament_id' => $tournamentId, 'name' => (string) $plan['name']];
    }

    private function oddBestOf(mixed $value, string $label): int
    {
        $bestOf = (int) $value;
        if ($bestOf < 1 || $bestOf > 21 || $bestOf % 2 === 0) {
            throw new ValidationException('invalid_best_of_legs', 'Best of for ' . $label . ' må være et oddetall mellom 1 og 21.');
        }
        return $bestOf;
    }
}
