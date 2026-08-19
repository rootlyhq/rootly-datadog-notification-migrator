import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { planCsv, writeReports } from "../src/report.js";
import type { MigrationPlan } from "../src/types.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const plan: MigrationPlan = {
  provider: "pagerduty",
  monitorCount: 1,
  scannedNotificationCount: 1,
  webhooks: [
    {
      name: "rootly-service",
      serviceName: "Service",
      rootlyServiceId: "rootly-1",
    },
  ],
  updates: [
    {
      monitor: { id: 1, name: 'A "monitor"', message: "old" },
      oldMessage: "old",
      newMessage: "new",
      notifications: ["@pagerduty-service"],
      webhookNames: ["rootly-service"],
    },
  ],
  issues: [],
};

describe("reporting", () => {
  it("produces escaped CSV rows", () => {
    expect(planCsv(plan)).toContain('"A ""monitor"""');
    expect(planCsv(plan)).toContain('"planned"');
  });

  it("records execution outcomes", () => {
    const csv = planCsv(plan, {
      appliedMonitorIds: [1],
      createdOrVerifiedWebhooks: ["rootly-service"],
      errors: [
        { operation: "webhook:failed", message: "nope" },
        { operation: "monitor:2", message: "stale" },
      ],
    });
    expect(csv).toContain('"applied"');
    expect(csv).toContain('"failed"');
    expect(csv).toContain('"2"');
  });

  it("writes private JSON and CSV reports", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rootly-migrator-"));
    tempDirectories.push(directory);
    const paths = await writeReports(
      plan,
      undefined,
      path.join(directory, "run"),
    );

    await expect(readFile(paths.json, "utf8")).resolves.toContain(
      '"mode": "preview"',
    );
    await expect(readFile(paths.csv, "utf8")).resolves.toContain(
      '"Monitor ID"',
    );
    expect((await stat(paths.json)).mode & 0o777).toBe(0o600);
    expect(await readFile(paths.json, "utf8")).not.toContain("rootly-1");
    expect(await readFile(paths.json, "utf8")).not.toContain('"oldMessage"');
  });
});
