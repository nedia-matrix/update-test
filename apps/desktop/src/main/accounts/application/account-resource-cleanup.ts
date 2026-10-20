interface AccountCleanupDependencies {
  accountStore?: { get(accountId: string): { profileId: string } | undefined };
  publishObservations: {
    stop(accountId: string): Promise<void>;
  };
  mediaSelections: {
    removeForAccount(accountId: string): void;
  };
}

export function cleanupClosedBrowserSession(
  accountId: string,
  dependencies: AccountCleanupDependencies,
  profileId?: string,
): void {
  if (profileId && dependencies.accountStore) {
    try {
      if (dependencies.accountStore.get(accountId)?.profileId !== profileId)
        return;
    } catch {
      return;
    }
  }
  void dependencies.publishObservations.stop(accountId);
  dependencies.mediaSelections.removeForAccount(accountId);
}
