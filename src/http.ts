import type { ZodType } from "zod";

import { ApiError, errorMessage } from "./errors.js";

export type FetchImplementation = typeof fetch;

export interface HttpClientOptions {
  fetchImplementation?: FetchImplementation;
  timeoutMs?: number;
  maxGetAttempts?: number;
}

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export class HttpClient {
  readonly #fetch: FetchImplementation;
  readonly #timeoutMs: number;
  readonly #maxGetAttempts: number;

  constructor(options: HttpClientOptions = {}) {
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxGetAttempts = options.maxGetAttempts ?? 3;
  }

  async request<T>(
    url: string,
    options: RequestInit,
    schema: ZodType<T>,
  ): Promise<T> {
    const method = options.method?.toUpperCase() ?? "GET";
    const attempts = method === "GET" ? this.#maxGetAttempts : 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.#requestOnce(url, options, schema);
      } catch (error) {
        const retryable =
          error instanceof ApiError
            ? RETRYABLE_STATUSES.has(error.status)
            : error instanceof TypeError ||
              errorMessage(error).includes("timed out");

        if (!retryable || attempt === attempts) {
          throw error;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, 250 * 2 ** (attempt - 1)),
        );
      }
    }

    throw new Error("HTTP retry loop ended unexpectedly");
  }

  async #requestOnce<T>(
    url: string,
    options: RequestInit,
    schema: ZodType<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error(`Request timed out after ${this.#timeoutMs}ms`),
        ),
      this.#timeoutMs,
    );

    try {
      const response = await this.#fetch(url, {
        ...options,
        signal: controller.signal,
      });
      const body = await parseResponseBody(response);

      if (!response.ok) {
        throw new ApiError(
          `${options.method ?? "GET"} ${safeUrl(url)} failed with HTTP ${response.status}`,
          response.status,
          body,
        );
      }

      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        throw new Error(
          `${options.method ?? "GET"} ${safeUrl(url)} returned an unexpected response: ${parsed.error.message}`,
        );
      }

      return parsed.data;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function parseResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  if (text.length === 0) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function safeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.search = "";
  return parsed.toString();
}
