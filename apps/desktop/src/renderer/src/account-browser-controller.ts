import type { MatrixDesktopApi } from "../../bridge/api.js";
import type {
  AccountBrowserState,
  AccountBrowserSwitchStatus,
} from "../../bridge/account-browser-switch.js";
import type { AccountBrowserProvider } from "@nedia-matrix/account-management";

type Api = Pick<
  MatrixDesktopApi,
  | "getAccountBrowserState"
  | "beginAccountBrowserSwitch"
  | "getAccountBrowserSwitch"
  | "cancelAccountBrowserSwitch"
>;
export const isSwitchActive = (state?: AccountBrowserSwitchStatus) =>
  !!state &&
  [
    "preparing",
    "awaiting_login",
    "verifying",
    "committing",
    "cancelling",
  ].includes(state.phase);
export interface AccountBrowserControllerState {
  environment?: AccountBrowserState;
  operation?: AccountBrowserSwitchStatus;
  pending: boolean;
  error?: string;
}
export class AccountBrowserController {
  private state: AccountBrowserControllerState = { pending: false };
  private disposed = false;
  private sequence = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly api: Api,
    private readonly accountId: string,
    private readonly listener: (state: AccountBrowserControllerState) => void,
  ) {}
  private emit(): void {
    if (!this.disposed) this.listener(structuredClone(this.state));
  }
  async load(): Promise<void> {
    const sequence = ++this.sequence;
    try {
      const environment = await this.api.getAccountBrowserState({
        accountId: this.accountId,
      });
      if (this.disposed || sequence !== this.sequence) return;
      this.state.environment = environment;
      delete this.state.error;
      if (environment.operation) this.state.operation = environment.operation;
      this.emit();
      this.schedule();
    } catch {
      if (!this.disposed && sequence === this.sequence) {
        this.state.error = "无法读取账号浏览器状态，请重试";
        this.emit();
      }
    }
  }
  async begin(targetProvider: AccountBrowserProvider): Promise<void> {
    if (this.disposed || this.state.pending) return;
    clearTimeout(this.timer);
    const sequence = ++this.sequence;
    this.state.pending = true;
    delete this.state.error;
    this.emit();
    try {
      const operation = await this.api.beginAccountBrowserSwitch({
        accountId: this.accountId,
        targetProvider,
      });
      if (this.disposed || sequence !== this.sequence) return;
      this.state.operation = operation;
      if (operation.phase === "unchanged") {
        const environment = await this.api.getAccountBrowserState({
          accountId: this.accountId,
        });
        if (!this.disposed && sequence === this.sequence)
          this.state.environment = environment;
      }
    } catch (error) {
      if (!this.disposed && sequence === this.sequence)
        this.state.error = accountBrowserError(error);
    } finally {
      if (!this.disposed && sequence === this.sequence) {
        this.state.pending = false;
        this.emit();
        this.schedule();
      }
    }
  }
  async cancel(): Promise<void> {
    const operationId = this.state.operation?.operationId;
    if (this.disposed || this.state.pending || !operationId) return;
    clearTimeout(this.timer);
    const sequence = ++this.sequence;
    this.state.pending = true;
    delete this.state.error;
    this.emit();
    try {
      const operation = await this.api.cancelAccountBrowserSwitch({
        operationId,
      });
      if (this.disposed || sequence !== this.sequence) return;
      this.state.operation = operation;
      const environment = await this.api.getAccountBrowserState({
        accountId: this.accountId,
      });
      if (this.disposed || sequence !== this.sequence) return;
      this.state.environment = environment;
    } catch {
      if (!this.disposed && sequence === this.sequence)
        this.state.error = "切换取消尚未完成，请重试";
    } finally {
      if (!this.disposed && sequence === this.sequence) {
        this.state.pending = false;
        this.emit();
        this.schedule();
      }
    }
  }
  private schedule(): void {
    clearTimeout(this.timer);
    if (
      this.disposed ||
      !isSwitchActive(this.state.operation) ||
      this.state.pending
    )
      return;
    this.timer = setTimeout(() => void this.poll(), 1_000);
  }
  private async poll(): Promise<void> {
    const operationId = this.state.operation?.operationId;
    if (!operationId || this.disposed) return;
    const sequence = ++this.sequence;
    try {
      const operation = await this.api.getAccountBrowserSwitch({ operationId });
      if (this.disposed || sequence !== this.sequence) return;
      this.state.operation = operation;
      if (!isSwitchActive(operation)) {
        const environment = await this.api.getAccountBrowserState({
          accountId: this.accountId,
        });
        if (this.disposed || sequence !== this.sequence) return;
        this.state.environment = environment;
      }
      delete this.state.error;
      this.emit();
    } catch {
      if (!this.disposed && sequence === this.sequence) {
        this.state.error = "切换状态读取失败，将重试";
        this.emit();
      }
    } finally {
      if (!this.disposed && sequence === this.sequence) this.schedule();
    }
  }
  dispose(): void {
    this.disposed = true;
    ++this.sequence;
    clearTimeout(this.timer);
  }
}

function accountBrowserError(error: unknown): string {
  if (!(error instanceof Error)) return "切换启动失败，请重试";
  const message = error.message.replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    "",
  );
  return /[\u4e00-\u9fff]/.test(message)
    ? message
    : "切换启动失败，请检查账号状态并重试";
}
