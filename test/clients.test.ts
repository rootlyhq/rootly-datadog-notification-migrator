import { describe, expect, it, vi } from "vitest";

import {
  DatadogClient,
  validateExistingWebhook,
  webhookConfiguration,
} from "../src/clients/datadog.js";
import { RootlyClient } from "../src/clients/rootly.js";
import { WebhookConflictError } from "../src/errors.js";
import { HttpClient } from "../src/http.js";

const credentials = ["api-key", "app-key", "alert-secret"] as const;

describe("DatadogClient", () => {
  it("lists monitors and validates response data", async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        Response.json([{ id: 1, name: "Monitor", message: "hello" }]),
      ),
    ) as unknown as typeof fetch;
    const client = new DatadogClient(
      new HttpClient({ fetchImplementation: fetchMock }),
      "https://api.datadoghq.com/api/v1/",
      ...credentials,
    );

    await expect(client.listMonitors()).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("page=0&page_size=100"),
      expect.objectContaining({
        headers: expect.objectContaining({ "DD-API-KEY": "api-key" }),
      }),
    );
  });

  it("validates Datadog credentials with a one-monitor request", async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(Response.json([])),
    ) as unknown as typeof fetch;
    const client = new DatadogClient(
      new HttpClient({ fetchImplementation: fetchMock }),
      "https://api.datadoghq.com/api/v1",
      ...credentials,
    );

    await client.validateConnection();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("page=0&page_size=1"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "DD-API-KEY": "api-key",
          "DD-APPLICATION-KEY": "app-key",
        }),
      }),
    );
  });

  it("creates a webhook when it does not exist", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ errors: ["not found"] }, { status: 404 }),
      )
      .mockResolvedValueOnce(
        Response.json(
          webhookConfiguration("rootly-service", "rootly-1", "alert-secret"),
        ),
      ) as unknown as typeof fetch;
    const client = new DatadogClient(
      new HttpClient({ fetchImplementation: fetchMock }),
      "https://api.datadoghq.com/api/v1",
      ...credentials,
    );

    await client.ensureWebhook({
      name: "rootly-service",
      serviceName: "Service",
      rootlyServiceId: "rootly-1",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/webhooks"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("reuses an existing compatible webhook", async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        Response.json(
          webhookConfiguration("rootly-service", "rootly-1", "alert-secret"),
        ),
      ),
    ) as unknown as typeof fetch;
    const client = new DatadogClient(
      new HttpClient({ fetchImplementation: fetchMock }),
      "https://api.datadoghq.com/api/v1",
      ...credentials,
    );

    await client.ensureWebhook({
      name: "rootly-service",
      serviceName: "Service",
      rootlyServiceId: "rootly-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("updates synthetic monitors through the synthetics API", async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(Response.json({ ok: true })),
    ) as unknown as typeof fetch;
    const client = new DatadogClient(
      new HttpClient({ fetchImplementation: fetchMock }),
      "https://api.datadoghq.com/api/v1",
      ...credentials,
    );

    await client.updateMonitor(
      {
        id: 1,
        message: "old",
        type: "synthetics alert",
        options: { synthetics_check_id: "abc" },
      },
      "new",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/synthetics/tests/abc"),
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("updates standard monitors through the monitor API", async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(Response.json({ id: 1, message: "new" })),
    ) as unknown as typeof fetch;
    const client = new DatadogClient(
      new HttpClient({ fetchImplementation: fetchMock }),
      "https://api.datadoghq.com/api/v1",
      ...credentials,
    );

    await client.updateMonitor({ id: 1, message: "old" }, "new");

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/monitor/1"),
      expect.objectContaining({ method: "PUT" }),
    );
  });
});

describe("webhook validation", () => {
  it("accepts a webhook targeting the expected Rootly service", () => {
    expect(() =>
      validateExistingWebhook(
        webhookConfiguration("rootly-service", "rootly-1", "secret"),
        "rootly-1",
      ),
    ).not.toThrow();
  });

  it("rejects a webhook targeting a different service", () => {
    expect(() =>
      validateExistingWebhook(
        webhookConfiguration("rootly-service", "rootly-1", "secret"),
        "rootly-2",
      ),
    ).toThrow(WebhookConflictError);
  });

  it("rejects invalid URLs and payloads", () => {
    const valid = webhookConfiguration("rootly-service", "rootly-1", "secret");
    expect(() =>
      validateExistingWebhook(
        { ...valid, url: "https://example.com" },
        "rootly-1",
      ),
    ).toThrow(WebhookConflictError);
    expect(() =>
      validateExistingWebhook({ ...valid, payload: "{" }, "rootly-1"),
    ).toThrow(WebhookConflictError);
  });
});

describe("RootlyClient", () => {
  it("validates the Rootly token with a one-service request", async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(Response.json({ data: [] })),
    ) as unknown as typeof fetch;
    const client = new RootlyClient(
      new HttpClient({ fetchImplementation: fetchMock }),
      "https://api.rootly.com/v1",
      "token",
    );

    await client.validateConnection();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("page%5Bnumber%5D=1&page%5Bsize%5D=1"),
      expect.objectContaining({
        headers: { Authorization: "Bearer token" },
      }),
    );
  });

  it("paginates services until a short page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: String(index),
      attributes: {},
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: firstPage }))
      .mockResolvedValueOnce(
        Response.json({ data: [{ id: "last", attributes: {} }] }),
      ) as unknown as typeof fetch;
    const client = new RootlyClient(
      new HttpClient({ fetchImplementation: fetchMock }),
      "https://api.rootly.com/v1",
      "token",
    );

    await expect(client.listServices()).resolves.toHaveLength(101);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("page%5Bnumber%5D=2"),
      expect.anything(),
    );
  });
});
