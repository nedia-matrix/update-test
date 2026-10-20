/** Main owns all paths, seeds, subprocesses and download sources. */
export interface FingerprintBrowserStatus {
  revision: number;
  taskId?: string;
  version: string;
  supported: boolean;
  available: boolean;
  phase:
    | "checking"
    | "missing"
    | "ready"
    | "downloading"
    | "extracting"
    | "verifying"
    | "publishing"
    | "cancelling"
    | "cancelled"
    | "failed";
  receivedBytes: number;
  totalBytes?: number;
  error?: {
    code:
      | "unsupported"
      | "busy"
      | "network"
      | "checksum"
      | "archive"
      | "verification"
      | "filesystem"
      | "cleanup"
      | "preferences";
    message: string;
  };
}
export interface CancelFingerprintBrowserInstallRequest {
  taskId: string;
}

export interface InstallFingerprintBrowserRequest {
  enableForNewAccounts?: boolean;
}
