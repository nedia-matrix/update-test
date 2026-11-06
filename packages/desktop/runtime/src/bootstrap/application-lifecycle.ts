export type WindowOpenDecision = "open-now" | "ignore-during-shutdown";

export class ApplicationLifecycle {
  private shutdownStarted = false;

  requestWindowOpen(): WindowOpenDecision {
    if (!this.shutdownStarted) return "open-now";
    return "ignore-during-shutdown";
  }

  beginShutdown(): boolean {
    if (this.shutdownStarted) return false;
    this.shutdownStarted = true;
    return true;
  }
}
