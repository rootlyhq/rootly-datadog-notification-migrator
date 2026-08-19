import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import packageJson from "../package.json" with { type: "json" };
import { main, shouldApply } from "../src/cli.js";
import { isMainModule } from "../src/entrypoint.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("CLI entrypoint", () => {
  it("recognizes an npm-style executable symlink", async () => {
    const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const directory = await mkdtemp(path.join(tmpdir(), "rootly-cli-"));
    const executablePath = path.join(directory, "rootly-migrator");
    await symlink(cliPath, executablePath);

    expect(
      isMainModule(
        new URL("../src/cli.ts", import.meta.url).href,
        executablePath,
      ),
    ).toBe(true);
  });

  it("rejects a missing executable path", () => {
    expect(isMainModule(import.meta.url, undefined)).toBe(false);
    expect(isMainModule(import.meta.url, "/does/not/exist")).toBe(false);
  });

  it("reads the displayed version from package metadata", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(main(["--version"])).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith(packageJson.version);
  });

  it("prints help without loading configuration", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(main(["--help"])).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
  });

  it("runs a complete non-interactive preview", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rootly-preview-"));
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.startsWith("https://datadog.test/monitor?")) {
        return Promise.resolve(jsonResponse([]));
      }
      if (url.startsWith("https://rootly.test/services?")) {
        return Promise.resolve(jsonResponse({ data: [] }));
      }
      if (url.startsWith("https://pagerduty.test/services?")) {
        return Promise.resolve(jsonResponse({ services: [], more: false }));
      }
      return Promise.resolve(
        jsonResponse({ error: "unexpected test request" }, 404),
      );
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("DATADOG_API_KEY", "dd-api");
    vi.stubEnv("DATADOG_APP_KEY", "dd-app");
    vi.stubEnv("DATADOG_API_URL", "https://datadog.test");
    vi.stubEnv("ROOTLY_API_TOKEN", "rootly-token");
    vi.stubEnv("ROOTLY_ALERT_SOURCE_SECRET", "rootly-secret");
    vi.stubEnv("ROOTLY_API_URL", "https://rootly.test");
    vi.stubEnv("PAGERDUTY_API_TOKEN", "pd-token");
    vi.stubEnv("PAGERDUTY_API_URL", "https://pagerduty.test");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      main([
        "--from",
        "pagerduty",
        "--non-interactive",
        "--output",
        path.join(directory, "preview"),
      ]),
    ).resolves.toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("always confirms an interactive apply", async () => {
    const confirmApply = vi.fn(async () => Promise.resolve(false));

    await expect(shouldApply(true, true, confirmApply)).resolves.toBe(false);
    expect(confirmApply).toHaveBeenCalledOnce();
  });

  it("uses the apply flag directly in non-interactive mode", async () => {
    const confirmApply = vi.fn(async () => Promise.resolve(false));

    await expect(shouldApply(true, false, confirmApply)).resolves.toBe(true);
    expect(confirmApply).not.toHaveBeenCalled();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
