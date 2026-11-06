/** Active browser contexts, including background sync and switch candidates. */
export interface AccountBrowserRuntime {
  accountId: string;
  mode: "window" | "background";
}
