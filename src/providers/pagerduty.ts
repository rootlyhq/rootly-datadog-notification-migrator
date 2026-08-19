import { z } from "zod";

import type { HttpClient } from "../http.js";
import type { ProviderAdapter, ProviderService } from "../types.js";

const pagerDutyResponseSchema = z.object({
  services: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
    }),
  ),
  more: z.boolean().default(false),
});

export function createPagerDutyProvider(
  http: HttpClient,
  apiUrl: string,
): ProviderAdapter {
  const baseUrl = apiUrl.replace(/\/$/, "");

  return {
    id: "pagerduty",
    displayName: "PagerDuty",
    notificationPrefix: "@pagerduty-",
    rootlyAttribute: "pagerduty_id",
    tokenEnvironmentVariable: "PAGERDUTY_API_TOKEN",
    async validateCredentials(token: string): Promise<void> {
      await fetchPage(token, 1, 0);
    },
    async listServices(token: string): Promise<ProviderService[]> {
      const services: ProviderService[] = [];
      const limit = 100;

      for (let offset = 0; ; offset += limit) {
        const response = await fetchPage(token, limit, offset);
        services.push(...response.services);

        if (!response.more) {
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
      `${baseUrl}/services?${params.toString()}`,
      {
        headers: {
          Authorization: `Token token=${token}`,
          Accept: "application/vnd.pagerduty+json;version=2",
        },
      },
      pagerDutyResponseSchema,
    );
  }
}
