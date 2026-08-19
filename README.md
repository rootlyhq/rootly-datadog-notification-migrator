# Rootly Datadog Notification Migrator

[![CI](https://github.com/rootlyhq/rootly-datadog-notification-migrator/actions/workflows/ci.yml/badge.svg)](https://github.com/rootlyhq/rootly-datadog-notification-migrator/actions/workflows/ci.yml)
[![CodeQL](https://github.com/rootlyhq/rootly-datadog-notification-migrator/actions/workflows/codeql.yml/badge.svg)](https://github.com/rootlyhq/rootly-datadog-notification-migrator/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Interactively migrates Datadog monitor notifications from PagerDuty and
Opsgenie to Rootly webhooks.

The default experience is a guided wizard. It discovers service mappings,
previews every proposed change, reports conflicts, and asks for confirmation
before modifying Datadog. A non-interactive mode is available for automation.

## Safety model

- Every run builds a read-only migration plan before making changes.
- Preview is the default in non-interactive mode.
- Interactive runs require confirmation after showing the plan.
- Ambiguous or missing service mappings block the entire apply phase.
- Existing Datadog webhooks are checked for the expected Rootly target.
- A monitor changed after preview is not overwritten.
- Monitor updates are skipped when their webhook cannot be created or verified.
- Credentials entered into the wizard remain in memory and are never written to
  configuration files or reports.
- JSON and CSV reports are created with owner-only file permissions.

## Requirements

- Node.js 24 or later
- Yarn 4 through Corepack
- A Rootly Datadog alert source
- Credentials with permission to:
  - read and update Datadog monitors;
  - read and create Datadog webhook integrations;
  - read Rootly services;
  - read PagerDuty or Opsgenie services.

Each source service must be linked to its matching Rootly service through the
`pagerduty_id` or `opsgenie_id` attribute.

## Setup

```bash
git clone https://github.com/rootlyhq/rootly-datadog-notification-migrator.git
cd rootly-datadog-notification-migrator
corepack enable
corepack install
yarn install --immutable
cp .env.example .env
```

Environment variables already set in the shell are detected automatically. If
a required credential is missing, the interactive wizard prompts for it using
a masked input.

| Variable                     | Required       | Purpose                                |
| ---------------------------- | -------------- | -------------------------------------- |
| `DATADOG_API_KEY`            | Yes            | Datadog API authentication             |
| `DATADOG_APP_KEY`            | Yes            | Datadog application authentication     |
| `ROOTLY_API_TOKEN`           | Yes            | Read Rootly services                   |
| `ROOTLY_ALERT_SOURCE_SECRET` | Yes            | Authenticate incoming Datadog webhooks |
| `PAGERDUTY_API_TOKEN`        | PagerDuty only | Read PagerDuty services                |
| `OPSGENIE_API_TOKEN`         | Opsgenie only  | Read Opsgenie services                 |

`.env.example` also documents optional API URL overrides, including support for
other Datadog sites and the Opsgenie EU API.

## Interactive wizard

```bash
yarn start
```

The wizard:

1. Selects PagerDuty, Opsgenie, or both providers in one run.
2. Collects only missing credentials.
3. validates the three API connections and response shapes.
4. Discovers source notifications and Rootly service mappings.
5. Shows the number of monitors, webhooks, changes, and blocking issues.
6. Asks whether to apply the previewed changes.
7. Writes sanitized JSON and CSV reports.

Choosing not to apply is a successful preview and makes no changes.

## Automation

Preview PagerDuty migrations:

```bash
yarn start --from pagerduty --non-interactive
```

Apply Opsgenie migrations:

```bash
yarn start --from opsgenie --non-interactive --apply
```

Preview both providers in a single atomic plan:

```bash
yarn start --from all --non-interactive
```

An `all` run requires both provider tokens. It scans Datadog and Rootly once,
combines all proposed monitor changes into one preview, and blocks apply if the
providers would reuse a webhook name for different Rootly services.

Choose a report path prefix:

```bash
yarn start --from pagerduty --non-interactive --output ./reports/migration
```

The process exits with `0` for a successful preview/apply, `1` for apply or API
failures, `2` for blocking plan issues, and `130` when the wizard is cancelled.

## Service matching

Datadog mentions are matched to source services by a normalized service name.
Matching is case-insensitive; punctuation and spaces become underscores while
dashes are retained. For example, `@pagerduty-production_on-call` matches
`[Production] On-Call`.

The source service ID is then matched to the provider integration ID stored on
the Rootly service. Duplicate normalized names or duplicate Rootly links are
reported instead of selecting an arbitrary service.

The resulting Datadog notification uses `@webhook-rootly-<normalized-name>`.
Existing matching notifications are left unchanged, while other unmigrated
notifications in the same monitor are still processed.

## Reports

Every completed preview or apply writes `run-<timestamp>.json` and
`run-<timestamp>.csv`. Reports include sanitized plans, issues, changes, and
operation errors, but omit complete monitor objects, monitor messages, Rootly
IDs, configured credentials, and webhook authentication headers. Treat monitor
names and notification targets as operational data when sharing reports.

## Development

```bash
yarn format
yarn check
```

`yarn check` verifies formatting, strict ESLint rules, TypeScript, tests with
coverage thresholds, and the production build. Dependencies are quarantined
for seven days after publication through Yarn's `npmMinimalAgeGate`; Dependabot
uses the same seven-day cooldown. All GitHub Actions jobs run on ephemeral
Blacksmith Ubuntu 24.04 runners.

The project uses a shared migration engine with small provider adapters:

```text
src/
  clients/       Datadog and Rootly API boundaries
  providers/     PagerDuty and Opsgenie adapters
  cli.ts         Wizard and automation entrypoint
  config.ts      Flags, environment, and secret prompts
  engine.ts      Read-only planning and guarded execution
  report.ts      Sanitized JSON and CSV reports
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for repository conventions and
[SECURITY.md](SECURITY.md) for private vulnerability reporting.
