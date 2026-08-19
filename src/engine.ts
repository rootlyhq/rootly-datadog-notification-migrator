import { errorMessage, WebhookConflictError } from "./errors.js";
import { escapeRegExp, normalizeServiceName } from "./normalization.js";
import type {
  ExecutionResult,
  DatadogMonitor,
  MigrationIssue,
  MigrationPlan,
  PlannedMonitorUpdate,
  PlannedWebhook,
  ProviderAdapter,
  ProviderService,
  RootlyService,
} from "./types.js";

export interface DatadogOperations {
  listMonitors(): Promise<DatadogMonitor[]>;
  validateWebhookAvailability(webhook: PlannedWebhook): Promise<void>;
  ensureWebhook(webhook: PlannedWebhook): Promise<void>;
  getMonitor(id: number): Promise<DatadogMonitor>;
  updateMonitor(monitor: DatadogMonitor, message: string): Promise<void>;
}

export interface RootlyOperations {
  listServices(): Promise<RootlyService[]>;
}

export class MigrationEngine {
  readonly #datadog: DatadogOperations;
  readonly #rootly: RootlyOperations;
  readonly #provider: ProviderAdapter;
  readonly #providerToken: string;

  constructor(
    datadog: DatadogOperations,
    rootly: RootlyOperations,
    provider: ProviderAdapter,
    providerToken: string,
  ) {
    this.#datadog = datadog;
    this.#rootly = rootly;
    this.#provider = provider;
    this.#providerToken = providerToken;
  }

  async plan(): Promise<MigrationPlan> {
    const [monitors, providerServices, rootlyServices] = await Promise.all([
      this.#datadog.listMonitors(),
      this.#provider.listServices(this.#providerToken),
      this.#rootly.listServices(),
    ]);
    const providerIndex = indexProviderServices(providerServices);
    const rootlyIndex = indexRootlyServices(
      rootlyServices,
      this.#provider.rootlyAttribute,
    );
    const notificationPattern = new RegExp(
      `${escapeRegExp(this.#provider.notificationPrefix)}([^\\s]+)`,
      "g",
    );
    const webhooks = new Map<string, PlannedWebhook>();
    const updates: PlannedMonitorUpdate[] = [];
    const issues: MigrationIssue[] = [];
    let scannedNotificationCount = 0;

    for (const monitor of monitors) {
      const notifications = [
        ...new Set(monitor.message.match(notificationPattern) ?? []),
      ];
      scannedNotificationCount += notifications.length;
      let newMessage = monitor.message;
      const resolvedNotifications: string[] = [];
      const webhookNames: string[] = [];

      for (const notification of notifications) {
        const serviceName = notification.slice(
          this.#provider.notificationPrefix.length,
        );
        const normalizedName = normalizeServiceName(serviceName);
        const providerMatches = providerIndex.get(normalizedName) ?? [];

        if (providerMatches.length === 0) {
          issues.push({
            code: "missing-provider-service",
            message: `${this.#provider.displayName} service not found for ${notification}`,
            monitorId: monitor.id,
            notification,
          });
          continue;
        }
        if (providerMatches.length > 1) {
          issues.push({
            code: "ambiguous-provider-service",
            message: `${notification} matches multiple ${this.#provider.displayName} services`,
            monitorId: monitor.id,
            notification,
          });
          continue;
        }

        const providerService = providerMatches[0];
        if (!providerService) {
          continue;
        }
        const rootlyMatches = rootlyIndex.get(providerService.id) ?? [];

        if (rootlyMatches.length === 0) {
          issues.push({
            code: "missing-rootly-service",
            message: `No Rootly service is linked to ${this.#provider.displayName} service ${providerService.name}`,
            monitorId: monitor.id,
            notification,
          });
          continue;
        }
        if (rootlyMatches.length > 1) {
          issues.push({
            code: "ambiguous-rootly-service",
            message: `Multiple Rootly services are linked to ${this.#provider.displayName} service ${providerService.name}`,
            monitorId: monitor.id,
            notification,
          });
          continue;
        }

        const rootlyService = rootlyMatches[0];
        if (!rootlyService) {
          continue;
        }
        const webhookName = `rootly-${normalizedName}`;
        const newNotification = `@webhook-${webhookName}`;

        if (monitor.message.includes(newNotification)) {
          continue;
        }

        const existingPlan = webhooks.get(webhookName);
        if (existingPlan && existingPlan.rootlyServiceId !== rootlyService.id) {
          issues.push({
            code: "webhook-name-collision",
            message: `Webhook ${webhookName} resolves to multiple Rootly services`,
            monitorId: monitor.id,
            notification,
          });
          continue;
        }

        webhooks.set(webhookName, {
          name: webhookName,
          serviceName: providerService.name,
          rootlyServiceId: rootlyService.id,
        });
        newMessage = newMessage.replaceAll(
          notification,
          `${notification} ${newNotification}`,
        );
        resolvedNotifications.push(notification);
        webhookNames.push(webhookName);
      }

      if (newMessage !== monitor.message) {
        updates.push({
          monitor,
          oldMessage: monitor.message,
          newMessage,
          notifications: resolvedNotifications,
          webhookNames: [...new Set(webhookNames)],
        });
      }
    }

    for (const webhook of webhooks.values()) {
      try {
        await this.#datadog.validateWebhookAvailability(webhook);
      } catch (error) {
        if (!(error instanceof WebhookConflictError)) {
          throw error;
        }
        issues.push({
          code: "webhook-name-collision",
          message: error.message,
        });
      }
    }

    return {
      provider: this.#provider.id,
      monitorCount: monitors.length,
      scannedNotificationCount,
      webhooks: [...webhooks.values()],
      updates,
      issues,
    };
  }

