<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Connectors\Challonge;

use Blindleia\Dartkiosk\Connectors\Contracts\TournamentProviderInterface;

final class ChallongeTournamentProvider implements TournamentProviderInterface
{
    private ChallongeApiClient $client;

    public function __construct(ChallongeApiClient $client)
    {
        $this->client = $client;
    }

    public function providerKey(): string
    {
        return 'challonge';
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listTournaments(string $accessToken): array
    {
        $response = $this->client->get('/tournaments.json', $accessToken);
        return $this->normalizeDataArray($response);
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listParticipants(string $accessToken, string $tournamentId): array
    {
        $response = $this->client->get('/tournaments/' . rawurlencode($tournamentId) . '/participants.json', $accessToken);
        return $this->normalizeDataArray($response);
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function listMatches(string $accessToken, string $tournamentId): array
    {
        $response = $this->client->get('/tournaments/' . rawurlencode($tournamentId) . '/matches.json', $accessToken);
        return $this->normalizeDataArray($response);
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function normalizeDataArray(array $response): array
    {
        $data = $response['data'] ?? [];
        return is_array($data) ? $data : [];
    }
}
