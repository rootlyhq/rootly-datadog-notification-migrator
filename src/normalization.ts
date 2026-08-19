export function normalizeServiceName(serviceName: string): string {
  return serviceName
    .replace(/[^\w-]+/g, "_")
    .toLowerCase()
    .replace(/^[_-]+|[_-]+$/g, "");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
