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

    private function oddBestOf(mixed $value, string $label): int
    {
        $bestOf = (int) $value;
        if ($bestOf < 1 || $bestOf > 21 || $bestOf % 2 === 0) {
            throw new ValidationException('invalid_best_of_legs', 'Best of for ' . $label . ' må være et oddetall mellom 1 og 21.');
        }
        return $bestOf;
    }
}
