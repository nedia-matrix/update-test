import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";

const source = resolve(import.meta.dirname, "../apps/desktop/installer");
const output = resolve(source, "../resources/update-helper");
await mkdir(output, { recursive: true });
const run = (command, args, env = {}) => {
  const environment = { ...process.env, ...env };
  delete environment.NEDIA_UPDATE_PRIVATE_KEY;
  delete environment.NEDIA_UPDATE_PRIVATE_KEY_FILE;
  const result = spawnSync(command, args, {
    cwd: source,
    stdio: "inherit",
    env: environment,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("更新辅助程序构建失败");
};
if (process.argv[2] === "mac") {
  for (const arch of ["arm64", "amd64"])
    run(
      "go",
      [
        "build",
        "-trimpath",
        "-ldflags=-s -w",
        "-o",
        join(output, `helper-${arch}`),
        ".",
      ],
      { GOOS: "darwin", GOARCH: arch, CGO_ENABLED: "0" },
    );
  run("lipo", [
    "-create",
    join(output, "helper-arm64"),
    join(output, "helper-amd64"),
    "-output",
    join(output, "nedia-update-helper"),
  ]);
} else if (process.argv[2] === "win") {
  run(
    "go",
    [
      "build",
      "-trimpath",
      "-ldflags=-s -w",
      "-o",
      join(output, "nedia-update-helper.exe"),
      ".",
    ],
    { GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "0" },
  );
} else throw new Error("未知辅助程序平台");
