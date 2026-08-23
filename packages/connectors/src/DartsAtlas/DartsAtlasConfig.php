<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Connectors\DartsAtlas;

final class DartsAtlasConfig
{
    public function __construct(
        private readonly string $seasonId = '',
        private readonly string $tournamentId = '',
        private readonly int $clubId = 0,
        private readonly ?int $localSeasonId = null,
        private readonly string $membersTable = 'medlemmer',
        private readonly int $pollIntervalSeconds = 8,
        private readonly string $userAgent = 'BlindleiaDarts/1.0',
    ) {}

    public function seasonId(): string
    {
        return $this->seasonId;
    }

    public function tournamentId(): string
    {
        return $this->tournamentId;
    }

    public function clubId(): int
    {
        return $this->clubId;
    }

    public function withClubId(int $clubId): self
    {
        return new self(
            $this->seasonId,
            $this->tournamentId,
            $clubId,
            $this->localSeasonId,
            $this->membersTable,
            $this->pollIntervalSeconds,
            $this->userAgent,
        );
    }

    public function localSeasonId(): ?int
    {
        return $this->localSeasonId;
    }

    public function membersTable(): string
    {
        return $this->membersTable;
    }

    public function pollIntervalSeconds(): int
    {
        return max(5, $this->pollIntervalSeconds);
    }

    public function userAgent(): string
    {
        return $this->userAgent;
    }
}
