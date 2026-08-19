import { password, select } from "@inquirer/prompts";
import { parseArgs } from "node:util";

import { errorMessage } from "./errors.js";
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
  section?(title: string, description: string): void;
  credentialLoaded?(label: string, variable: string): void;
  validationStarted?(label: string): void;
  validationSucceeded?(label: string): void;
}

export interface ConnectionValidator {
  validateDatadog(input: {
    apiUrl: string;
    apiKey: string;
    appKey: string;
  }): Promise<void>;
  validateRootly(input: { apiUrl: string; token: string }): Promise<void>;
  validateProvider(input: {
    id: ProviderId;
    apiUrl: string;
    token: string;
  }): Promise<void>;
}

const defaultPrompts: PromptAdapter = {
  async selectProvider() {
    return select<ProviderId>({
      message: "Which provider notifications should be migrated?",
      choices: [
        {
          name: "PagerDuty",
          value: "pagerduty",
          description: "Migrate @pagerduty-* notifications",
        },
        {
          name: "Opsgenie",
          value: "opsgenie",
          description: "Migrate @opsgenie-* notifications",
        },
      ],
    });
  },
  async secret(message) {
    return password({ message, mask: "*" });
  },
  section(title, description) {
    console.log(`\n${title}`);
    console.log(description);
  },
  credentialLoaded(label, variable) {
    console.log(`  ✓ ${label} loaded from ${variable}`);
  },
  validationStarted(label) {
    console.log(`  … Validating ${label}...`);
  },
  validationSucceeded(label) {
    console.log(`  ✓ ${label} verified`);
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

  if (providerValue && !isProviderSelection(providerValue)) {
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
  validator?: ConnectionValidator,
): Promise<MigrationConfig> {
  if (interactive && !options.provider) {
    prompts.section?.(
      "Step 1 — Notification providers",
      "Datadog is always scanned. Choose which existing notification targets to replace with Rootly webhooks.",
    );
  }
  const selection =
    options.provider ??
    (interactive ? await prompts.selectProvider() : missingProvider());
  const selectedProvider = providerInfo(selection);
  const datadogApiUrl = validUrl(
    environment.DATADOG_API_URL ?? "https://api.datadoghq.com/api/v1",
    "DATADOG_API_URL",
  );
  const rootlyApiUrl = validUrl(
    environment.ROOTLY_API_URL ?? "https://api.rootly.com/v1",
    "ROOTLY_API_URL",
  );

  const credentials: Record<string, string> = {};
  if (interactive) {
    prompts.section?.(
      "Step 2 of 4 — Datadog",
      "Connect to the Datadog account containing the monitors. Keys are masked and remain in memory.",
    );
  }
  const requiredCredentials = [
    ["DATADOG_API_KEY", "Datadog API key"],
    ["DATADOG_APP_KEY", "Datadog application key"],
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
  await validateCheckpoint(
    "Datadog API access",
    interactive,
    prompts,
    validator
      ? () =>
          validator.validateDatadog({
            apiUrl: datadogApiUrl,
            apiKey: credentials.DATADOG_API_KEY ?? "",
            appKey: credentials.DATADOG_APP_KEY ?? "",
          })
      : undefined,
  );

  if (interactive) {
    prompts.section?.(
      "Step 3 of 4 — Rootly",
      "Connect to Rootly and authenticate the Datadog alert-source webhooks that will be created.",
    );
  }
  const rootlyCredentials = [
    ["ROOTLY_API_TOKEN", "Rootly API token"],
    ["ROOTLY_ALERT_SOURCE_SECRET", "Rootly alert source secret"],
  ] as const;
  for (const [variable, label] of rootlyCredentials) {
    credentials[variable] = await credential(
      variable,
      label,
      environment,
      interactive,
      prompts,
    );
  }
  await validateCheckpoint(
    "Rootly API token",
    interactive,
    prompts,
    validator
      ? () =>
          validator.validateRootly({
            apiUrl: rootlyApiUrl,
            token: credentials.ROOTLY_API_TOKEN ?? "",
          })
      : undefined,
  );

  if (interactive) {
    prompts.section?.(
      `Step 4 of 4 — ${selectedProvider.label}`,
      `Connect to ${selectedProvider.label} so its services can be matched to Rootly.`,
    );
  }
  const providerToken = await credential(
    selectedProvider.tokenVariable,
    `${selectedProvider.label} API token`,
    environment,
    interactive,
    prompts,
  );
  const providerApiUrl = validUrl(
    environment[selectedProvider.apiUrlVariable] ??
      selectedProvider.defaultApiUrl,
    selectedProvider.apiUrlVariable,
  );
  await validateCheckpoint(
    `${selectedProvider.label} API token`,
    interactive,
    prompts,
    validator
      ? () =>
          validator.validateProvider({
            id: selection,
            apiUrl: providerApiUrl,
            token: providerToken,
          })
      : undefined,
  );

  return {
    datadogApiKey: credentials.DATADOG_API_KEY ?? "",
    datadogAppKey: credentials.DATADOG_APP_KEY ?? "",
    rootlyApiToken: credentials.ROOTLY_API_TOKEN ?? "",
    rootlyAlertSourceSecret: credentials.ROOTLY_ALERT_SOURCE_SECRET ?? "",
    datadogApiUrl,
    rootlyApiUrl,
    provider: {
      id: selection,
      token: providerToken,
      apiUrl: providerApiUrl,
    },
  };
}

async function validateCheckpoint(
  label: string,
  interactive: boolean,
  prompts: PromptAdapter,
  validate: (() => Promise<void>) | undefined,
): Promise<void> {
  if (!interactive || !validate) {
    return;
  }

  prompts.validationStarted?.(label);
  try {
    await validate();
  } catch (error) {
    throw new Error(`${label} validation failed: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  prompts.validationSucceeded?.(label);
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
    if (interactive) {
      prompts.credentialLoaded?.(label, variable);
    }
    return value;
  }
  if (!interactive) {
    throw new Error(`Missing required environment variable: ${variable}`);
  }

  const entered = (await prompts.secret(`${label} (${variable})`)).trim();
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

function isProviderSelection(value: string): value is ProviderId {
  return PROVIDER_IDS.some((provider) => provider === value);
}

function missingProvider(): never {
  throw new Error("Missing --from pagerduty|opsgenie in non-interactive mode");
}

function providerInfo(provider: ProviderId): {
  label: string;
  tokenVariable: string;
  apiUrlVariable: string;
  defaultApiUrl: string;
} {
  return provider === "pagerduty"
    ? {
        label: "PagerDuty",
        tokenVariable: "PAGERDUTY_API_TOKEN",
        apiUrlVariable: "PAGERDUTY_API_URL",
        defaultApiUrl: "https://api.pagerduty.com",
      }
    : {
        label: "Opsgenie",
        tokenVariable: "OPSGENIE_API_TOKEN",
        apiUrlVariable: "OPSGENIE_API_URL",
        defaultApiUrl: "https://api.opsgenie.com",
      };
}
