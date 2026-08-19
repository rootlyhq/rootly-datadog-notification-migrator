import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { HttpClient } from "../src/http.js";

describe("HttpClient", () => {
  it("validates JSON responses", async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(Response.json({ value: "ok" })),
    ) as unknown as typeof fetch;
    const client = new HttpClient({ fetchImplementation: fetchMock });

    await expect(
      client.request(
        "https://example.com/data",
        {},
        z.object({ value: z.string() }),
      ),
    ).resolves.toEqual({ value: "ok" });
  });

  it("retries retryable GET failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({ value: "ok" }),
      ) as unknown as typeof fetch;
    const client = new HttpClient({
      fetchImplementation: fetchMock,
      maxGetAttempts: 2,
    });

    await expect(
      client.request(
        "https://example.com/data?token=secret",
        {},
        z.object({ value: z.string() }),
      ),
    ).resolves.toEqual({ value: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry writes and omits query parameters from errors", async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(Response.json({ errors: ["bad"] }, { status: 400 })),
    ) as unknown as typeof fetch;
    const client = new HttpClient({ fetchImplementation: fetchMock });

    const request = client.request(
      "https://example.com/data?token=secret",
      { method: "POST" },
      z.unknown(),
    );
    await expect(request).rejects.toMatchObject({ status: 400 });
    await expect(request).rejects.not.toThrow("secret");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects responses that do not match the runtime schema", async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(Response.json({ value: 1 })),
    ) as unknown as typeof fetch;
    const client = new HttpClient({ fetchImplementation: fetchMock });

    await expect(
      client.request(
        "https://example.com/data",
        {},
        z.object({ value: z.string() }),
      ),
    ).rejects.toThrow("unexpected response");
  });
});
