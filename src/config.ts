import { password, select } from "@inquirer/prompts";
import { parseArgs } from "node:util";

import { PROVIDER_IDS } from "./types.js";
import type { MigrationConfig, ProviderId } from "./types.js";

export interface CliOptions {
  provider?: ProviderId;
  apply: boolean;
  nonInteractive: boolean;
  outputPrefix?: string;
  help: boolean;
  version: boolean;
}

export interface PromptAdapter {
  selectProvider(): Promise<ProviderId>;
  secret(message: string): Promise<string>;
}

const defaultPrompts: PromptAdapter = {
  async selectProvider() {
    return select<ProviderId>({
      message: "Which notification provider are you migrating from?",
      choices: [
        { name: "PagerDuty", value: "pagerduty" },
        { name: "Opsgenie", value: "opsgenie" },
      ],
    });
  },
  async secret(message) {
    return password({ message, mask: "*" });
  },
};

export function parseCliOptions(argv: string[]): CliOptions {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: {
      from: { type: "string", short: "f" },
      apply: { type: "boolean", default: false },
      "non-interactive": { type: "boolean", default: false },
      output: { type: "string", short: "o" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  const providerValue = parsed.values.from;

  if (providerValue && !isProviderId(providerValue)) {
    throw new Error(`Unsupported provider: ${providerValue}`);
  }
  const provider = providerValue as ProviderId | undefined;

  return {
    ...(provider ? { provider } : {}),
    apply: parsed.values.apply,
    nonInteractive: parsed.values["non-interactive"],
    ...(parsed.values.output ? { outputPrefix: parsed.values.output } : {}),
    help: parsed.values.help,
    version: parsed.values.version,
  };
}

export async function collectConfig(
  options: CliOptions,
  environment: NodeJS.ProcessEnv = process.env,
  interactive = !options.nonInteractive &&
    process.stdin.isTTY &&
    process.stdout.isTTY,
  prompts: PromptAdapter = defaultPrompts,
): Promise<MigrationConfig> {
  const provider =
    options.provider ??
    (interactive ? await prompts.selectProvider() : missingProvider());
  const providerTokenVariable =
    provider === "pagerduty" ? "PAGERDUTY_API_TOKEN" : "OPSGENIE_API_TOKEN";

  const credentials: Record<string, string> = {};
  const requiredCredentials = [
    ["DATADOG_API_KEY", "Datadog API key"],
    ["DATADOG_APP_KEY", "Datadog application key"],
    ["ROOTLY_API_TOKEN", "Rootly API token"],
    ["ROOTLY_ALERT_SOURCE_SECRET", "Rootly alert source secret"],
    [providerTokenVariable, `${providerLabel(provider)} API token`],
  ] as const;
  for (const [variable, label] of requiredCredentials) {
    credentials[variable] = await credential(
      variable,
      label,
      environment,
      interactive,
      prompts,
    );
  }

  return {
    provider,
    datadogApiKey: credentials.DATADOG_API_KEY ?? "",
    datadogAppKey: credentials.DATADOG_APP_KEY ?? "",
    rootlyApiToken: credentials.ROOTLY_API_TOKEN ?? "",
    rootlyAlertSourceSecret: credentials.ROOTLY_ALERT_SOURCE_SECRET ?? "",
    providerToken: credentials[providerTokenVariable] ?? "",
    datadogApiUrl: validUrl(
      environment.DATADOG_API_URL ?? "https://api.datadoghq.com/api/v1",
      "DATADOG_API_URL",
    ),
    rootlyApiUrl: validUrl(
      environment.ROOTLY_API_URL ?? "https://api.rootly.com/v1",
      "ROOTLY_API_URL",
    ),
    providerApiUrl: validUrl(
      provider === "pagerduty"
        ? (environment.PAGERDUTY_API_URL ?? "https://api.pagerduty.com")
        : (environment.OPSGENIE_API_URL ?? "https://api.opsgenie.com"),
      provider === "pagerduty" ? "PAGERDUTY_API_URL" : "OPSGENIE_API_URL",
    ),
  };
}

async function credential(
  variable: string,
  label: string,
  environment: NodeJS.ProcessEnv,
  interactive: boolean,
  prompts: PromptAdapter,
): Promise<string> {
  const value = environment[variable]?.trim();
  if (value) {
    return value;
  }
  if (!interactive) {
    throw new Error(`Missing required environment variable: ${variable}`);
  }

  const entered = (await prompts.secret(label)).trim();
  if (!entered) {
    throw new Error(`${label} cannot be empty`);
  }
  return entered;
}

function validUrl(value: string, variable: string): string {
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${variable} must be a valid URL`);
  }
}

function isProviderId(value: string): value is ProviderId {
  return PROVIDER_IDS.some((provider) => provider === value);
}

function missingProvider(): never {
  throw new Error("Missing --from pagerduty|opsgenie in non-interactive mode");
}

function providerLabel(provider: ProviderId): string {
  return provider === "pagerduty" ? "PagerDuty" : "Opsgenie";
}
