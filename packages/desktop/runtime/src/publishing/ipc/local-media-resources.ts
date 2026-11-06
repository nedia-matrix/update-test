import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";

import type { LocalMediaResource } from "@nedia-matrix/publishing";

export async function readLocalMediaResources(
  filePaths: readonly string[],
): Promise<LocalMediaResource[]> {
  return Promise.all(
    filePaths.map(async (filePath) => {
      const metadata = await stat(filePath);
      if (!metadata.isFile()) throw new TypeError("Media must be a file");
      return {
        reference: filePath,
        name: basename(filePath),
        size: metadata.size,
        extension: extname(filePath),
      };
    }),
  );
}
