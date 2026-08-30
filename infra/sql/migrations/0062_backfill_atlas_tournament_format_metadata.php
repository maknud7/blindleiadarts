<?php

declare(strict_types=1);

return static function (mysqli $mysqli, string $prefix): void {
    $tournaments = $prefix . 'tournaments';
    $groups = $prefix . 'tournament_groups';
    $matches = $prefix . 'matches';
    $legs = $prefix . 'legs';
    $playoffs = $prefix . 'tournament_playoffs';
    $refs = $prefix . 'external_references';

    $stmt = $mysqli->prepare(
        "SELECT DISTINCT t.id
           FROM `{$tournaments}` t
           INNER JOIN `{$refs}` er
                   ON er.external_system='dartsatlas'
                  AND er.external_entity_type='tournament'
                  AND er.internal_entity_type='tournament'
                  AND er.internal_id=t.id
          WHERE t.status IN ('completed','archived')"
    );
    $stmt->execute();
    $result = $stmt->get_result();
    $ids = [];
    while ($row = $result->fetch_assoc()) {
        $ids[] = (int) $row['id'];
    }
    $stmt->close();

    foreach ($ids as $tournamentId) {
        $groupCount = (int) ($mysqli->query(
            "SELECT COUNT(*) c FROM `{$groups}` WHERE tournament_id={$tournamentId}"
        )->fetch_assoc()['c'] ?? 0);

        $groupBoRows = $mysqli->query(
            "SELECT DISTINCT best_of_legs
               FROM `{$matches}`
              WHERE tournament_id={$tournamentId}
                AND tournament_group_id IS NOT NULL
              ORDER BY best_of_legs"
        )->fetch_all(MYSQLI_ASSOC);
        $groupBestOf = count($groupBoRows) === 1 ? (int) $groupBoRows[0]['best_of_legs'] : null;

        $playoff = $mysqli->query(
            "SELECT qualifiers_per_group, best_of_legs
               FROM `{$playoffs}`
              WHERE tournament_id={$tournamentId}
              LIMIT 1"
        )->fetch_assoc() ?: null;

        $scoreRows = $mysqli->query(
            "SELECT DISTINCT l.start_score
               FROM `{$legs}` l
               INNER JOIN `{$matches}` m ON m.id=l.match_id
              WHERE m.tournament_id={$tournamentId}
              ORDER BY l.start_score"
        )->fetch_all(MYSQLI_ASSOC);
        $startingScore = count($scoreRows) === 1 ? (int) $scoreRows[0]['start_score'] : null;

        if ($groupCount < 1) {
            continue;
        }

        $format = $playoff !== null ? 'groups_playoff' : 'groups_only';
        $qualifiers = $playoff !== null ? (int) $playoff['qualifiers_per_group'] : null;
        $playoffBestOf = $playoff !== null ? (int) $playoff['best_of_legs'] : null;

        $update = $mysqli->prepare(
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
        $update->bind_param(
            'iisiiiii',
            $groupCount,
            $groupCount,
            $format,
            $groupBestOf,
            $qualifiers,
            $playoffBestOf,
            $startingScore,
            $tournamentId
        );
        $update->execute();
        $update->close();

        echo "0062: Atlas tournament {$tournamentId} -> {$format}, groups={$groupCount}, group_bo="
            . ($groupBestOf ?? 0) . ', qualifiers=' . ($qualifiers ?? 0)
            . ', playoff_bo=' . ($playoffBestOf ?? 0) . ', score=' . ($startingScore ?? 0) . "\n";
    }
};
