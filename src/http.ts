import type { ZodType } from "zod";

import { ApiError, errorMessage } from "./errors.js";

export type FetchImplementation = typeof fetch;

export interface HttpClientOptions {
  fetchImplementation?: FetchImplementation;
  timeoutMs?: number;
  maxGetAttempts?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_SERVER_RETRY_DELAY_MS = 5 * 60 * 1000;

export class HttpClient {
  readonly #fetch: FetchImplementation;
  readonly #timeoutMs: number;
  readonly #maxGetAttempts: number;
  readonly #sleep: (delayMs: number) => Promise<void>;

  constructor(options: HttpClientOptions = {}) {
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxGetAttempts = options.maxGetAttempts ?? 3;
    this.#sleep = options.sleep ?? sleep;
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

        const exponentialDelayMs = 250 * 2 ** (attempt - 1);
        await this.#sleep(
          error instanceof ApiError && error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : exponentialDelayMs,
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
          retryDelayFrom(response),
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

function retryDelayFrom(response: Response): number | undefined {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const delayMs = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(delayMs) && delayMs >= 0) {
      return Math.min(delayMs, MAX_SERVER_RETRY_DELAY_MS);
    }
  }

  if (response.status !== 429) {
    return undefined;
  }

  const reset = response.headers.get("x-ratelimit-reset");
  if (reset === null) {
    return undefined;
  }

  const resetSeconds = Number(reset);
  if (Number.isFinite(resetSeconds) && resetSeconds >= 0) {
    return Math.min(resetSeconds * 1000, MAX_SERVER_RETRY_DELAY_MS);
  }
  return undefined;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
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
