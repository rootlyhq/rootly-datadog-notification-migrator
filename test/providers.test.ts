import { describe, expect, it, vi } from "vitest";

import { HttpClient } from "../src/http.js";
import { createOpsgenieProvider } from "../src/providers/opsgenie.js";
import { createPagerDutyProvider } from "../src/providers/pagerduty.js";

describe("provider adapters", () => {
  it("validates PagerDuty credentials with a one-service request", async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(Response.json({ services: [], more: false })),
    ) as unknown as typeof fetch;
    const provider = createPagerDutyProvider(
      new HttpClient({ fetchImplementation: fetchMock }),
      "https://api.pagerduty.com",
    );

    await provider.validateCredentials("token");

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("limit=1&offset=0"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Token token=token",
        }),
      }),
    );
  });

  it("follows PagerDuty's more flag", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ services: [{ id: "1", name: "One" }], more: true }),
      )
      .mockResolvedValueOnce(
        Response.json({ services: [{ id: "2", name: "Two" }], more: false }),
      ) as unknown as typeof fetch;
    const provider = createPagerDutyProvider(
      new HttpClient({ fetchImplementation: fetchMock }),
      "https://api.pagerduty.com/",
    );

    await expect(provider.listServices("token")).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("offset=100"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Token token=token",
        }),
      }),
    );
  });

  it("follows Opsgenie's next-page link signal", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: "1", name: "One" }],
          paging: { next: "next" },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ data: [] }),
      ) as unknown as typeof fetch;
    const provider = createOpsgenieProvider(
      new HttpClient({ fetchImplementation: fetchMock }),
      "https://api.opsgenie.com/",
    );

    await expect(provider.listServices("token")).resolves.toEqual([
      { id: "1", name: "One" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("validates Opsgenie credentials with a one-service request", async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(Response.json({ data: [] })),
    ) as unknown as typeof fetch;
    const provider = createOpsgenieProvider(
      new HttpClient({ fetchImplementation: fetchMock }),
      "https://api.opsgenie.com",
    );

    await provider.validateCredentials("token");

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("limit=1&offset=0"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "GenieKey token" }),
      }),
    );
  });
});
