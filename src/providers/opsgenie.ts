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
    async validateCredentials(token: string): Promise<void> {
      await fetchPage(token, 1, 0);
    },
    async listServices(token: string): Promise<ProviderService[]> {
      const services: ProviderService[] = [];
      const limit = 100;

      for (let offset = 0; ; offset += limit) {
        const response = await fetchPage(token, limit, offset);
        services.push(...response.data);

        if (!response.paging?.next || response.data.length === 0) {
          return services;
        }
      }
    },
  };

  function fetchPage(token: string, limit: number, offset: number) {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    return http.request(
      `${baseUrl}/v1/services?${params.toString()}`,
      {
        headers: {
          Authorization: `GenieKey ${token}`,
          Accept: "application/json",
        },
      },
      opsgenieResponseSchema,
    );
  }
}
