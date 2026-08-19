# Repository Guide

This is a strict TypeScript CLI that migrates live Datadog monitor
notifications. Preserve these boundaries:

- `src/providers/` owns provider authentication, pagination, and service shapes.
- `src/clients/` owns Rootly and Datadog API behavior.
- `src/engine.ts` owns pure planning and guarded execution.
- `src/config.ts` owns flags, environment variables, and interactive prompts.
- `src/report.ts` must never serialize credentials.

All external API responses require Zod validation. Planning must remain
read-only. Applying must verify webhook targets and reject stale monitor
snapshots. Never log tokens, custom webhook headers, or full API error bodies.

Run `yarn check` before committing. Add tests for successful, partial-failure,
collision, idempotency, and dry-run behavior when changing migration logic.
