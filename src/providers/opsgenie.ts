import { z } from "zod";

import type { HttpClient } from "../http.js";
import type { ProviderAdapter, ProviderService } from "../types.js";

const opsgenieResponseSchema = z.object({
  data: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
    }),
  ),
  paging: z
    .object({
      next: z.string().optional(),
    })
    .optional(),
});

export function createOpsgenieProvider(
  http: HttpClient,
  apiUrl: string,
): ProviderAdapter {
  const baseUrl = apiUrl.replace(/\/$/, "");

  return {
    id: "opsgenie",
    displayName: "Opsgenie",
    notificationPrefix: "@opsgenie-",
    rootlyAttribute: "opsgenie_id",
    tokenEnvironmentVariable: "OPSGENIE_API_TOKEN",
    async listServices(token: string): Promise<ProviderService[]> {
      const services: ProviderService[] = [];
      const limit = 100;

      for (let offset = 0; ; offset += limit) {
        const params = new URLSearchParams({
          limit: String(limit),
          offset: String(offset),
        });
        const response = await http.request(
          `${baseUrl}/v1/services?${params.toString()}`,
          {
            headers: {
              Authorization: `GenieKey ${token}`,
              Accept: "application/json",
            },
          },
          opsgenieResponseSchema,
        );
        services.push(...response.data);

        if (!response.paging?.next || response.data.length === 0) {
          return services;
        }
      }
    },
  };
}
