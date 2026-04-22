<?php

declare(strict_types=1);

use mysqli;

return static function (mysqli $mysqli, string $prefix): void {
    $players = [
        'Andre Kendrick',
        'Bjørn Jarle Jahnsen',
        'Andreas Tingstveit Hansen',
        'Thomas Kildal',
        'Andre Hammer',
        'Boye Buckingham',
        'Vetle Ribe Davidsen',
        'Geir Atle Håland',
        'Andreas Hasselgård',
        'Leif Atle Franksson',
        'Tormod Haga',
        'Steffen Madsen',
        'Sven Einar Davidsen',
        'Tor Egil Olsen',
        'Hans Øyvind Reiersen',
        'Kjell Moyle',
        'Magnus Knudsen',
        'Jon-Henning Næss',
        'Dan Christian Birkeland',
        'Benjamin Rafoss',
        'Arild Eidesund',
        'Kristian Mollestad',
        'Stig Håbesland',
        'Jarle Hundeland',
    ];

    $dummyEmail = 'blindleiadartklubb@ingenting.org';
    $dummyPhone = '90661092';
    $dummyPassword = 'BD-Test-2026!';
    $clubName = 'Blindleia Dartklubb';
    $clubSlug = 'blindleia-dartklubb';
    $seasonName = date('Y') . ' Season';
    $seasonStartsOn = date('Y') . '-01-01';
    $seasonEndsOn = date('Y') . '-12-31';

    $clubId = null;
    $clubSelect = $mysqli->prepare("SELECT id FROM `{$prefix}clubs` WHERE slug = ? LIMIT 1");
    $clubSelect->bind_param('s', $clubSlug);
    $clubSelect->execute();
    $clubResult = $clubSelect->get_result();
    $clubRow = $clubResult->fetch_assoc();
    $clubSelect->close();

    if ($clubRow !== null) {
        $clubId = (int) $clubRow['id'];
    } else {
        $clubInsert = $mysqli->prepare("INSERT INTO `{$prefix}clubs` (name, slug) VALUES (?, ?)");
        $clubInsert->bind_param('ss', $clubName, $clubSlug);
        $clubInsert->execute();
        $clubId = (int) $clubInsert->insert_id;
        $clubInsert->close();
    }

    $seasonId = null;
    $seasonSelect = $mysqli->prepare("SELECT id FROM `{$prefix}seasons` WHERE club_id = ? AND name = ? LIMIT 1");
    $seasonSelect->bind_param('is', $clubId, $seasonName);
    $seasonSelect->execute();
    $seasonResult = $seasonSelect->get_result();
    $seasonRow = $seasonResult->fetch_assoc();
    $seasonSelect->close();

    if ($seasonRow !== null) {
        $seasonId = (int) $seasonRow['id'];
    } else {
        $isActive = 1;
        $seasonInsert = $mysqli->prepare(
            "INSERT INTO `{$prefix}seasons` (club_id, name, starts_on, ends_on, is_active) VALUES (?, ?, ?, ?, ?)"
        );
        $seasonInsert->bind_param('isssi', $clubId, $seasonName, $seasonStartsOn, $seasonEndsOn, $isActive);
        $seasonInsert->execute();
        $seasonId = (int) $seasonInsert->insert_id;
        $seasonInsert->close();
    }

    foreach ($players as $displayName) {
        $username = slugify_username($displayName);
        $passwordHash = password_hash($dummyPassword, PASSWORD_DEFAULT);
        $role = $displayName === 'Magnus Knudsen' ? 'admin' : 'player';

        $playerId = null;
        $playerSelect = $mysqli->prepare("SELECT id FROM `{$prefix}players` WHERE display_name = ? LIMIT 1");
        $playerSelect->bind_param('s', $displayName);
        $playerSelect->execute();
        $playerResult = $playerSelect->get_result();
        $playerRow = $playerResult->fetch_assoc();
        $playerSelect->close();

        if ($playerRow !== null) {
            $playerId = (int) $playerRow['id'];
        } else {
            $isActive = 1;
            $playerInsert = $mysqli->prepare(
                "INSERT INTO `{$prefix}players` (club_id, display_name, is_active) VALUES (?, ?, ?)"
            );
            $playerInsert->bind_param('isi', $clubId, $displayName, $isActive);
            $playerInsert->execute();
            $playerId = (int) $playerInsert->insert_id;
            $playerInsert->close();
        }

        $userId = null;
        $userSelect = $mysqli->prepare("SELECT id FROM `{$prefix}user_accounts` WHERE username = ? LIMIT 1");
        $userSelect->bind_param('s', $username);
        $userSelect->execute();
        $userResult = $userSelect->get_result();
        $userRow = $userResult->fetch_assoc();
        $userSelect->close();

        if ($userRow !== null) {
            $userId = (int) $userRow['id'];
            $userUpdate = $mysqli->prepare(
                "UPDATE `{$prefix}user_accounts` SET display_name = ?, role = ?, is_active = 1 WHERE id = ?"
            );
            $userUpdate->bind_param('ssi', $displayName, $role, $userId);
            $userUpdate->execute();
            $userUpdate->close();
        } else {
            $isActive = 1;
            $userInsert = $mysqli->prepare(
                "INSERT INTO `{$prefix}user_accounts` (username, password_hash, display_name, role, is_active) VALUES (?, ?, ?, ?, ?)"
            );
            $userInsert->bind_param('ssssi', $username, $passwordHash, $displayName, $role, $isActive);
            $userInsert->execute();
            $userId = (int) $userInsert->insert_id;
            $userInsert->close();
        }

        $memberSelect = $mysqli->prepare("SELECT id FROM `{$prefix}member_profiles` WHERE user_account_id = ? LIMIT 1");
        $memberSelect->bind_param('i', $userId);
        $memberSelect->execute();
        $memberResult = $memberSelect->get_result();
        $memberRow = $memberResult->fetch_assoc();
        $memberSelect->close();

        if ($memberRow !== null) {
            $memberId = (int) $memberRow['id'];
            $memberUpdate = $mysqli->prepare(
                "UPDATE `{$prefix}member_profiles` SET player_id = ?, contact_email = ?, contact_phone = ? WHERE id = ?"
            );
            $memberUpdate->bind_param('issi', $playerId, $dummyEmail, $dummyPhone, $memberId);
            $memberUpdate->execute();
            $memberUpdate->close();
        } else {
            $notes = 'Seeded test/dev member profile';
            $memberInsert = $mysqli->prepare(
                "INSERT INTO `{$prefix}member_profiles` (user_account_id, player_id, contact_email, contact_phone, notes) VALUES (?, ?, ?, ?, ?)"
            );
            $memberInsert->bind_param('iisss', $userId, $playerId, $dummyEmail, $dummyPhone, $notes);
            $memberInsert->execute();
            $memberInsert->close();
        }
    }
};

function slugify_username(string $value): string
{
    $value = trim(preg_replace('/\s+/', ' ', $value) ?? $value);
    $ascii = iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $value);
    if ($ascii === false) {
        $ascii = $value;
    }

    $ascii = strtolower($ascii);
    $ascii = preg_replace('/[^a-z0-9]+/', '-', $ascii) ?? $ascii;
    $ascii = trim($ascii, '-');

    return $ascii !== '' ? $ascii : 'player';
}
