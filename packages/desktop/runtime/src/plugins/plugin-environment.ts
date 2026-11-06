import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface PluginEnvironment {
  trust: "development" | "release";
  bundledDirectory: string;
  /** Release keys are embedded by the build, never read from an application directory. */
  publicKeys?: Readonly<Record<string, string>>;
}
export function resolvePluginEnvironment(environment: PluginEnvironment) {
  if (!["development", "release"].includes(environment.trust))
    throw new Error("无效的插件信任模式");
  if (!isAbsolute(environment.bundledDirectory))
    throw new Error("插件资源目录必须为绝对路径");
  const keys =
    environment.trust === "development"
      ? (JSON.parse(
          readFileSync(
            join(environment.bundledDirectory, "development-public-keys.json"),
            "utf8",
          ),
        ) as Record<string, string>)
      : environment.publicKeys;
  if (
    !keys ||
    typeof keys !== "object" ||
    Array.isArray(keys) ||
    (environment.trust === "release" &&
      (Object.keys(keys).length === 0 ||
        Object.hasOwn(keys, "development-only")))
  ) {
    throw new Error("正式插件信任未配置或包含开发密钥");
  }
  return {
    ...environment,
    publicKeys: keys,
    installationDirectoryName:
      environment.trust === "release"
        ? ("plugins" as const)
        : ("plugins-development" as const),
    refreshBundledOnStartup: environment.trust === "development",
  };
}
