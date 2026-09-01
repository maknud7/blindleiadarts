<?php

declare(strict_types=1);

if (!function_exists('atlas_format_metadata_validate_prefix')) {
    function atlas_format_metadata_validate_prefix(string $prefix): void
    {
        if (!preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
            throw new RuntimeException('Invalid table prefix for Atlas format metadata.');
        }
    }
}

if (!function_exists('atlas_derive_format_metadata')) {
    /**
     * Derive display/planning metadata from canonical imported tournament data.
     * No DartsAtlas HTTP calls are made here: matches, groups, legs and playoff rows
     * already stored in Blindleia are the source of truth after migration.
     *
     * @return array{
     *   group_count:int,
     *   planned_group_count:?int,
     *   planned_tournament_format:string,
     *   planned_group_best_of_legs:?int,
     *   planned_qualifiers_per_group:?int,
     *   planned_playoff_best_of_legs:?int,
     *   planned_starting_score:?int
     * }
     */
    function atlas_derive_format_metadata(mysqli $db, string $prefix, int $tournamentId): array
    {
        atlas_format_metadata_validate_prefix($prefix);
        if ($tournamentId < 1) {
            throw new RuntimeException('Tournament id must be positive.');
        }

        $tournaments = $prefix . 'tournaments';
        $groups = $prefix . 'tournament_groups';
        $matches = $prefix . 'matches';
        $legs = $prefix . 'legs';
        $playoffs = $prefix . 'tournament_playoffs';

        $exists = $db->query("SELECT id FROM `{$tournaments}` WHERE id={$tournamentId} LIMIT 1")->fetch_assoc();
        if ($exists === null) {
            throw new RuntimeException("Tournament {$tournamentId} does not exist.");
        }

        $groupCount = (int) ($db->query(
            "SELECT COUNT(*) c FROM `{$groups}` WHERE tournament_id={$tournamentId}"
        )->fetch_assoc()['c'] ?? 0);

        $groupBoRows = $db->query(
            "SELECT DISTINCT best_of_legs
               FROM `{$matches}`
              WHERE tournament_id={$tournamentId}
                AND tournament_group_id IS NOT NULL
                AND best_of_legs IS NOT NULL
              ORDER BY best_of_legs"
        )->fetch_all(MYSQLI_ASSOC);
        if (count($groupBoRows) > 1) {
            $values = implode(',', array_map(static fn (array $row): string => (string) $row['best_of_legs'], $groupBoRows));
            throw new RuntimeException("Tournament {$tournamentId} has mixed group best-of values: {$values}");
        }
        $groupBestOf = count($groupBoRows) === 1 ? (int) $groupBoRows[0]['best_of_legs'] : null;

        $playoffRows = $db->query(
            "SELECT id,qualifiers_per_group,best_of_legs
               FROM `{$playoffs}`
              WHERE tournament_id={$tournamentId}
              ORDER BY id"
        )->fetch_all(MYSQLI_ASSOC);
        if (count($playoffRows) > 1) {
            throw new RuntimeException("Tournament {$tournamentId} has more than one playoff definition.");
        }
        $playoff = $playoffRows[0] ?? null;

        $playoffBoRows = $db->query(
            "SELECT DISTINCT best_of_legs
               FROM `{$matches}`
              WHERE tournament_id={$tournamentId}
                AND tournament_group_id IS NULL
                AND best_of_legs IS NOT NULL
                AND (phase='playoff' OR stage='single_elimination')
              ORDER BY best_of_legs"
        )->fetch_all(MYSQLI_ASSOC);
        if (count($playoffBoRows) > 1) {
            $values = implode(',', array_map(static fn (array $row): string => (string) $row['best_of_legs'], $playoffBoRows));
            throw new RuntimeException("Tournament {$tournamentId} has mixed playoff best-of values: {$values}");
        }
        $playoffBestOf = count($playoffBoRows) === 1
            ? (int) $playoffBoRows[0]['best_of_legs']
            : ($playoff !== null ? (int) $playoff['best_of_legs'] : null);

        $scoreRows = $db->query(
            "SELECT DISTINCT l.start_score
               FROM `{$legs}` l
               INNER JOIN `{$matches}` m ON m.id=l.match_id
              WHERE m.tournament_id={$tournamentId}
                AND l.start_score IS NOT NULL
              ORDER BY l.start_score"
        )->fetch_all(MYSQLI_ASSOC);
        if (count($scoreRows) > 1) {
            $values = implode(',', array_map(static fn (array $row): string => (string) $row['start_score'], $scoreRows));
            throw new RuntimeException("Tournament {$tournamentId} has mixed starting scores: {$values}");
        }
        $startingScore = count($scoreRows) === 1 ? (int) $scoreRows[0]['start_score'] : null;

        if ($groupCount > 0 && $groupBestOf === null) {
            throw new RuntimeException("Tournament {$tournamentId} has groups but no canonical group match format.");
        }

        if ($groupCount > 0 && $playoff !== null) {
            $format = 'groups_playoff';
            $qualifiers = (int) $playoff['qualifiers_per_group'];
            if ($qualifiers < 1) {
                throw new RuntimeException("Tournament {$tournamentId} has a playoff but no qualifiers_per_group.");
            }
            if ($playoffBestOf === null || $playoffBestOf < 1) {
                throw new RuntimeException("Tournament {$tournamentId} has a playoff but no canonical playoff match format.");
            }
        } elseif ($groupCount > 0) {
            $format = 'groups_only';
            $qualifiers = null;
            $playoffBestOf = null;
        } elseif ($playoff !== null) {
            $format = 'single_elimination';
            $qualifiers = null;
            if ($playoffBestOf === null || $playoffBestOf < 1) {
                throw new RuntimeException("Tournament {$tournamentId} has a playoff but no canonical playoff match format.");
            }
        } else {
            throw new RuntimeException("Cannot derive tournament format for {$tournamentId}: no groups or playoff found.");
        }

        return [
            'group_count' => $groupCount,
            'planned_group_count' => $groupCount > 0 ? $groupCount : null,
            'planned_tournament_format' => $format,
            'planned_group_best_of_legs' => $groupCount > 0 ? $groupBestOf : null,
            'planned_qualifiers_per_group' => $qualifiers,
            'planned_playoff_best_of_legs' => $playoffBestOf,
            'planned_starting_score' => $startingScore,
        ];
    }
}

