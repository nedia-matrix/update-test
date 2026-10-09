import type { PlatformPublishFormCapability } from "./publishing.js";

export interface PreparedPublishText {
  body: string;
  tags: readonly string[];
  tagsToAppend: readonly string[];
}

export function normalizePublishBody(
  form: Pick<PlatformPublishFormCapability, "tagPolicy">,
  body: string,
): string {
  if (form.tagPolicy?.placement !== "inline") return body;
  // Match the separator inserted by inline-topic editors before a #topic.
  // URL fragments are ordinary text and must keep their original spelling.
  return body.replace(/\S+/gu, (word) =>
    word.includes("://")
      ? word
      : word.replace(/([^#])#(?=[\p{L}\p{N}_])/gu, "$1 #"),
  );
}

export function composePublishDescription(
  form: Pick<PlatformPublishFormCapability, "descriptionComposition">,
  input: { title: string; body: string },
): string {
  const composition = form.descriptionComposition;
  if (!composition) return input.body;
  return composition.parts
    .map((part) => input[part].trim())
    .filter(Boolean)
    .join(composition.separator);
}

export function preparePublishText(
  form: Pick<PlatformPublishFormCapability, "tagPolicy">,
  body: string,
  requestedTags: readonly string[] | undefined,
): PreparedPublishText {
  const tags = normalizeTags(requestedTags ?? []);
  if (tags.length === 0) return { body, tags, tagsToAppend: [] };

  const policy = form.tagPolicy;
  if (!policy) {
    throw new TypeError("This platform publish form does not support tags");
  }
  if (policy.maxCount !== undefined && tags.length > policy.maxCount) {
    throw new RangeError(
      `This platform supports at most ${policy.maxCount} tags`,
    );
  }

  const tagsToAppend = tags.filter((tag) => !containsHashtag(body, `#${tag}`));
  if (tagsToAppend.length === 0) return { body, tags, tagsToAppend };

  const separator = policy.placement === "inline" ? " " : "\n";
  const normalizedBody = body.trimEnd();
  return {
    body: [normalizedBody, ...tagsToAppend.map((tag) => `#${tag}`)]
      .filter((part) => part.length > 0)
      .join(separator),
    tags,
    tagsToAppend,
  };
}

function containsHashtag(body: string, hashtag: string): boolean {
  const escapedHashtag = hashtag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[^\\p{L}\\p{N}_-])${escapedHashtag}(?=$|[^\\p{L}\\p{N}_-])`,
    "u",
  ).test(body);
}

function normalizeTags(tags: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const requestedTag of tags) {
    const tag = requestedTag
      .trim()
      .replace(/^#+\s*/, "")
      .trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    normalized.push(tag);
  }
  return normalized;
}
