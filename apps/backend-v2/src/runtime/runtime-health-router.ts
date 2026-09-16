import type { IncomingMessage } from "node:http";

import type { MySqlRuntimeHealthRepository } from "../mysql/runtime-health-repository.js";
import type { BackendRuntimeConfig } from "./config.js";

export interface RuntimeHealthRouteResult {
  readonly statusCode: number;
  readonly payload: Record<string, unknown>;
}

export class RuntimeHealthRouter {
  constructor(
    private readonly config: BackendRuntimeConfig,
    private readonly health: MySqlRuntimeHealthRepository,
  ) {}

  async handle(
    method: string,
    publicPath: string,
    request: IncomingMessage,
  ): Promise<RuntimeHealthRouteResult | null> {
    if (method !== "GET" || publicPath !== "/v1/health") return null;

    const url = new URL(request.url ?? publicPath, "http://backend-v2.internal");
    if (url.searchParams.get("deep") === "1") {
      return {
        statusCode: 200,
        payload: {
          ok: true,
          health: await this.health.deep(this.config.environment, this.config.releaseSha),
        },
      };
    }

    return {
      statusCode: 200,
      payload: {
        ok: true,
        status: "ok",
        environment: this.config.environment,
        database: {
          connected: await this.health.ping(),
          name: this.config.mysql.database,
          table_prefix: this.config.prefixes.runtime,
        },
      },
    };
  }
}