if (!function_exists('atlas_reconcile_format_metadata')) {
    /** @return array<string,int|string|null> */
    function atlas_reconcile_format_metadata(mysqli $db, string $prefix, int $tournamentId): array
    {
        $metadata = atlas_derive_format_metadata($db, $prefix, $tournamentId);
        $tournaments = $prefix . 'tournaments';

        $stmt = $db->prepare(
            "UPDATE `{$tournaments}`
                SET group_count=?,
                    planned_group_count=?,
                    planned_tournament_format=?,
                    planned_group_best_of_legs=?,
                    planned_qualifiers_per_group=?,
                    planned_playoff_best_of_legs=?,
                    planned_starting_score=COALESCE(?, planned_starting_score)
              WHERE id=?"
        );
        $groupCount = $metadata['group_count'];
        $plannedGroupCount = $metadata['planned_group_count'];
        $format = $metadata['planned_tournament_format'];
        $groupBestOf = $metadata['planned_group_best_of_legs'];
        $qualifiers = $metadata['planned_qualifiers_per_group'];
        $playoffBestOf = $metadata['planned_playoff_best_of_legs'];
        $startingScore = $metadata['planned_starting_score'];
        $stmt->bind_param(
            'iisiiiii',
            $groupCount,
            $plannedGroupCount,
            $format,
            $groupBestOf,
            $qualifiers,
            $playoffBestOf,
            $startingScore,
            $tournamentId
        );
        $stmt->execute();
        $stmt->close();

        return $metadata;
    }
}

if (!function_exists('atlas_read_format_metadata')) {
    /** @return array<string,int|string|null> */
    function atlas_read_format_metadata(mysqli $db, string $prefix, int $tournamentId): array
    {
        atlas_format_metadata_validate_prefix($prefix);
        $tournaments = $prefix . 'tournaments';
        $stmt = $db->prepare(
            "SELECT group_count,planned_group_count,planned_tournament_format,
                    planned_group_best_of_legs,planned_qualifiers_per_group,
                    planned_playoff_best_of_legs,planned_starting_score
               FROM `{$tournaments}` WHERE id=? LIMIT 1"
        );
        $stmt->bind_param('i', $tournamentId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc() ?: null;
        $stmt->close();
        if ($row === null) {
            throw new RuntimeException("Tournament {$tournamentId} does not exist.");
        }

        foreach ([
            'group_count','planned_group_count','planned_group_best_of_legs',
            'planned_qualifiers_per_group','planned_playoff_best_of_legs','planned_starting_score'
        ] as $key) {
            $row[$key] = $row[$key] === null ? null : (int) $row[$key];
        }
        return $row;
    }
}

if (!function_exists('atlas_assert_format_metadata')) {
    /** @return array<string,int|string|null> */
    function atlas_assert_format_metadata(mysqli $db, string $prefix, int $tournamentId): array
    {
        $expected = atlas_derive_format_metadata($db, $prefix, $tournamentId);
        $actual = atlas_read_format_metadata($db, $prefix, $tournamentId);
        $failures = [];
        foreach ($expected as $key => $value) {
            if (($actual[$key] ?? null) !== $value) {
                $failures[$key] = ['expected' => $value, 'actual' => $actual[$key] ?? null];
            }
        }
        if ($failures !== []) {
            throw new RuntimeException(
                "Tournament {$tournamentId} format metadata differs from canonical match data: "
                . json_encode($failures, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
            );
        }
        return $actual;
    }
}
