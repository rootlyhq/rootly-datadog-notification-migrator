import type { HttpClient } from "../http.js";
import type { ProviderAdapter, ProviderId } from "../types.js";
import { createOpsgenieProvider } from "./opsgenie.js";
import { createPagerDutyProvider } from "./pagerduty.js";

export function createProvider(
  id: ProviderId,
  http: HttpClient,
  apiUrl: string,
): ProviderAdapter {
  switch (id) {
    case "pagerduty":
      return createPagerDutyProvider(http, apiUrl);
    case "opsgenie":
      return createOpsgenieProvider(http, apiUrl);
  }
}
