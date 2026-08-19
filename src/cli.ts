#!/usr/bin/env node

import { confirm } from "@inquirer/prompts";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import { DatadogClient } from "./clients/datadog.js";
import { RootlyClient } from "./clients/rootly.js";
import { collectConfig, parseCliOptions } from "./config.js";
import { MigrationEngine } from "./engine.js";
import { isMainModule } from "./entrypoint.js";
import { errorMessage } from "./errors.js";
import { HttpClient } from "./http.js";
import { createProvider } from "./providers/index.js";
import { writeReports } from "./report.js";
import type { ExecutionResult, MigrationPlan } from "./types.js";

const VERSION = "0.1.0";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const options = parseCliOptions(argv);
  if (options.help) {
    console.log(helpText());
    return 0;
  }
  if (options.version) {
    console.log(VERSION);
    return 0;
  }

  if (existsSync(".env")) {
    loadEnvFile(".env");
  }

  const interactive =
    !options.nonInteractive && process.stdin.isTTY && process.stdout.isTTY;
  if (interactive) {
    console.log("\nRootly Datadog Notification Migrator\n");
    console.log(
      "Credentials entered here remain in memory and are not saved.\n",
    );
  }

  const http = new HttpClient();
  const config = await collectConfig(
    options,
    process.env,
    interactive,
    undefined,
    {
      async validateDatadog({ apiUrl, apiKey, appKey }) {
        await new DatadogClient(
          http,
          apiUrl,
          apiKey,
          appKey,
          "unused-during-validation",
        ).validateConnection();
      },
      async validateRootly({ apiUrl, token }) {
        await new RootlyClient(http, apiUrl, token).validateConnection();
      },
      async validateProvider({ id, apiUrl, token }) {
        await createProvider(id, http, apiUrl).validateCredentials(token);
      },
    },
  );
  const datadog = new DatadogClient(
    http,
    config.datadogApiUrl,
    config.datadogApiKey,
    config.datadogAppKey,
    config.rootlyAlertSourceSecret,
  );
  const rootly = new RootlyClient(
    http,
    config.rootlyApiUrl,
    config.rootlyApiToken,
  );
  const providers = config.providers.map(({ id, token, apiUrl }) => ({
    adapter: createProvider(id, http, apiUrl),
    token,
  }));
  const engine = new MigrationEngine(datadog, rootly, providers);

  console.log(
    `Inspecting Datadog, Rootly, and ${providers.map(({ adapter }) => adapter.displayName).join(" and ")}...`,
  );
  const plan = await engine.plan();
  printPlan(plan);

  if (plan.issues.length > 0) {
    const paths = await writeReports(plan, undefined, options.outputPrefix);
    console.error(
      `\nApply blocked: resolve all reported issues and rerun.\nReports: ${paths.csv} and ${paths.json}`,
    );
    return 2;
  }

  if (plan.updates.length === 0) {
    const paths = await writeReports(plan, undefined, options.outputPrefix);
    console.log(`\nNothing to change. Reports: ${paths.csv} and ${paths.json}`);
    return 0;
  }

  const apply =
    options.apply ||
    (interactive &&
      (await confirm({
        message: `Apply ${plan.updates.length} monitor update(s)?`,
        default: false,
      })));

  if (!apply) {
    const paths = await writeReports(plan, undefined, options.outputPrefix);
    console.log(
      `\nPreview complete; no changes were made.\nReports: ${paths.csv} and ${paths.json}`,
    );
    return 0;
  }

  console.log("\nApplying migration...");
  const execution = await engine.execute(plan);
  printExecution(execution);
  const paths = await writeReports(plan, execution, options.outputPrefix);
  console.log(`Reports: ${paths.csv} and ${paths.json}`);
  return execution.errors.length === 0 ? 0 : 1;
}

function printPlan(plan: MigrationPlan): void {
  console.log("\nMigration preview");
  console.log(`  Monitors scanned:       ${plan.monitorCount}`);
  console.log(`  Notifications found:    ${plan.scannedNotificationCount}`);
  console.log(`  Webhooks to ensure:     ${plan.webhooks.length}`);
  console.log(`  Monitors to update:     ${plan.updates.length}`);
  console.log(`  Blocking issues:        ${plan.issues.length}`);

  for (const issue of plan.issues) {
    const monitor = issue.monitorId ? ` monitor ${issue.monitorId}:` : ":";
    console.error(`  -${monitor} ${issue.message}`);
  }
}

function printExecution(execution: ExecutionResult): void {
  console.log(
    `  Webhooks ready:         ${execution.createdOrVerifiedWebhooks.length}`,
  );
  console.log(
    `  Monitors updated:       ${execution.appliedMonitorIds.length}`,
  );
  console.log(`  Errors:                 ${execution.errors.length}`);
  for (const error of execution.errors) {
    console.error(`  - ${error.operation}: ${error.message}`);
  }
}

function helpText(): string {
  return `Rootly Datadog Notification Migrator ${VERSION}

Usage:
  rootly-datadog-notification-migrator
  rootly-datadog-notification-migrator --from <provider> [options]

Options:
  -f, --from <provider>    pagerduty or opsgenie
      --apply              Apply the previewed changes
      --non-interactive    Disable prompts; credentials come from the environment
  -o, --output <prefix>    Report path prefix (default: run-<timestamp>)
  -h, --help               Show this help
  -v, --version            Show the version

Without --apply, non-interactive runs are previews. Interactive runs always show
a preview and ask for confirmation before making changes.`;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      if (error instanceof Error && error.name === "ExitPromptError") {
        console.error("\nCancelled; no changes were made.");
        process.exitCode = 130;
        return;
      }
      console.error(`Error: ${errorMessage(error)}`);
      process.exitCode = 1;
    },
  );
}
