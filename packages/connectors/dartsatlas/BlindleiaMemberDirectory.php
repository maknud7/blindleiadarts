<?php

declare(strict_types=1);

final class BlindleiaMemberDirectory
{
    private string $table;

    public function __construct(private mysqli $db, string $memberTable = 'medlemmer')
    {
        if (!preg_match('/^[A-Za-z0-9_]+$/', $memberTable)) {
            throw new InvalidArgumentException('Invalid member table name.');
        }
        $this->table = $memberTable;
    }

    /** @return list<array{id:int,medlemsnummer:?int,navn:string}> */
    public function all(): array
    {
        $result = $this->db->query("SELECT id, medlemsnummer, navn FROM `{$this->table}` ORDER BY navn");
        $rows = [];
        while ($row = $result->fetch_assoc()) {
            $rows[] = [
                'id' => (int) $row['id'],
                'medlemsnummer' => $row['medlemsnummer'] === null ? null : (int) $row['medlemsnummer'],
                'navn' => (string) $row['navn'],
            ];
        }
        $result->free();
        return $rows;
    }

    /** @return list<array{id:int,medlemsnummer:?int,navn:string}> */
    public function exactName(string $name): array
    {
        $needle = self::normaliseName($name);
        if ($needle === '') return [];
        return array_values(array_filter(
            $this->all(),
            static fn(array $member): bool => self::normaliseName($member['navn']) === $needle
        ));
    }

    public function exists(int $memberId): bool
    {
        foreach ($this->all() as $member) if ($member['id'] === $memberId) return true;
        return false;
    }

    public static function normaliseName(string $name): string
    {
        $name = trim($name);
        if ($name === '') return '';
        $name = function_exists('mb_strtolower') ? mb_strtolower($name, 'UTF-8') : strtolower($name);
        $name = str_replace(['’', '‘', '`'], "'", $name);
        $name = preg_replace('/[^\p{L}\p{N}\s-]+/u', '', $name) ?? $name;
        return trim(preg_replace('/[\s-]+/u', ' ', $name) ?? $name);
    }
}
