import { describe, expect, it, vi } from "vitest";

import {
  collectConfig,
  parseCliOptions,
  type PromptAdapter,
} from "../src/config.js";
import type { ProviderSelection } from "../src/types.js";

const baseOptions = {
  apply: false,
  nonInteractive: true,
  help: false,
  version: false,
} as const;

describe("parseCliOptions", () => {
  it("parses provider and automation options", () => {
    expect(
      parseCliOptions([
        "--from",
        "opsgenie",
        "--apply",
        "--non-interactive",
        "--output",
        "report",
      ]),
    ).toEqual({
      provider: "opsgenie",
      apply: true,
      nonInteractive: true,
      outputPrefix: "report",
      help: false,
      version: false,
    });
  });

  it("rejects unknown providers", () => {
    expect(() => parseCliOptions(["--from", "unknown"])).toThrow(
      "Unsupported provider",
    );
  });

  it("accepts all providers", () => {
    expect(parseCliOptions(["--from", "all"]).provider).toBe("all");
  });
});

describe("collectConfig", () => {
  it("loads only the selected provider credential", async () => {
    const config = await collectConfig(
      { ...baseOptions, provider: "pagerduty" },
      {
        DATADOG_API_KEY: "dd-api",
        DATADOG_APP_KEY: "dd-app",
        ROOTLY_API_TOKEN: "rootly",
        ROOTLY_ALERT_SOURCE_SECRET: "secret",
        PAGERDUTY_API_TOKEN: "pd",
      },
      false,
    );

    expect(config.providers).toEqual([
      {
        id: "pagerduty",
        token: "pd",
        apiUrl: "https://api.pagerduty.com",
      },
    ]);
  });

  it("prompts sequentially for missing credentials", async () => {
    const prompts: PromptAdapter = {
      selectProvider: vi.fn(async (): Promise<ProviderSelection> =>
        Promise.resolve("opsgenie"),
      ),
      secret: vi.fn(async (label: string) => Promise.resolve(`value:${label}`)),
    };
    const config = await collectConfig(baseOptions, {}, true, prompts);

    expect(config.providers[0]?.id).toBe("opsgenie");
    expect(prompts.secret).toHaveBeenCalledTimes(5);
    expect(config.datadogApiKey).toBe(
      "value:Datadog API key (DATADOG_API_KEY)",
    );
  });

  it("presents guided sections and identifies credentials loaded from the environment", async () => {
    const prompts: PromptAdapter = {
      selectProvider: vi.fn(async (): Promise<ProviderSelection> =>
        Promise.resolve("pagerduty"),
      ),
      secret: vi.fn(async () => Promise.resolve("unused")),
      section: vi.fn(),
      credentialLoaded: vi.fn(),
    };

    await collectConfig(
      baseOptions,
      {
        DATADOG_API_KEY: "dd-api",
        DATADOG_APP_KEY: "dd-app",
        ROOTLY_API_TOKEN: "rootly",
        ROOTLY_ALERT_SOURCE_SECRET: "secret",
        PAGERDUTY_API_TOKEN: "pd",
      },
      true,
      prompts,
    );

    expect(prompts.section).toHaveBeenNthCalledWith(
      1,
      "Step 1 — Notification providers",
      expect.stringContaining("Datadog is always scanned"),
    );
    expect(prompts.section).toHaveBeenNthCalledWith(
      2,
      "Step 2 of 4 — Datadog",
      expect.any(String),
    );
    expect(prompts.section).toHaveBeenNthCalledWith(
      3,
      "Step 3 of 4 — Rootly",
      expect.any(String),
    );
    expect(prompts.section).toHaveBeenNthCalledWith(
      4,
      "Step 4 of 4 — PagerDuty",
      expect.any(String),
    );
    expect(prompts.credentialLoaded).toHaveBeenCalledTimes(5);
    expect(prompts.secret).not.toHaveBeenCalled();
  });

  it("loads both provider credentials for an all-provider run", async () => {
    const config = await collectConfig(
      { ...baseOptions, provider: "all" },
      {
        DATADOG_API_KEY: "dd-api",
        DATADOG_APP_KEY: "dd-app",
        ROOTLY_API_TOKEN: "rootly",
        ROOTLY_ALERT_SOURCE_SECRET: "secret",
        PAGERDUTY_API_TOKEN: "pd",
        OPSGENIE_API_TOKEN: "og",
      },
      false,
    );

    expect(config.providers).toEqual([
      {
        id: "pagerduty",
        token: "pd",
        apiUrl: "https://api.pagerduty.com",
      },
      {
        id: "opsgenie",
        token: "og",
        apiUrl: "https://api.opsgenie.com",
      },
    ]);
  });

  it("fails when automation credentials are missing", async () => {
    await expect(
      collectConfig({ ...baseOptions, provider: "pagerduty" }, {}, false),
    ).rejects.toThrow("DATADOG_API_KEY");
  });

  it("requires a provider when prompts are disabled", async () => {
    await expect(collectConfig(baseOptions, {}, false)).rejects.toThrow(
      "Missing --from",
    );
  });

  it("validates endpoint overrides", async () => {
    await expect(
      collectConfig(
        { ...baseOptions, provider: "pagerduty" },
        {
          DATADOG_API_KEY: "x",
          DATADOG_APP_KEY: "x",
          ROOTLY_API_TOKEN: "x",
          ROOTLY_ALERT_SOURCE_SECRET: "x",
          PAGERDUTY_API_TOKEN: "x",
          DATADOG_API_URL: "not a URL",
        },
        false,
      ),
    ).rejects.toThrow("DATADOG_API_URL");
  });
});
