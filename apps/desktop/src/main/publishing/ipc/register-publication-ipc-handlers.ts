import { ipcChannels } from "../../../bridge/channels.js";
import type {
  PublicationAttentionResolution,
  PublicationQuery,
  SelectPublishMediaRequest,
} from "@nedia-matrix/publishing";
import { dialog, ipcMain, shell } from "electron";

import type { NediaMatrixUseCases } from "../../application/nedia-matrix-application.js";
import { readLocalMediaResources } from "./local-media-resources.js";

type PublishIpcApplication = Pick<
  NediaMatrixUseCases,
  "publications" | "publicationPlatformContent"
>;

interface PublishIpcDependencies {
  application: PublishIpcApplication;
}

export function registerPublicationIpcHandlers({
  application,
}: PublishIpcDependencies): void {
  ipcMain.handle(
    ipcChannels.queryPublications,
    (_event, request: PublicationQuery) => {
      if (!application.publications.queryTasks)
        throw new Error("Publication query is unavailable");
      return application.publications.queryTasks(request);
    },
  );
  ipcMain.handle(
    ipcChannels.getPublicationTask,
    (_event, request: { publicationId: string }) => {
      if (
        !request ||
        typeof request.publicationId !== "string" ||
        !request.publicationId.trim()
      )
        throw new TypeError("Invalid publication request");
      return application.publications.getTask?.(request.publicationId) ?? null;
    },
  );
  ipcMain.handle(
    ipcChannels.getPublicationPlatformContent,
    (_event, request: { publicationId: string }) => {
      if (
        !request ||
        typeof request.publicationId !== "string" ||
        !request.publicationId.trim()
      )
        throw new TypeError("Invalid publication request");
      return application.publicationPlatformContent(request.publicationId);
    },
  );
  ipcMain.handle(
    ipcChannels.recreatePublicationDraft,
    (_event, request: { publicationId: string }) => {
      if (
        !request ||
        typeof request.publicationId !== "string" ||
        !request.publicationId.trim()
      )
        throw new TypeError("Invalid publication request");
      if (!application.publications.recreateDraft)
        throw new Error("Publication recreation is unavailable");
      return application.publications.recreateDraft(request.publicationId);
    },
  );
  ipcMain.handle(
    ipcChannels.resolvePublicationAttention,
    (_event, input: unknown) => {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        typeof (input as Record<string, unknown>).publicationId !== "string" ||
        typeof (input as Record<string, unknown>).resolution !== "string" ||
        !(input as { publicationId: string }).publicationId.trim()
      )
        throw new TypeError("Invalid publication attention request");
      const request = input as {
        publicationId: string;
        resolution: PublicationAttentionResolution;
        manualPlatformContentId?: string;
      };
      if (!application.publications.resolveAttention)
        throw new Error("Publication attention handling is unavailable");
      return application.publications.resolveAttention(request);
    },
  );
  ipcMain.handle(
    ipcChannels.reopenPublicationAttention,
    (_event, input: unknown) => {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        typeof (input as Record<string, unknown>).publicationId !== "string" ||
        !(input as { publicationId: string }).publicationId.trim()
      )
        throw new TypeError("Invalid publication attention request");
      if (!application.publications.reopenAttention)
        throw new Error("Publication attention handling is unavailable");
      return application.publications.reopenAttention(
        (input as { publicationId: string }).publicationId,
      );
    },
  );
  ipcMain.handle(
    ipcChannels.selectPublicationContent,
    (_event, input: unknown) => {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        typeof (input as Record<string, unknown>).publicationId !== "string" ||
        typeof (input as Record<string, unknown>).externalContentId !== "string"
      )
        throw new TypeError("Invalid publication content selection");
      const request = input as {
        publicationId: string;
        externalContentId: string;
      };
      if (!request.publicationId.trim() || !request.externalContentId.trim())
        throw new TypeError("Invalid publication content selection");
      if (!application.publications.selectContent)
        throw new Error("Publication content selection is unavailable");
      return application.publications.selectContent(
        request.publicationId,
        request.externalContentId,
      );
    },
  );
  ipcMain.handle(
    ipcChannels.removePublicationArchiveRecord,
    (_event, request: unknown) => {
      if (
        !request ||
        typeof request !== "object" ||
        Array.isArray(request) ||
        typeof (request as Record<string, unknown>).publicationId !== "string"
      )
        throw new TypeError("Invalid publication archive request");
      const parsed = request as { publicationId: string };
      if (!parsed.publicationId.trim())
        throw new TypeError("Invalid publication archive request");
      if (!application.publications.removeArchivePublication)
        throw new Error("Publication archive maintenance is unavailable");
      return application.publications.removeArchivePublication(
        parsed.publicationId,
      );
    },
  );
  ipcMain.handle(ipcChannels.openPublicationReview, (_event, request) =>
    application.publications.openReview(request),
  );
  ipcMain.handle(ipcChannels.openPublication, async (_event, request) =>
    shell.openExternal(application.publications.publicationUrl(request)),
  );

  ipcMain.handle(
    ipcChannels.selectPublishMedia,
    async (_event, request: SelectPublishMediaRequest) => {
      const result = await dialog.showOpenDialog({
        title:
          request.contentForm === "video" ? "选择发布视频" : "选择发布图片",
        properties:
          request.contentForm === "video"
            ? ["openFile"]
            : ["openFile", "multiSelections"],
        filters:
          request.contentForm === "video"
            ? [{ name: "视频", extensions: ["mp4", "mov", "m4v", "webm"] }]
            : [{ name: "图片", extensions: ["jpg", "jpeg", "png", "webp"] }],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { status: "cancelled" } as const;
      }
      const resources = await readLocalMediaResources(result.filePaths);
      return application.publications.registerLocalMedia({
        ...request,
        resources,
      });
    },
  );

  ipcMain.handle(ipcChannels.preparePublishDraft, (_event, request) =>
    application.publications.prepare(request),
  );
}
