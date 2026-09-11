<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Service;

use Blindleia\Dartkiosk\Api\Support\Config;

/**
 * Pure routing policy for a future backend-v2 scoring canary.
 *
 * This class deliberately performs no HTTP/network work. A candidate decision
 * only means that the kiosk is eligible for a later, separately implemented
 * single-writer route. Until that client exists PHP remains the only writer.
 */
final class BackendV2ScoringRoutingPolicy
{
    public const ROUTE_PHP = 'php';
    public const ROUTE_CANDIDATE = 'candidate';

    /** @var array<string, true> */
    private array $canaryKioskIds = [];
    private bool $configurationValid = false;

    public function __construct(
        private readonly string $mode,
        private readonly string $baseUrl,
        string $canaryKioskIds
    ) {
        $this->configurationValid = $this->parseConfiguration($canaryKioskIds);
    }

    public static function fromConfig(Config $config): self
    {
        return new self(
            $config->backendV2ScoringRoutingMode(),
            $config->backendV2BaseUrl(),
            $config->backendV2CanaryKioskIds()
        );
    }

    public function routeForKiosk(string $kioskId): string
    {
        if (
            $this->mode !== self::ROUTE_CANDIDATE
            || !$this->configurationValid
            || !self::isCanonicalPositiveDecimalId($kioskId)
        ) {
            return self::ROUTE_PHP;
        }

        return isset($this->canaryKioskIds[$kioskId])
            ? self::ROUTE_CANDIDATE
            : self::ROUTE_PHP;
    }

    private function parseConfiguration(string $rawCanaryKioskIds): bool
    {
        if ($this->mode !== self::ROUTE_CANDIDATE) {
            return $this->mode === self::ROUTE_PHP;
        }

        if (!self::isStrictHttpsBaseUrl($this->baseUrl)) {
            return false;
        }

        $rawCanaryKioskIds = trim($rawCanaryKioskIds);
        if ($rawCanaryKioskIds === '') {
            return false;
        }

        $parsed = [];
        foreach (explode(',', $rawCanaryKioskIds) as $rawId) {
            $id = trim($rawId);
            if (!self::isCanonicalPositiveDecimalId($id)) {
                // One malformed entry invalidates the complete candidate config.
                // Partial acceptance would make a typo capable of changing routing.
                return false;
            }
            $parsed[$id] = true;
        }

        $this->canaryKioskIds = $parsed;
        return $parsed !== [];
    }

    private static function isCanonicalPositiveDecimalId(string $value): bool
    {
        // Keep database BIGINT identifiers as decimal strings. No integer cast.
        return preg_match('/^[1-9][0-9]*$/D', $value) === 1;
    }

    private static function isStrictHttpsBaseUrl(string $value): bool
    {
        $value = trim($value);
        if ($value === '' || filter_var($value, FILTER_VALIDATE_URL) === false) {
            return false;
        }

        $parts = parse_url($value);
        if (!is_array($parts)) {
            return false;
        }

        return strtolower((string) ($parts['scheme'] ?? '')) === 'https'
            && trim((string) ($parts['host'] ?? '')) !== ''
            && !isset($parts['user'])
            && !isset($parts['pass'])
            && !isset($parts['fragment']);
    }
}
