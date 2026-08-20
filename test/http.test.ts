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

  it("waits for Datadog's rate-limit reset before retrying", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { errors: ["rate limited"] },
          { status: 429, headers: { "X-RateLimit-Reset": "7" } },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ value: "ok" }),
      ) as unknown as typeof fetch;
    const sleep = vi.fn(async () => Promise.resolve());
    const client = new HttpClient({
      fetchImplementation: fetchMock,
      maxGetAttempts: 2,
      sleep,
    });

    await expect(
      client.request(
        "https://api.datadoghq.com/api/v1/monitor",
        {},
        z.object({ value: z.string() }),
      ),
    ).resolves.toEqual({ value: "ok" });
    expect(sleep).toHaveBeenCalledWith(7_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed after exhausting retries", async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(Response.json({}, { status: 503 })),
    ) as unknown as typeof fetch;
    const sleep = vi.fn(async () => Promise.resolve());
    const client = new HttpClient({
      fetchImplementation: fetchMock,
      maxGetAttempts: 3,
      sleep,
    });

    await expect(
      client.request("https://example.com/data", {}, z.unknown()),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("uses exponential backoff when a 429 omits reset headers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}, { status: 429 }))
      .mockResolvedValueOnce(
        Response.json({ value: "ok" }),
      ) as unknown as typeof fetch;
    const sleep = vi.fn(async () => Promise.resolve());
    const client = new HttpClient({
      fetchImplementation: fetchMock,
      maxGetAttempts: 2,
      sleep,
    });

    await client.request(
      "https://example.com/data",
      {},
      z.object({ value: z.string() }),
    );
    expect(sleep).toHaveBeenCalledWith(250);
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
