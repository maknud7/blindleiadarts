<?php

declare(strict_types=1);

return static function (mysqli $db, string $prefix): void {
    require_once dirname(__DIR__) . '/atlas_format_metadata.php';
    atlas_format_metadata_validate_prefix($prefix);

    $refs = $prefix . 'external_references';
    $externalId = 'jort2WSBWFwN';
    $stmt = $db->prepare(
        "SELECT internal_id
           FROM `{$refs}`
          WHERE external_system='dartsatlas'
            AND external_entity_type='tournament'
            AND internal_entity_type='tournament'
            AND external_id=?
          LIMIT 1"
    );
    $stmt->bind_param('s', $externalId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc() ?: null;
    $stmt->close();

    if ($row === null) {
        echo "0070: Mandagsserien #4 is not present in {$prefix}; nothing to reconcile.\n";
        return;
    }

    $tournamentId = (int) $row['internal_id'];
    $metadata = atlas_reconcile_format_metadata($db, $prefix, $tournamentId);
    $verified = atlas_assert_format_metadata($db, $prefix, $tournamentId);

    $expected = [
        'group_count' => 2,
        'planned_group_count' => 2,
        'planned_tournament_format' => 'groups_playoff',
        'planned_group_best_of_legs' => 1,
        'planned_qualifiers_per_group' => 4,
        'planned_playoff_best_of_legs' => 3,
        'planned_starting_score' => 501,
    ];
    foreach ($expected as $key => $value) {
        if (($verified[$key] ?? null) !== $value) {
            throw new RuntimeException(
                "Mandagsserien #4 format source drift for {$key}: expected "
                . var_export($value, true) . ', got ' . var_export($verified[$key] ?? null, true)
            );
        }
    }

    echo 'ATLAS_ROUND4_FORMAT_RECONCILED=yes tournament_id=' . $tournamentId
        . ' metadata=' . json_encode($metadata, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
        . "\n";
};
