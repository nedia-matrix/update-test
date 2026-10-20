import { XhsPreparationError } from "./errors.js";

export interface XhsImageMetadata {
  readonly width: number;
  readonly height: number;
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp";
}

/** Bounded header inspection; the platform still validates the image encoding. */
export function inspectImage(bytes: Uint8Array): XhsImageMetadata {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let mediaType: XhsImageMetadata["mediaType"];
  if (
    b.length >= 33 &&
    b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
    b.readUInt32BE(8) === 13 &&
    b.toString("ascii", 12, 16) === "IHDR"
  ) {
    width = b.readUInt32BE(16);
    height = b.readUInt32BE(20);
    mediaType = "image/png";
  } else if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    mediaType = "image/jpeg";
    let offset = 2;
    while (offset + 4 <= b.length) {
      if (b[offset++] !== 0xff) throw new XhsPreparationError("invalid_image");
      while (b[offset] === 0xff) offset++;
      const marker = b[offset++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > b.length) break;
      const length = b.readUInt16BE(offset);
      if (length < 2 || offset + length > b.length) break;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      ) {
        if (length < 8) break;
        height = b.readUInt16BE(offset + 3);
        width = b.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (
    b.length >= 25 &&
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  ) {
    mediaType = "image/webp";
    const type = b.toString("ascii", 12, 16);
    if (type === "VP8X" && b.length >= 30) {
      width = b.readUIntLE(24, 3) + 1;
      height = b.readUIntLE(27, 3) + 1;
    } else if (
      type === "VP8 " &&
      b.length >= 30 &&
      b.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))
    ) {
      width = b.readUInt16LE(26) & 0x3fff;
      height = b.readUInt16LE(28) & 0x3fff;
    } else if (type === "VP8L" && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    }
  } else throw new XhsPreparationError("invalid_image");
  if (!width || !height) throw new XhsPreparationError("invalid_image");
  return Object.freeze({ width, height, mediaType });
}
