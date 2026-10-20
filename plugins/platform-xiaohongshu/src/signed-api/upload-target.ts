import { isIP } from "node:net";
import { XhsPreparationError } from "./errors.js";

export interface XhsUploadPermit {
  readonly fileId: string;
  readonly url: string;
  readonly token: string;
}

/** Only an explicit host list validated against live permit evidence may receive tokens. */
export function parseImagePermit(
  body: unknown,
  allowedHosts: readonly string[],
): XhsUploadPermit {
  const response = body as {
    code?: unknown;
    success?: unknown;
    data?: { uploadTempPermits?: unknown };
  };
  if (response?.code !== 0 || response.success === false)
    throw new XhsPreparationError("permit_rejected");
  const permits = response.data?.uploadTempPermits;
  if (!Array.isArray(permits) || permits.length === 0)
    throw new XhsPreparationError("permit_invalid");
  // Preserve the reference's first-permit choice; never retarget a failed upload to a second token/address.
  const permit = permits[0] as {
    fileIds?: unknown;
    uploadAddr?: unknown;
    token?: unknown;
  };
  const id = Array.isArray(permit?.fileIds)
    ? permit.fileIds[0]
    : permit?.fileIds;
  if (
    typeof id !== "string" ||
    !id ||
    typeof permit?.uploadAddr !== "string" ||
    typeof permit.token !== "string" ||
    !permit.token ||
    /[\r\n]/.test(permit.token)
  )
    throw new XhsPreparationError("permit_invalid");
  if (
    !/^[a-zA-Z0-9_./-]+$/.test(id) ||
    id.startsWith("//") ||
    id.split("/").some((part) => part === "." || part === "..")
  )
    throw new XhsPreparationError("upload_target_rejected");
  let base: URL;
  try {
    base = new URL(
      permit.uploadAddr.includes("://")
        ? permit.uploadAddr
        : `https://${permit.uploadAddr}`,
    );
  } catch {
    throw new XhsPreparationError("upload_target_rejected");
  }
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.port && base.port !== "443") ||
    isIP(base.hostname) ||
    !allowedHosts.includes(base.hostname)
  )
    throw new XhsPreparationError("upload_target_rejected");
  const url = new URL(
    `${base.href.replace(/\/$/, "")}/${id.replace(/^\//, "")}`,
  );
  if (url.hostname !== base.hostname)
    throw new XhsPreparationError("upload_target_rejected");
  return Object.freeze({ fileId: id, url: url.href, token: permit.token });
}

export function isPublicUploadAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (kind === 6) {
    const head = Number.parseInt(address.split(":")[0] ?? "0", 16);
    const second = Number.parseInt(address.split(":")[1] ?? "0", 16);
    return (
      head >= 0x2000 &&
      head <= 0x3fff &&
      head !== 0x2002 &&
      !(head === 0x2001 && (second === 0 || second === 0xdb8))
    );
  }
  return false;
}
