/** Shared by desktop IPC and local Runtime use cases; reservation is synchronous. */
export class AccountActivityGate {
  private readonly active = new Map<string, number>();
  private readonly switching = new Set<string>();

  hasAnySwitch(): boolean {
    return this.switching.size > 0;
  }
  isSwitching(accountId: string): boolean {
    return this.switching.has(accountId);
  }
  isBusy(accountId: string): boolean {
    return this.isSwitching(accountId) || !!this.active.get(accountId);
  }
  assertAvailable(accountId: string): void {
    if (this.isSwitching(accountId))
      throw new Error("账号正在切换浏览器环境，请先完成或取消切换");
  }
  acquireSwitch(accountId: string): () => void {
    if (this.isBusy(accountId))
      throw new Error("账号存在活动操作，请先结束发布、同步或刷新");
    this.switching.add(accountId);
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.switching.delete(accountId);
      }
    };
  }
  guard<T extends object>(
    target: T,
    accountFor: (key: PropertyKey, args: unknown[]) => string | undefined,
  ): T {
    return new Proxy(target, {
      get: (object, key, receiver) => {
        const method: unknown = Reflect.get(object, key, receiver);
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => {
          const accountId = accountFor(key, args);
          if (!accountId) return Reflect.apply(method, object, args);
          this.assertAvailable(accountId);
          this.active.set(accountId, (this.active.get(accountId) ?? 0) + 1);
          const release = () => {
            const count = (this.active.get(accountId) ?? 1) - 1;
            if (count) this.active.set(accountId, count);
            else this.active.delete(accountId);
          };
          try {
            const result: unknown = Reflect.apply(method, object, args);
            if (result instanceof Promise) return result.finally(release);
            release();
            return result;
          } catch (error) {
            release();
            throw error;
          }
        };
      },
    });
  }
}
