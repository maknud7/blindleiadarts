<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

final class PhpCanonicalScoringAdapter implements ScoringMutationPort
{
    public function __construct(private readonly CanonicalScoringService $scoring)
    {
    }

    public function startMatch(int $kioskId, string $source = 'manual'): void
    {
        $this->scoring->startMatch($kioskId, $source);
    }

    /** @param array<string,mixed> $payload */
    public function recordVisit(int $kioskId, array $payload, string $source = 'manual'): void
    {
        $this->scoring->recordVisit($kioskId, $payload, $source);
    }

    public function undoLastVisit(int $kioskId, string $source = 'manual'): void
    {
        $this->scoring->undoLastVisit($kioskId, $source);
    }
}
