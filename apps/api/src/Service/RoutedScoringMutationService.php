<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

use Blindleia\Dartkiosk\Api\Support\Config;
use Blindleia\Dartkiosk\Api\Support\Database;
use RuntimeException;

/**
 * One decision boundary for canonical scoring writes while PHP and backend-v2 coexist.
 *
 * The route is chosen before any mutation. Candidate traffic is sent exactly once to
 * backend-v2 and is never repeated through PHP after a remote attempt, even when the
 * remote outcome is unknown. Non-candidate traffic stays on the legacy PHP writer.
 */
final class RoutedScoringMutationService implements ScoringMutationPort
{
    public function __construct(
        private readonly BackendV2ScoringRoutingPolicy $policy,
        private readonly ScoringMutationPort $phpScoring,
        private readonly ?BackendV2ScoringClient $backendV2
    ) {
    }

    public static function fromRuntime(Database $database, Config $config): self
    {
        $baseUrl = $config->backendV2BaseUrl();
        $token = $config->backendV2InternalToken();
        $client = null;
        if ($baseUrl !== '' && $token !== '') {
            $client = new BackendV2ScoringClient($baseUrl, $token);
        }

        return new self(
            BackendV2ScoringRoutingPolicy::fromConfig($config),
            new CanonicalScoringService($database, $config),
            $client
        );
    }

    public function startMatch(int $kioskId, string $source = 'manual'): void
    {
        if ($this->route($kioskId) === BackendV2ScoringRoutingPolicy::ROUTE_CANDIDATE) {
            $this->backend()->startMatch((string) $kioskId, $source);
            return;
        }
        $this->phpScoring->startMatch($kioskId, $source);
    }

    /** @param array<string,mixed> $payload */
    public function recordVisit(int $kioskId, array $payload, string $source = 'manual'): void
    {
        if ($this->route($kioskId) === BackendV2ScoringRoutingPolicy::ROUTE_CANDIDATE) {
            $this->backend()->recordVisit((string) $kioskId, $payload, $source);
            return;
        }
        $this->phpScoring->recordVisit($kioskId, $payload, $source);
    }

    public function undoLastVisit(int $kioskId, string $source = 'manual'): void
    {
        if ($this->route($kioskId) === BackendV2ScoringRoutingPolicy::ROUTE_CANDIDATE) {
            $this->backend()->undoLastVisit((string) $kioskId, $source);
            return;
        }
        $this->phpScoring->undoLastVisit($kioskId, $source);
    }

    private function route(int $kioskId): string
    {
        return $this->policy->routeForKiosk((string) $kioskId);
    }

    private function backend(): BackendV2ScoringClient
    {
        if ($this->backendV2 === null) {
            // No mutation has happened yet. Fail closed instead of silently changing writer.
            throw new RuntimeException('Backend-v2 scoring route is selected but its client is not configured.');
        }
        return $this->backendV2;
    }
}
