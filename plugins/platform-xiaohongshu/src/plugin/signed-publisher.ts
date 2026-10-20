import type {
  PlatformExecutionHost,
  PluginAccount,
} from "@nedia-matrix/platform-sdk";
import {
  createXhsPublishSession,
  createXhsVideoPublishSession,
  createXhsObjectRequester,
  xhsVideoPermitEndpoint,
  createXhsObjectUploader,
  xhsImagePermitEndpoint,
  xhsNoteEndpoint,
} from "../signed-api/index.js";
import { openXhsSignedTransport } from "./signed-transport.js";
const identityUrl =
  "https://creator.xiaohongshu.com/api/galaxy/creator/home/personal_info";
const allowedUploadHosts = [
  "ros-upload.xhscdn.com",
  "ros-upload-d4.xhscdn.com",
  "ros-upload.xiaohongshu.com",
];

export async function openXhsPublisher({
  host,
  account,
  adapterId,
  settings,
}: {
  host: PlatformExecutionHost;
  account: PluginAccount;
  adapterId: string;
  settings: import("@nedia-matrix/platform-sdk").PlatformSettings;
}) {
  if (settings.submissionMode !== "automatic")
    throw new Error("XHS publisher only supports automatic submission");
  if (
    account.platformId !== "xiaohongshu" ||
    !["xhs-sign.imageText.v1", "xhs-sign.video.v1"].includes(adapterId) ||
    account.identityScheme !== "xiaohongshu.red_num" ||
    !account.externalAccountId
  )
    throw new Error("XHS API account binding is invalid");
  host.assertOwnership();
  const transport = await openXhsSignedTransport(host, () =>
    host.assertOwnership(),
  );
  const sign = transport.sign;
  async function verifyIdentity(signal?: AbortSignal) {
    signal?.throwIfAborted();
    host.assertOwnership();
    try {
      const result = await host.observeJson({
        pageUrl: "https://creator.xiaohongshu.com/new/home",
        responseUrl: identityUrl,
        signal,
      });
      const body = result.body as {
        code?: number;
        success?: boolean;
        data?: { red_num?: unknown; name?: unknown };
      };
      if (
        result.status !== 200 ||
        body.success === false ||
        (body.code !== undefined && body.code !== 0) ||
        typeof body.data?.name !== "string" ||
        !body.data.name.trim() ||
        String(body.data.red_num) !== account.externalAccountId
      )
        throw new Error("Identity mismatch");
      signal?.throwIfAborted();
    } catch {
      throw new Error("Current XHS account identity could not be verified");
    }
  }
  const common = {
    allowedUploadHosts,
    verifyIdentity,
    async requestImagePermit(signal?: AbortSignal) {
      const result = await (await sign(xhsImagePermitEndpoint, "", signal))();
      if (result.status !== 200) throw new Error("Image permit rejected");
      return result.body;
    },
    uploadImage: createXhsObjectUploader(allowedUploadHosts),
    signNote: (body: string, signal: AbortSignal) =>
      sign(xhsNoteEndpoint, body, signal),
    close: () => transport.close(),
  };
  if (adapterId === "xhs-sign.video.v1")
    return createXhsVideoPublishSession({
      ...common,
      openLocalVideo: (reference, signal) => host.openVideo(reference, signal),
      async requestVideoPermit(signal) {
        const result = await (await sign(xhsVideoPermitEndpoint, "", signal))();
        if (result.status !== 200) throw new Error("Video permit rejected");
        return result.body;
      },
      requestObject: createXhsObjectRequester(allowedUploadHosts),
    });
  return createXhsPublishSession({
    ...common,
    readLocalImage: (reference, signal) => host.readImage(reference, signal),
  });
}
