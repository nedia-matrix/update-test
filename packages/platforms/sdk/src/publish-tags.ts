import type { PlatformPublishFormCapability } from "./publishing.js";

export interface PreparedPublishText {
  body: string;
  tags: readonly string[];
  tagsToAppend: readonly string[];
}

export class PublishTagLimitError extends RangeError {
  constructor(maxCount: number, actualCount: number) {
    super(
      `This platform supports at most ${maxCount} tags (${actualCount} unique tags across the body and tag input)`,
    );
    this.name = "PublishTagLimitError";
  }
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

/** Unique topic names across plain-text body hashtags and explicit tags. */
export function collectPublishTags(
  body: string,
  requestedTags: readonly string[] | undefined,
): string[] {
  return normalizeTags([...bodyHashtags(body), ...(requestedTags ?? [])]);
}

export function preparePublishText(
  form: Pick<PlatformPublishFormCapability, "tagPolicy">,
  body: string,
  requestedTags: readonly string[] | undefined,
): PreparedPublishText {
  const tags = normalizeTags(requestedTags ?? []);
  const policy = form.tagPolicy;
  if (!policy && tags.length > 0) {
    throw new TypeError("This platform publish form does not support tags");
  }
  const allTags = collectPublishTags(body, tags);
  if (policy?.maxCount !== undefined && allTags.length > policy.maxCount) {
    throw new PublishTagLimitError(policy.maxCount, allTags.length);
  }
  if (tags.length === 0) return { body, tags, tagsToAppend: [] };

  const existingTags = new Set(bodyHashtags(body));
  const tagsToAppend = tags.filter((tag) => !existingTags.has(tag));
  if (tagsToAppend.length === 0) return { body, tags, tagsToAppend };

  const separator = policy?.placement === "inline" ? " " : "\n";
  const normalizedBody = body.trimEnd();
  return {
    body: [normalizedBody, ...tagsToAppend.map((tag) => `#${tag}`)]
      .filter((part) => part.length > 0)
      .join(separator),
    tags,
    tagsToAppend,
  };
}

function bodyHashtags(body: string): string[] {
  // A fragment in a link is not a topic. Keep the original body unchanged.
  const text = body.replace(/(?:[a-z][a-z\d+.-]*:\/\/|www\.)\S+/giu, " ");
  // Topics may touch preceding prose or another topic; punctuation ends a name.
  return [...text.matchAll(/#([\p{L}\p{M}\p{N}\p{S}_\u200D-]+)/gu)].map(
    (match) => match[1]!,
  );
}

function normalizeTags(tags: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const requestedTag of tags) {
    const names = requestedTag
      .trim()
      .replace(/^#+\s*/, "")
      .split(/\s*#+\s*/u);
    for (const name of names) {
      const tag = name.trim();
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      normalized.push(tag);
    }
  }
  return normalized;
}
