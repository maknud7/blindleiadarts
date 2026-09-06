<?php

declare(strict_types=1);

namespace Blindleia\Dartkiosk\Api\Support;

use RuntimeException;

/**
 * Cross-process admission control for hosted MySQL connections.
 *
 * The lock is acquired before mysqli connects, so queued PHP requests consume
 * no database connection while waiting. flock() is scoped to the local PHP
 * host/filesystem and is released automatically when the request/process ends.
 */
final class DatabaseConnectionGate
{
    /** @var resource|null */
    private $handle;
    private bool $released = false;

    /** @param resource $handle */
    private function __construct($handle, private readonly float $waitMs)
    {
        $this->handle = $handle;
    }

    public static function acquire(Config $config): ?self
    {
        $limit = $config->dbMaxConcurrentConnections();
        if ($limit <= 0) {
            return null;
        }

        $key = hash('sha256', implode('|', [
            $config->dbHost(),
            (string) $config->dbPort(),
            $config->dbName(),
            $config->dbUsername(),
        ]));
        $directory = rtrim(sys_get_temp_dir(), '/\\') . DIRECTORY_SEPARATOR . 'blindleiadarts-db-gate-' . $key;
        if (!is_dir($directory) && !@mkdir($directory, 0770, true) && !is_dir($directory)) {
            throw new RuntimeException('Could not initialize database connection gate.');
        }

        $started = microtime(true);
        $deadline = $started + ($config->dbConnectionWaitMs() / 1000);
        $offset = random_int(0, max(0, $limit - 1));

        do {
            for ($step = 0; $step < $limit; $step++) {
                $slot = ($offset + $step) % $limit;
                $path = $directory . DIRECTORY_SEPARATOR . 'slot-' . $slot . '.lock';
                $handle = @fopen($path, 'c+');
                if ($handle === false) {
                    continue;
                }

                if (@flock($handle, LOCK_EX | LOCK_NB)) {
                    return new self($handle, (microtime(true) - $started) * 1000);
                }
                fclose($handle);
            }

            if (microtime(true) >= $deadline) {
                break;
            }
            usleep(random_int(15000, 40000));
        } while (true);

        throw new RuntimeException(sprintf(
            'Database connection capacity remained busy for %d ms.',
            $config->dbConnectionWaitMs()
        ));
    }

    public function waitMs(): float
    {
        return $this->waitMs;
    }

    public function release(): void
    {
        if ($this->released) {
            return;
        }
        $this->released = true;
        if (is_resource($this->handle)) {
            @flock($this->handle, LOCK_UN);
            @fclose($this->handle);
        }
        $this->handle = null;
    }

    public function __destruct()
    {
        $this->release();
    }
}
