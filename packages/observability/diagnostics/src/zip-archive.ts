import { inflateRawSync } from "node:zlib";
export interface ZipArchiveEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

export function createZipArchive(entries: readonly ZipArchiveEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    if (
      !/^[A-Za-z0-9._/-]{1,512}$/.test(entry.name) ||
      entry.name.includes("..")
    )
      throw new TypeError("Invalid ZIP entry name");
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  if (entries.length > 65_535) throw new RangeError("Too many ZIP entries");
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Bounded, in-memory ZIP import: no archive entry ever becomes a filesystem path. */
export function readZipArchive(archive: Buffer): Map<string, Buffer> {
  const maxTotal = 100 * 1024 * 1024;
  const maxEntry = 20 * 1024 * 1024;
  if (archive.length > maxTotal) throw new Error("ZIP exceeds 100 MiB");
  let end = archive.length - 22;
  const lower = Math.max(0, end - 65535);
  while (end >= lower && archive.readUInt32LE(end) !== 0x06054b50) end--;
  if (
    end < lower ||
    end + 22 + archive.readUInt16LE(end + 20) !== archive.length
  )
    throw new Error("Invalid ZIP directory");
  const count = archive.readUInt16LE(end + 10);
  const centralSize = archive.readUInt32LE(end + 12);
  let cursor = archive.readUInt32LE(end + 16);
  if (
    archive.readUInt16LE(end + 4) ||
    archive.readUInt16LE(end + 6) ||
    archive.readUInt16LE(end + 8) !== count ||
    count > 512 ||
    cursor + centralSize !== end
  )
    throw new Error("Unsupported ZIP or entry limit exceeded");
  const entries = new Map<string, Buffer>();
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error("Invalid ZIP entry");
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const checksum = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const mode = archive.readUInt32LE(cursor + 38) >>> 16;
    const localOffset = archive.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw new Error("Invalid ZIP entry length");
    const name = archive
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");
    if (
      !/^[A-Za-z0-9._/-]{1,512}$/.test(name) ||
      name.startsWith("/") ||
      name.split("/").some((part) => part === ".." || part === ".") ||
      entries.has(name) ||
      (mode & 0xf000) === 0xa000
    )
      throw new Error("Unsafe ZIP entry");
    total += size;
    if (
      size > maxEntry ||
      total > maxTotal ||
      flags & 1 ||
      ![0, 8].includes(method)
    )
      throw new Error("ZIP size limit or unsupported compression");
    if (
      localOffset + 30 > cursor ||
      archive.readUInt32LE(localOffset) !== 0x04034b50
    )
      throw new Error("Invalid ZIP local header");
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const start =
      localOffset +
      30 +
      localNameLength +
      archive.readUInt16LE(localOffset + 28);
    const localName = archive
      .subarray(localOffset + 30, localOffset + 30 + localNameLength)
      .toString("utf8");
    if (
      localName !== name ||
      archive.readUInt16LE(localOffset + 8) !== method ||
      archive.readUInt16LE(localOffset + 6) !== flags ||
      start + compressedSize > archive.readUInt32LE(end + 16)
    )
      throw new Error("ZIP header mismatch");
    const compressed = archive.subarray(start, start + compressedSize);
    const data =
      method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, {
            maxOutputLength: Math.max(1, Math.min(size, maxEntry)),
          });
    if (data.length !== size || crc32(data) !== checksum)
      throw new Error("ZIP checksum or size mismatch");
    entries.set(name, data);
    cursor = next;
  }
  if (cursor !== end) throw new Error("Invalid ZIP directory size");
  return entries;
}
