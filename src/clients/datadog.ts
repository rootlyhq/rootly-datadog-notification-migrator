import { z } from "zod";

import { ApiError, WebhookConflictError } from "../errors.js";
import type { HttpClient } from "../http.js";
import type {
  DatadogMonitor,
  PlannedWebhook,
  WebhookConfiguration,
} from "../types.js";

const monitorSchema = z.looseObject({
  id: z.number(),
  name: z.string().optional(),
  message: z.string(),
  type: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});
const monitorsSchema = z.array(monitorSchema);
const webhookSchema = z.looseObject({
  name: z.string(),
  url: z.string(),
  payload: z.string().nullable().optional(),
  custom_headers: z.string().nullable().optional(),
  encode_as: z.string().optional(),
});
const unknownSchema = z.unknown();

const ROOTLY_WEBHOOK_URL =
  "https://webhooks.rootly.com/webhooks/incoming/datadog_webhooks";

export class DatadogClient {
  readonly #http: HttpClient;
  readonly #apiUrl: string;
  readonly #headers: Record<string, string>;
  readonly #alertSourceSecret: string;

  constructor(
    http: HttpClient,
    apiUrl: string,
    apiKey: string,
    appKey: string,
    alertSourceSecret: string,
  ) {
    this.#http = http;
    this.#apiUrl = apiUrl.replace(/\/$/, "");
    this.#headers = {
      "DD-API-KEY": apiKey,
      "DD-APPLICATION-KEY": appKey,
    };
    this.#alertSourceSecret = alertSourceSecret;
  }

  async listMonitors(): Promise<DatadogMonitor[]> {
    const monitors: DatadogMonitor[] = [];
    const pageSize = 100;
    let idOffset = 0;

    for (;;) {
      const response = await this.#listMonitorsPage(idOffset, pageSize);

      if (response.length === 0) {
        return monitors;
      }

      let nextOffset = idOffset;
      for (const monitor of response) {
        if (monitor.id <= nextOffset) {
          throw new Error(
            `Datadog monitor pagination did not advance beyond ID ${nextOffset}`,
          );
        }
        nextOffset = monitor.id;
      }

      monitors.push(...response);
      idOffset = nextOffset;
    }
  }

  async validateConnection(): Promise<void> {
    await this.#listMonitorsPage(0, 1);
  }

  async getMonitor(id: number): Promise<DatadogMonitor> {
    return this.#http.request(
      `${this.#apiUrl}/monitor/${id}`,
      { headers: this.#headers },
      monitorSchema,
    );
  }

  async ensureWebhook(webhook: PlannedWebhook): Promise<void> {
    const existing = await this.#getWebhook(webhook.name);
    if (existing) {
      validateExistingWebhook(existing, webhook.rootlyServiceId);
      return;
    }

    try {
      await this.#http.request(
        `${this.#apiUrl}/integration/webhooks/configuration/webhooks`,
        {
          method: "POST",
          headers: {
            ...this.#headers,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            webhookConfiguration(
              webhook.name,
              webhook.rootlyServiceId,
              this.#alertSourceSecret,
            ),
          ),
        },
        webhookSchema,
      );
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) {
        throw error;
      }

      const racedWebhook = await this.#getWebhook(webhook.name);
      if (!racedWebhook) {
        throw error;
      }
      validateExistingWebhook(racedWebhook, webhook.rootlyServiceId);
    }
  }

  async validateWebhookAvailability(webhook: PlannedWebhook): Promise<void> {
    const existing = await this.#getWebhook(webhook.name);
    if (existing) {
      validateExistingWebhook(existing, webhook.rootlyServiceId);
    }
  }

  async updateMonitor(monitor: DatadogMonitor, message: string): Promise<void> {
    const syntheticsCheckId = monitor.options?.synthetics_check_id;

    if (
      monitor.type === "synthetics alert" &&
      typeof syntheticsCheckId === "string"
    ) {
      await this.#http.request(
        `${this.#apiUrl}/synthetics/tests/${encodeURIComponent(syntheticsCheckId)}`,
        {
          method: "PATCH",
          headers: {
            ...this.#headers,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            data: [{ path: "/message", op: "replace", value: message }],
          }),
        },
        unknownSchema,
      );
      return;
    }

    await this.#http.request(
      `${this.#apiUrl}/monitor/${monitor.id}`,
      {
        method: "PUT",
        headers: {
          ...this.#headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...monitor, message }),
      },
      monitorSchema,
    );
  }

  async #getWebhook(name: string): Promise<WebhookConfiguration | null> {
    try {
      return await this.#http.request(
        `${this.#apiUrl}/integration/webhooks/configuration/webhooks/${encodeURIComponent(name)}`,
        { headers: this.#headers },
        webhookSchema,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async #listMonitorsPage(
    idOffset: number,
    pageSize: number,
  ): Promise<DatadogMonitor[]> {
    const params = new URLSearchParams({
      id_offset: String(idOffset),
      page_size: String(pageSize),
    });
    return this.#http.request(
      `${this.#apiUrl}/monitor?${params.toString()}`,
      { headers: this.#headers },
      monitorsSchema,
    );
  }
}

export function webhookConfiguration(
  name: string,
  rootlyServiceId: string,
  alertSourceSecret: string,
): WebhookConfiguration {
  return {
    name,
    url: ROOTLY_WEBHOOK_URL,
    encode_as: "json",
    payload: JSON.stringify({
      id: "$ID",
      body: "$EVENT_MSG",
      last_updated: "$LAST_UPDATED",
      event_type: "$EVENT_TYPE",
      title: "$EVENT_TITLE",
      alert_id: "$ALERT_ID",
      alert_metric: "$ALERT_METRIC",
      alert_priority: "$ALERT_PRIORITY",
      alert_query: "$ALERT_QUERY",
      alert_scope: "$ALERT_SCOPE",
      alert_status: "$ALERT_STATUS",
      alert_title: "$ALERT_TITLE",
      alert_transition: "$ALERT_TRANSITION",
      alert_type: "$ALERT_TYPE",
      alert_cycle_key: "$ALERT_CYCLE_KEY",
      date: "$DATE",
      org: { id: "$ORG_ID", name: "$ORG_NAME" },
      rootly: {
        notification_target: {
          type: "Service",
          id: rootlyServiceId,
        },
      },
    }),
    custom_headers: JSON.stringify({ secret: alertSourceSecret }),
  };
}

export function validateExistingWebhook(
  webhook: WebhookConfiguration,
  expectedRootlyServiceId: string,
): void {
  if (webhook.url !== ROOTLY_WEBHOOK_URL) {
    throw new WebhookConflictError(
      `Datadog webhook ${webhook.name} already exists with a different URL`,
    );
  }

  let payload: unknown;
  try {
    payload = webhook.payload ? (JSON.parse(webhook.payload) as unknown) : null;
  } catch {
    throw new WebhookConflictError(
      `Datadog webhook ${webhook.name} already exists with an invalid payload`,
    );
  }

  const targetSchema = z.object({
    rootly: z.object({
      notification_target: z.object({
        type: z.literal("Service"),
        id: z.string(),
      }),
    }),
  });
  const parsed = targetSchema.safeParse(payload);

  if (
    !parsed.success ||
    parsed.data.rootly.notification_target.id !== expectedRootlyServiceId
  ) {
    throw new WebhookConflictError(
      `Datadog webhook ${webhook.name} already exists for a different Rootly service`,
    );
  }
}
