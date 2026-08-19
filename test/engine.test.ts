import { describe, expect, it, vi } from "vitest";

import {
  MigrationEngine,
  type DatadogOperations,
  type RootlyOperations,
} from "../src/engine.js";
import { WebhookConflictError } from "../src/errors.js";
import type {
  DatadogMonitor,
  ProviderAdapter,
  RootlyService,
} from "../src/types.js";

function fixture(
  overrides: {
    monitors?: DatadogMonitor[];
    rootlyServices?: RootlyService[];
    providerServices?: { id: string; name: string }[];
  } = {},
) {
  const monitors = overrides.monitors ?? [
    {
      id: 42,
      name: "CPU",
      message:
        "Alert @pagerduty-Production and @pagerduty-Existing @webhook-rootly-existing",
    },
  ];
  const providerServices = overrides.providerServices ?? [
    { id: "pd-1", name: "Production" },
    { id: "pd-2", name: "Existing" },
  ];
  const rootlyServices = overrides.rootlyServices ?? [
    { id: "rootly-1", attributes: { pagerduty_id: "pd-1" } },
    { id: "rootly-2", attributes: { pagerduty_id: "pd-2" } },
  ];
  const datadog: DatadogOperations = {
    listMonitors: vi.fn(async () => Promise.resolve(monitors)),
    validateWebhookAvailability: vi.fn(async () => Promise.resolve()),
    ensureWebhook: vi.fn(async () => Promise.resolve()),
    getMonitor: vi.fn(async (id) => {
      const monitor = monitors.find((candidate) => candidate.id === id);
      if (!monitor) throw new Error("missing fixture");
      return Promise.resolve(monitor);
    }),
    updateMonitor: vi.fn(async () => Promise.resolve()),
  };
  const rootly: RootlyOperations = {
    listServices: vi.fn(async () => Promise.resolve(rootlyServices)),
  };
  const provider: ProviderAdapter = {
    id: "pagerduty",
    displayName: "PagerDuty",
    notificationPrefix: "@pagerduty-",
    rootlyAttribute: "pagerduty_id",
    tokenEnvironmentVariable: "PAGERDUTY_API_TOKEN",
    listServices: vi.fn(async () => Promise.resolve(providerServices)),
  };

  return {
    datadog,
    rootly,
    provider,
    engine: new MigrationEngine(datadog, rootly, [
      { adapter: provider, token: "token" },
    ]),
  };
}

describe("MigrationEngine.plan", () => {
  it("plans missing targets without skipping a partially migrated monitor", async () => {
    const { engine } = fixture();

    const plan = await engine.plan();

    expect(plan.issues).toEqual([]);
    expect(plan.webhooks).toEqual([
      {
        name: "rootly-production",
        serviceName: "Production",
        rootlyServiceId: "rootly-1",
      },
      {
        name: "rootly-existing",
        serviceName: "Existing",
        rootlyServiceId: "rootly-2",
      },
    ]);
    expect(plan.updates[0]?.newMessage).toContain(
      "@pagerduty-Production @webhook-rootly-production",
    );
    expect(plan.updates[0]?.newMessage).not.toContain(
      "@webhook-rootly-existing @webhook-rootly-existing",
    );
  });

  it("reports missing and ambiguous mappings", async () => {
    const { engine } = fixture({
      monitors: [{ id: 1, message: "@pagerduty-Unknown" }],
      providerServices: [],
      rootlyServices: [],
    });

    await expect(engine.plan()).resolves.toMatchObject({
      issues: [{ code: "missing-provider-service", monitorId: 1 }],
    });
  });

  it("blocks ambiguous normalized provider names", async () => {
    const { engine } = fixture({
      monitors: [{ id: 1, message: "@pagerduty-Team_One" }],
      providerServices: [
        { id: "1", name: "Team One" },
        { id: "2", name: "Team_One" },
      ],
      rootlyServices: [],
    });

    expect((await engine.plan()).issues[0]?.code).toBe(
      "ambiguous-provider-service",
    );
  });

  it("reports missing and ambiguous Rootly links", async () => {
    const missing = fixture({
      monitors: [{ id: 1, message: "@pagerduty-Production" }],
      providerServices: [{ id: "pd-1", name: "Production" }],
      rootlyServices: [],
    });
    expect((await missing.engine.plan()).issues[0]?.code).toBe(
      "missing-rootly-service",
    );

    const ambiguous = fixture({
      monitors: [{ id: 1, message: "@pagerduty-Production" }],
      providerServices: [{ id: "pd-1", name: "Production" }],
      rootlyServices: [
        { id: "rootly-1", attributes: { pagerduty_id: "pd-1" } },
        { id: "rootly-2", attributes: { pagerduty_id: "pd-1" } },
      ],
    });
    expect((await ambiguous.engine.plan()).issues[0]?.code).toBe(
      "ambiguous-rootly-service",
    );
  });

  it("turns an existing incompatible webhook into a blocking issue", async () => {
    const { engine, datadog } = fixture();
    vi.mocked(datadog.validateWebhookAvailability).mockRejectedValueOnce(
      new WebhookConflictError("wrong target"),
    );

    const plan = await engine.plan();

    expect(plan.issues).toContainEqual({
      code: "webhook-name-collision",
      message: "wrong target",
    });
  });

  it("verifies a webhook already mentioned by the monitor", async () => {
    const { engine, datadog } = fixture({
      monitors: [
        {
          id: 1,
          message: "@pagerduty-Production @webhook-rootly-production",
        },
      ],
      providerServices: [{ id: "pd-1", name: "Production" }],
      rootlyServices: [
        { id: "rootly-1", attributes: { pagerduty_id: "pd-1" } },
      ],
    });

    await engine.plan();

    expect(datadog.validateWebhookAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ name: "rootly-production" }),
    );
  });

  it("fails closed when webhook inspection itself fails", async () => {
    const { engine, datadog } = fixture();
    vi.mocked(datadog.validateWebhookAvailability).mockRejectedValueOnce(
      new Error("Datadog unavailable"),
    );

    await expect(engine.plan()).rejects.toThrow("Datadog unavailable");
  });

  it("plans PagerDuty and Opsgenie changes in one monitor update", async () => {
    const { datadog, rootly, provider } = fixture({
      monitors: [
        {
          id: 7,
          message: "@pagerduty-Production @opsgenie-Payments",
        },
      ],
      providerServices: [{ id: "pd-1", name: "Production" }],
      rootlyServices: [
        { id: "rootly-1", attributes: { pagerduty_id: "pd-1" } },
        { id: "rootly-2", attributes: { opsgenie_id: "og-1" } },
      ],
    });
    const opsgenie: ProviderAdapter = {
      id: "opsgenie",
      displayName: "Opsgenie",
      notificationPrefix: "@opsgenie-",
      rootlyAttribute: "opsgenie_id",
      tokenEnvironmentVariable: "OPSGENIE_API_TOKEN",
      listServices: vi.fn(async () =>
        Promise.resolve([{ id: "og-1", name: "Payments" }]),
      ),
    };
    const engine = new MigrationEngine(datadog, rootly, [
      { adapter: provider, token: "pd-token" },
      { adapter: opsgenie, token: "og-token" },
    ]);

    const plan = await engine.plan();

    expect(plan.providers).toEqual(["pagerduty", "opsgenie"]);
    expect(plan.scannedNotificationCount).toBe(2);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]?.newMessage).toContain(
      "@pagerduty-Production @webhook-rootly-production",
    );
    expect(plan.updates[0]?.newMessage).toContain(
      "@opsgenie-Payments @webhook-rootly-payments",
    );
  });

  it("blocks cross-provider webhook name collisions", async () => {
    const { datadog, rootly, provider } = fixture({
      monitors: [{ id: 7, message: "@pagerduty-API @opsgenie-API" }],
      providerServices: [{ id: "pd-1", name: "API" }],
      rootlyServices: [
        { id: "rootly-1", attributes: { pagerduty_id: "pd-1" } },
        { id: "rootly-2", attributes: { opsgenie_id: "og-1" } },
      ],
    });
    const opsgenie: ProviderAdapter = {
      id: "opsgenie",
      displayName: "Opsgenie",
      notificationPrefix: "@opsgenie-",
      rootlyAttribute: "opsgenie_id",
      tokenEnvironmentVariable: "OPSGENIE_API_TOKEN",
      listServices: vi.fn(async () =>
        Promise.resolve([{ id: "og-1", name: "API" }]),
      ),
    };
    const engine = new MigrationEngine(datadog, rootly, [
      { adapter: provider, token: "pd-token" },
      { adapter: opsgenie, token: "og-token" },
    ]);

    expect((await engine.plan()).issues).toContainEqual(
      expect.objectContaining({ code: "webhook-name-collision" }),
    );
  });
});

