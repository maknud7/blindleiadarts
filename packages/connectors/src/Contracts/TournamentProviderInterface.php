<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Connectors\Contracts;

interface TournamentProviderInterface
{
    public function providerKey(): string;

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listTournaments(string $accessToken): array;

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listParticipants(string $accessToken, string $tournamentId): array;

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listMatches(string $accessToken, string $tournamentId): array;
}
