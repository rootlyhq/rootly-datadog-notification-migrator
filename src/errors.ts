export class ApiError extends Error {
  readonly status: number;
  readonly responseBody: unknown;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    status: number,
    responseBody: unknown,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.responseBody = responseBody;
    this.retryAfterMs = retryAfterMs;
  }
}

export class WebhookConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookConflictError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
