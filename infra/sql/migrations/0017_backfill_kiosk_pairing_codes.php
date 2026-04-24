<?php

declare(strict_types=1);

return static function (mysqli $connection, string $tablePrefix): void {
    $clubsResult = $connection->query(
        sprintf(
            'SELECT id, slug, name, kiosk_pairing_code FROM `%1$sclubs` ORDER BY id ASC',
            $tablePrefix
        )
    );

    /** @var array<int, array<string, mixed>> $clubs */
    $clubs = $clubsResult !== false ? $clubsResult->fetch_all(MYSQLI_ASSOC) : [];

    $codeExists = static function (mysqli $connection, string $tablePrefix, string $code): bool {
        $statement = $connection->prepare(
            sprintf(
                'SELECT id FROM `%1$sclubs` WHERE kiosk_pairing_code = ? LIMIT 1',
                $tablePrefix
            )
        );
        $statement->bind_param('s', $code);
        $statement->execute();
        $result = $statement->get_result();
        $row = $result->fetch_assoc();
        $statement->close();

        return $row !== null;
    };

    $slugify = static function (string $value): string {
        $value = trim($value);
        $value = iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $value) ?: $value;
        $value = strtolower($value);
        $value = preg_replace('/[^a-z0-9]+/', '-', $value) ?? 'club';
        $value = trim($value, '-');

        return $value !== '' ? $value : 'club';
    };

    foreach ($clubs as $club) {
        if (!empty($club['kiosk_pairing_code'])) {
            continue;
        }

        $reference = (string) ($club['slug'] ?: $club['name'] ?: 'club');
        $base = strtoupper(str_replace('-', '', $slugify($reference)));
        $base = substr($base !== '' ? $base : 'CLUB', 0, 3);
        $base = str_pad($base, 3, 'X');

        do {
            $suffix = strtoupper(substr(bin2hex(random_bytes(2)), 0, 4));
            $code = sprintf('%s-K%s', $base, $suffix);
        } while ($codeExists($connection, $tablePrefix, $code));

        $update = $connection->prepare(
            sprintf(
                'UPDATE `%1$sclubs` SET kiosk_pairing_code = ? WHERE id = ?',
                $tablePrefix
            )
        );
        $clubId = (int) $club['id'];
        $update->bind_param('si', $code, $clubId);
        $update->execute();
        $update->close();
    }

    $connection->query(
        sprintf(
            'UPDATE `%1$skiosk_pairing_requests` req
             INNER JOIN `%1$skiosks` k ON k.id = req.approved_kiosk_id
             SET req.club_id = k.club_id
             WHERE req.club_id IS NULL AND req.approved_kiosk_id IS NOT NULL',
            $tablePrefix
        )
    );
};