describe("MigrationEngine.execute", () => {
  it("ensures webhooks and checks for stale monitors before updating", async () => {
    const { engine, datadog } = fixture({
      monitors: [{ id: 42, message: "@pagerduty-Production" }],
      providerServices: [{ id: "pd-1", name: "Production" }],
      rootlyServices: [
        { id: "rootly-1", attributes: { pagerduty_id: "pd-1" } },
      ],
    });
    const plan = await engine.plan();
    const result = await engine.execute(plan);

    expect(result.errors).toEqual([]);
    expect(result.appliedMonitorIds).toEqual([42]);
    expect(datadog.ensureWebhook).toHaveBeenCalledBefore(
      vi.mocked(datadog.updateMonitor),
    );
  });

  it("does not update a monitor when webhook creation fails", async () => {
    const { engine, datadog } = fixture({
      monitors: [{ id: 42, message: "@pagerduty-Production" }],
      providerServices: [{ id: "pd-1", name: "Production" }],
      rootlyServices: [
        { id: "rootly-1", attributes: { pagerduty_id: "pd-1" } },
      ],
    });
    vi.mocked(datadog.ensureWebhook).mockRejectedValueOnce(new Error("failed"));
    const result = await engine.execute(await engine.plan());

    expect(result.errors).toHaveLength(2);
    expect(datadog.updateMonitor).not.toHaveBeenCalled();
  });

  it("does not overwrite a monitor changed after preview", async () => {
    const { engine, datadog } = fixture({
      monitors: [{ id: 42, message: "@pagerduty-Production" }],
      providerServices: [{ id: "pd-1", name: "Production" }],
      rootlyServices: [
        { id: "rootly-1", attributes: { pagerduty_id: "pd-1" } },
      ],
    });
    const plan = await engine.plan();
    vi.mocked(datadog.getMonitor).mockResolvedValueOnce({
      id: 42,
      message: "changed",
    });

    const result = await engine.execute(plan);

    expect(result.errors[0]?.message).toContain("changed after preview");
    expect(datadog.updateMonitor).not.toHaveBeenCalled();
  });

  it("refuses plans containing issues", async () => {
    const { engine } = fixture({
      monitors: [{ id: 1, message: "@pagerduty-Unknown" }],
      providerServices: [],
      rootlyServices: [],
    });

    await expect(engine.execute(await engine.plan())).rejects.toThrow(
      "unresolved issues",
    );
  });
});
