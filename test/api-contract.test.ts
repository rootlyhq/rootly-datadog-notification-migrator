import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DatadogClient, webhookConfiguration } from "../src/clients/datadog.js";
import { RootlyClient } from "../src/clients/rootly.js";
import { MigrationEngine } from "../src/engine.js";
import { HttpClient } from "../src/http.js";
import { createOpsgenieProvider } from "../src/providers/opsgenie.js";
import { createPagerDutyProvider } from "../src/providers/pagerduty.js";
import type { DatadogMonitor, WebhookConfiguration } from "../src/types.js";

const defaultMonitor: DatadogMonitor = {
  id: 17,
  name: "Production services",
  message: "Notify @pagerduty-API and @opsgenie-Checkout",
};
const webhooks = new Map<string, WebhookConfiguration>();
const requests: { method: string; path: string; authorization?: string }[] = [];
let currentMonitor: DatadogMonitor = { ...defaultMonitor };
let updatedMessage = defaultMonitor.message;
let baseUrl = "";

const server = createServer((request, response) => {
  void route(request, response).catch((error: unknown) => {
    respond(response, 500, {
      error: error instanceof Error ? error.message : "unknown test error",
    });
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  currentMonitor = { ...defaultMonitor };
  updatedMessage = currentMonitor.message;
  webhooks.clear();
  requests.length = 0;
});

describe("API contracts", () => {
  it.each([
    {
      name: "PagerDuty",
      notification: "@pagerduty-API",
      webhook: "rootly-api",
      token: "pd-token",
      providerPath: "/pagerduty/services?limit=100&offset=0",
      authorization: "Token token=pd-token",
      createAdapter: (http: HttpClient) =>
        createPagerDutyProvider(http, `${baseUrl}/pagerduty`),
    },
    {
      name: "Opsgenie",
      notification: "@opsgenie-Checkout",
      webhook: "rootly-checkout",
      token: "og-token",
      providerPath: "/opsgenie/v1/services?limit=100&offset=0",
      authorization: "GenieKey og-token",
      createAdapter: (http: HttpClient) =>
        createOpsgenieProvider(http, `${baseUrl}/opsgenie`),
    },
  ])(
    "plans and applies $name through its HTTP boundaries",
    async (provider) => {
      currentMonitor = { ...defaultMonitor, message: provider.notification };
      updatedMessage = currentMonitor.message;
      const http = new HttpClient({ maxGetAttempts: 1 });
      const datadog = new DatadogClient(
        http,
        `${baseUrl}/datadog`,
        "dd-api",
        "dd-app",
        "rootly-secret",
      );
      const rootly = new RootlyClient(
        http,
        `${baseUrl}/rootly`,
        "rootly-token",
      );
      const engine = new MigrationEngine(datadog, rootly, {
        adapter: provider.createAdapter(http),
        token: provider.token,
      });

      const plan = await engine.plan();
      expect(plan.issues).toEqual([]);
      expect(plan.updates).toHaveLength(1);
      expect(plan.webhooks.map(({ name }) => name)).toEqual([provider.webhook]);

      const result = await engine.execute(plan);
      expect(result.errors).toEqual([]);
      expect(result.appliedMonitorIds).toEqual([17]);
      expect(updatedMessage).toContain(`@webhook-${provider.webhook}`);
      expect(webhooks).toHaveLength(1);
      expect(requests).toContainEqual(
        expect.objectContaining({
          path: provider.providerPath,
          authorization: provider.authorization,
        }),
      );

      const secondPlan = await engine.plan();
      expect(secondPlan.issues).toEqual([]);
      expect(secondPlan.updates).toEqual([]);
      expect(await engine.execute(secondPlan)).toMatchObject({
        errors: [],
        appliedMonitorIds: [],
      });
      expect(
        requests.filter(
          ({ method, path }) =>
            method === "POST" &&
            path === "/datadog/integration/webhooks/configuration/webhooks",
        ),
      ).toHaveLength(1);
      expect(
        requests.filter(
          ({ method, path }) =>
            method === "PUT" && path === "/datadog/monitor/17",
        ),
      ).toHaveLength(1);
    },
  );

  it("updates a synthetic monitor through the synthetics API", async () => {
    currentMonitor = {
      id: 23,
      name: "Synthetic API check",
      message: "Notify @pagerduty-API",
      type: "synthetics alert",
      options: { synthetics_check_id: "api-check" },
    };
    updatedMessage = currentMonitor.message;
    const http = new HttpClient({ maxGetAttempts: 1 });
    const engine = new MigrationEngine(
      new DatadogClient(
        http,
        `${baseUrl}/datadog`,
        "dd-api",
        "dd-app",
        "rootly-secret",
      ),
      new RootlyClient(http, `${baseUrl}/rootly`, "rootly-token"),
      {
        adapter: createPagerDutyProvider(http, `${baseUrl}/pagerduty`),
        token: "pd-token",
      },
    );

    const result = await engine.execute(await engine.plan());

    expect(result.errors).toEqual([]);
    expect(result.appliedMonitorIds).toEqual([23]);
    expect(updatedMessage).toContain("@webhook-rootly-api");
    expect(requests).toContainEqual({
      method: "PATCH",
      path: "/datadog/synthetics/tests/api-check",
    });
    expect(requests).not.toContainEqual(
      expect.objectContaining({ method: "PUT" }),
    );
  });
});

async function route(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", baseUrl);
  requests.push({
    method,
    path: `${url.pathname}${url.search}`,
    ...(request.headers.authorization
      ? { authorization: request.headers.authorization }
      : {}),
  });

  if (method === "GET" && url.pathname === "/datadog/monitor") {
    requireHeader(request, "dd-api-key", "dd-api");
    requireHeader(request, "dd-application-key", "dd-app");
    const idOffset = Number(url.searchParams.get("id_offset") ?? "0");
    respond(
      response,
      200,
      currentMonitor.id > idOffset
        ? [{ ...currentMonitor, message: updatedMessage }]
        : [],
    );
    return;
  }
  if (
    method === "GET" &&
    url.pathname === `/datadog/monitor/${currentMonitor.id}`
  ) {
    respond(response, 200, { ...currentMonitor, message: updatedMessage });
    return;
  }
  if (
    method === "PUT" &&
    url.pathname === `/datadog/monitor/${currentMonitor.id}`
  ) {
    const body = (await jsonBody(request)) as DatadogMonitor;
    updatedMessage = body.message;
    respond(response, 200, body);
    return;
  }
  if (
    method === "PATCH" &&
    url.pathname === "/datadog/synthetics/tests/api-check"
  ) {
    const body = (await jsonBody(request)) as {
      data?: { value?: unknown }[];
    };
    const value = body.data?.[0]?.value;
    if (typeof value !== "string") {
      throw new Error("Synthetic patch is missing a string message");
    }
    updatedMessage = value;
    respond(response, 200, { ok: true });
    return;
  }
  if (method === "GET" && url.pathname === "/rootly/services") {
    requireHeader(request, "authorization", "Bearer rootly-token");
    respond(response, 200, {
      data: [
        { id: "rootly-api", attributes: { pagerduty_id: "pd-api" } },
        {
          id: "rootly-checkout",
          attributes: { opsgenie_id: "og-checkout" },
        },
      ],
    });
    return;
  }
  if (method === "GET" && url.pathname === "/pagerduty/services") {
    requireHeader(request, "authorization", "Token token=pd-token");
    respond(response, 200, {
      services: [{ id: "pd-api", name: "API" }],
      more: false,
    });
    return;
  }
  if (method === "GET" && url.pathname === "/opsgenie/v1/services") {
    requireHeader(request, "authorization", "GenieKey og-token");
    respond(response, 200, {
      data: [{ id: "og-checkout", name: "Checkout" }],
    });
    return;
  }

  const webhookPrefix = "/datadog/integration/webhooks/configuration/webhooks/";
  if (method === "GET" && url.pathname.startsWith(webhookPrefix)) {
    const name = decodeURIComponent(url.pathname.slice(webhookPrefix.length));
    const webhook = webhooks.get(name);
    respond(
      response,
      webhook ? 200 : 404,
      webhook ?? { errors: ["not found"] },
    );
    return;
  }
  if (
    method === "POST" &&
    url.pathname === "/datadog/integration/webhooks/configuration/webhooks"
  ) {
    const body = (await jsonBody(request)) as WebhookConfiguration;
    const expected = webhookConfiguration(
      body.name,
      body.name === "rootly-api" ? "rootly-api" : "rootly-checkout",
      "rootly-secret",
    );
    expect(body).toEqual(expected);
    webhooks.set(body.name, body);
    respond(response, 200, body);
    return;
  }

  respond(response, 404, { error: `Unhandled ${method} ${url.pathname}` });
}

function requireHeader(
  request: IncomingMessage,
  name: string,
  expected: string,
): void {
  if (request.headers[name] !== expected) {
    throw new Error(`Invalid ${name} header`);
  }
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function respond(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
