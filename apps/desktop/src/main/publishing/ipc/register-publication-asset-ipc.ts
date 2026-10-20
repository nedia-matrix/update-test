import { ipcMain, shell } from "electron";
import type { PublicationAssetSnapshot } from "@nedia-matrix/publishing";
import { ipcChannels } from "../../../bridge/channels.js";

interface PublicationAssetDependencies {
  getAssets(
    publicationId: string,
  ): readonly PublicationAssetSnapshot[] | undefined;
  resolvePath(relativePath: string): Promise<string | undefined>;
}

export function registerPublicationAssetIpc(
  dependencies: PublicationAssetDependencies,
): void {
  ipcMain.handle(
    ipcChannels.openPublicationAsset,
    async (_event, request: unknown) => {
      if (!request || typeof request !== "object")
        throw new TypeError("Invalid publication asset request");
      const { publicationId, assetIndex } = request as {
        publicationId?: unknown;
        assetIndex?: unknown;
      };
      if (
        typeof publicationId !== "string" ||
        !publicationId.trim() ||
        publicationId.length > 128 ||
        typeof assetIndex !== "number" ||
        !Number.isInteger(assetIndex) ||
        assetIndex < 0
      ) {
        throw new TypeError("Invalid publication asset request");
      }
      const asset = dependencies.getAssets(publicationId)?.[assetIndex];
      if (!asset) throw new Error("素材记录不存在，请刷新发布记录");
      if (!asset.localRelativePath) throw new Error("该素材没有本地归档文件");
      const path = await dependencies.resolvePath(asset.localRelativePath);
      if (!path) throw new Error("素材文件已缺失或被清理");
      const error = await shell.openPath(path);
      if (error) throw new Error(`无法打开素材文件：${error}`);
    },
  );
}