  async execute(plan: MigrationPlan): Promise<ExecutionResult> {
    if (plan.issues.length > 0) {
      throw new Error(
        "Refusing to apply a migration plan with unresolved issues",
      );
    }

    const result: ExecutionResult = {
      appliedMonitorIds: [],
      createdOrVerifiedWebhooks: [],
      errors: [],
    };
    const readyWebhooks = new Set<string>();

    for (const webhook of plan.webhooks) {
      try {
        await this.#datadog.ensureWebhook(webhook);
        readyWebhooks.add(webhook.name);
        result.createdOrVerifiedWebhooks.push(webhook.name);
      } catch (error) {
        result.errors.push({
          operation: `webhook:${webhook.name}`,
          message: errorMessage(error),
        });
      }
    }

    for (const update of plan.updates) {
      const missingWebhook = update.webhookNames.find(
        (name) => !readyWebhooks.has(name),
      );
      if (missingWebhook) {
        result.errors.push({
          operation: `monitor:${update.monitor.id}`,
          message: `Skipped because webhook ${missingWebhook} is not ready`,
        });
        continue;
      }

      try {
        const currentMonitor = await this.#datadog.getMonitor(
          update.monitor.id,
        );
        if (currentMonitor.message !== update.oldMessage) {
          throw new Error("Monitor changed after preview; rerun the migration");
        }
        await this.#datadog.updateMonitor(currentMonitor, update.newMessage);
        result.appliedMonitorIds.push(update.monitor.id);
      } catch (error) {
        result.errors.push({
          operation: `monitor:${update.monitor.id}`,
          message: errorMessage(error),
        });
      }
    }

    return result;
  }
}

function indexProviderServices(
  services: ProviderService[],
): Map<string, ProviderService[]> {
  const index = new Map<string, ProviderService[]>();
  for (const service of services) {
    const key = normalizeServiceName(service.name);
    index.set(key, [...(index.get(key) ?? []), service]);
  }
  return index;
}

function indexRootlyServices(
  services: RootlyService[],
  attribute: string,
): Map<string, RootlyService[]> {
  const index = new Map<string, RootlyService[]>();
  for (const service of services) {
    const externalId = service.attributes[attribute];
    if (typeof externalId !== "string" || externalId.length === 0) {
      continue;
    }
    index.set(externalId, [...(index.get(externalId) ?? []), service]);
  }
  return index;
}
