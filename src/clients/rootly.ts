import { z } from "zod";

import type { HttpClient } from "../http.js";
import type { RootlyService } from "../types.js";

const rootlyServiceSchema = z.looseObject({
  id: z.string(),
  attributes: z.record(z.string(), z.unknown()),
});

const rootlyServicesResponseSchema = z.object({
  data: z.array(rootlyServiceSchema),
});

export class RootlyClient {
  readonly #http: HttpClient;
  readonly #apiUrl: string;
  readonly #token: string;

  constructor(http: HttpClient, apiUrl: string, token: string) {
    this.#http = http;
    this.#apiUrl = apiUrl.replace(/\/$/, "");
    this.#token = token;
  }

  async listServices(): Promise<RootlyService[]> {
    const services: RootlyService[] = [];
    const pageSize = 100;

    for (let page = 1; ; page += 1) {
      const params = new URLSearchParams({
        "page[number]": String(page),
        "page[size]": String(pageSize),
      });
      const response = await this.#http.request(
        `${this.#apiUrl}/services?${params.toString()}`,
        { headers: { Authorization: `Bearer ${this.#token}` } },
        rootlyServicesResponseSchema,
      );
      services.push(...response.data);

      if (response.data.length < pageSize) {
        return services;
      }
    }
  }
}
