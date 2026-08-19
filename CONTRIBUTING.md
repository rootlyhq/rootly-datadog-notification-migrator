# Contributing

## Development setup

Use Node.js 24 and the repository-pinned Yarn release:

```bash
corepack enable
corepack install
yarn install --immutable
yarn check
```

## Pull requests

Keep provider-specific behavior behind the `ProviderAdapter` contract. Shared
Datadog, Rootly, planning, execution, and reporting behavior belongs in the
common engine. Add runtime schemas for external data and tests for every new
mutation path.

Never commit `.env` files, API responses from a real account, generated run
reports, or fixtures containing customer identifiers. Use synthetic fixtures.

Behavior-changing pull requests should describe the preview output, apply
behavior, failure mode, and idempotency story.
