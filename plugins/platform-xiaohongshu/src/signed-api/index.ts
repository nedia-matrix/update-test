export {
  XhsPreparationError,
  checkCancellation,
  type XhsPreparationErrorCode,
} from "./errors.js";
export { inspectImage, type XhsImageMetadata } from "./image-metadata.js";
export {
  parseImagePermit,
  isPublicUploadAddress,
  type XhsUploadPermit,
} from "./upload-target.js";
export {
  createXhsObjectUploader,
  createXhsObjectRequester,
  type XhsObjectRequester,
  type XhsObjectOperation,
  type XhsObjectResponse,
} from "./object-uploader.js";
export {
  prepareImageNote,
  type XhsImageNoteInput,
  type XhsImagePreparationPorts,
  type XhsPreparedImageNote,
  type XhsPreparedImage,
  type XhsPreparationProgress,
} from "./image-preparation.js";
export { xhsSignPlatformModule } from "./platform.js";
export {
  createXhsPublishSession,
  parseXhsNoteResponse,
  xhsNoteEndpoint,
  type XhsPublishSessionPorts,
} from "./publish-session.js";
export {
  xhsSigningAssets,
  xhsImagePermitEndpoint,
  readXhsSignature,
} from "./signing-assets.js";

export {
  xhsIdentityEndpoint,
  xhsContentEndpoint,
  isXhsSignedEndpoint,
  verifyXhsIdentity,
  parseXhsAccountProfile,
  parseXhsContentPage,
  xhsAccountProfileCapability,
  xhsContentCapability,
} from "./data-reader.js";

export {
  prepareVideoNote,
  createXhsVideoPublishSession,
  xhsVideoChunkBytes,
  xhsVideoPermitEndpoint,
  buildXhsMultipartXml,
  type XhsLocalVideo,
  type XhsVideoPreparationPorts,
  type XhsVideoProgress,
} from "./video-preparation.js";
