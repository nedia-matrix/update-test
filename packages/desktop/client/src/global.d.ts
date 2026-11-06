import type { MatrixDesktopApi } from "@nedia-matrix/desktop-contracts/api";

declare global {
  interface Window {
    matrix: MatrixDesktopApi;
  }
}

export {};
