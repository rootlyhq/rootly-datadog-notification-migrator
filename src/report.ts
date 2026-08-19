import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExecutionResult, MigrationPlan } from "./types.js";

export interface ReportPaths {
  json: string;
  csv: string;
}

export async function writeReports(
  plan: MigrationPlan,
  execution?: ExecutionResult,
  outputPrefix?: string,
): Promise<ReportPaths> {
  const prefix = outputPrefix ?? `run-${Date.now()}`;
  const jsonPath = path.resolve(`${prefix}.json`);
  const csvPath = path.resolve(`${prefix}.csv`);
  const report = {
    generatedAt: new Date().toISOString(),
    mode: execution ? "apply" : "preview",
    plan: sanitizedPlan(plan),
    ...(execution ? { execution } : {}),
  };

  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    }),
    writeFile(csvPath, planCsv(plan, execution), { mode: 0o600 }),
  ]);
  await Promise.all([chmod(jsonPath, 0o600), chmod(csvPath, 0o600)]);

  return { json: jsonPath, csv: csvPath };
}

function sanitizedPlan(plan: MigrationPlan): object {
  return {
    providers: plan.providers,
    monitorCount: plan.monitorCount,
    scannedNotificationCount: plan.scannedNotificationCount,
    webhooks: plan.webhooks.map(({ name, serviceName }) => ({
      name,
      serviceName,
    })),
    updates: plan.updates.map((update) => ({
      monitorId: update.monitor.id,
      monitorName: update.monitor.name,
      notifications: update.notifications,
      webhookNames: update.webhookNames,
    })),
    issues: plan.issues,
  };
}

export function planCsv(
  plan: MigrationPlan,
  execution?: ExecutionResult,
): string {
  const headers = [
    "Type",
    "Monitor ID",
    "Monitor Name",
    "Notification",
    "Webhook",
    "Status",
    "Message",
  ];
  const appliedIds = new Set(execution?.appliedMonitorIds ?? []);
  const rows: string[][] = [headers];

  for (const update of plan.updates) {
    rows.push([
      "monitor",
      String(update.monitor.id),
      update.monitor.name ?? "",
      update.notifications.join(" "),
      update.webhookNames.join(" "),
      execution
        ? appliedIds.has(update.monitor.id)
          ? "applied"
          : "not-applied"
        : "planned",
      "",
    ]);
  }

  for (const issue of plan.issues) {
    rows.push([
      "issue",
      issue.monitorId ? String(issue.monitorId) : "",
      "",
      issue.notification ?? "",
      "",
      issue.code,
      issue.message,
    ]);
  }

  for (const error of execution?.errors ?? []) {
    rows.push([
      "error",
      error.operation.startsWith("monitor:")
        ? error.operation.slice("monitor:".length)
        : "",
      "",
      "",
      error.operation.startsWith("webhook:")
        ? error.operation.slice("webhook:".length)
        : "",
      "failed",
      error.message,
    ]);
  }

  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
