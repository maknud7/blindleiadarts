<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

interface ScoringMutationPort
{
    public function startMatch(int $kioskId, string $source = 'manual'): void;

    /** @param array<string,mixed> $payload */
    public function recordVisit(int $kioskId, array $payload, string $source = 'manual'): void;

    public function undoLastVisit(int $kioskId, string $source = 'manual'): void;
}
