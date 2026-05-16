import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 读取当前包版本号。
 *
 * 运行在 dist/src 下时，package.json 位于上两级目录；开发模式下也会继续向上查找。
 * 这样 MCP initialize 返回版本始终与 package.json 保持一致，避免出现双版本号。
 */
export function getPackageVersion(): string {
  const fromEnv = process.env.npm_package_version?.trim();
  if (fromEnv) return fromEnv;

  const startDir = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.resolve(startDir, "..", "..", "package.json"),
    path.resolve(startDir, "..", "package.json"),
    path.resolve(process.cwd(), "package.json")
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim()) return parsed.version;
    } catch {
      // 继续查找下一个候选位置。
    }
  }

  return "0.1.0";
}
