export const PROVIDER_IDS = ["pagerduty", "opsgenie"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];
export type ProviderSelection = ProviderId;

export interface ProviderService {
  id: string;
  name: string;
}

export interface RootlyService {
  id: string;
  attributes: Record<string, unknown>;
}

export interface DatadogMonitor {
  id: number;
  name?: string | undefined;
  message: string;
  type?: string | undefined;
  options?: Record<string, unknown> | undefined;
  [key: string]: unknown;
}

export interface WebhookConfiguration {
  name: string;
  url: string;
  payload?: string | null | undefined;
  custom_headers?: string | null | undefined;
  encode_as?: string | undefined;
}

export interface ProviderAdapter {
  id: ProviderId;
  displayName: string;
  notificationPrefix: string;
  rootlyAttribute: string;
  tokenEnvironmentVariable: string;
  validateCredentials(token: string): Promise<void>;
  listServices(token: string): Promise<ProviderService[]>;
}

export interface MigrationConfig {
  datadogApiKey: string;
  datadogAppKey: string;
  rootlyApiToken: string;
  rootlyAlertSourceSecret: string;
  datadogApiUrl: string;
  rootlyApiUrl: string;
  providers: {
    id: ProviderId;
    token: string;
    apiUrl: string;
  }[];
}

export interface PlannedWebhook {
  name: string;
  serviceName: string;
  rootlyServiceId: string;
}

export interface PlannedMonitorUpdate {
  monitor: DatadogMonitor;
  oldMessage: string;
  newMessage: string;
  notifications: string[];
  webhookNames: string[];
}

export type IssueCode =
  | "ambiguous-provider-service"
  | "ambiguous-rootly-service"
  | "missing-provider-service"
  | "missing-rootly-service"
  | "webhook-name-collision";

export interface MigrationIssue {
  code: IssueCode;
  message: string;
  monitorId?: number;
  notification?: string;
}

export interface MigrationPlan {
  providers: ProviderId[];
  monitorCount: number;
  scannedNotificationCount: number;
  webhooks: PlannedWebhook[];
  updates: PlannedMonitorUpdate[];
  issues: MigrationIssue[];
}

export interface ExecutionResult {
  appliedMonitorIds: number[];
  createdOrVerifiedWebhooks: string[];
  errors: { operation: string; message: string }[];
}
