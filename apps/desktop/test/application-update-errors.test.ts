import { expect, it } from "vitest";
import { updateErrorMessage } from "../src/renderer/src/application-update-errors.js";
it.each([
  "AbortError: The operation was aborted",
  "TimeoutError: The operation was aborted due to timeout",
  "TypeError: fetch failed",
])(
  "explains IPC network failure %s without implementation details",
  (failure) => {
    expect(
      updateErrorMessage(
        new Error(
          `Error invoking remote method 'matrix:application:check-for-update': ${failure}`,
        ),
        "检查失败",
      ),
    ).toBe("连接更新源超时或中断，请检查网络后重试。");
  },
);
it("retains actionable validation failures and strips only the Electron envelope", () => {
  expect(
    updateErrorMessage(
      new Error(
        "Error invoking remote method 'matrix:application:check-for-update': Error: 更新清单签名验证失败",
      ),
      "检查失败",
    ),
  ).toBe("更新清单签名验证失败");
  expect(
    updateErrorMessage(
      new Error("更新地址解析到了非公网地址，已拒绝连接"),
      "检查失败",
    ),
  ).toBe("更新地址解析到了非公网地址，已拒绝连接");
});
