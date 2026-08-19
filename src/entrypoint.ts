import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMainModule(
  moduleUrl: string,
  executablePath: string | undefined,
): boolean {
  if (!executablePath) {
    return false;
  }

  try {
    return (
      realpathSync(fileURLToPath(moduleUrl)) === realpathSync(executablePath)
    );
  } catch {
    return false;
  }
}
