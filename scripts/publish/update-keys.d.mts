export const publicKeysFile: URL;
export function configuredPublicKeys(
  environment?: Record<string, string | undefined>,
): Record<string, string>;

export function validateReleasePublicKeys(
  value: unknown,
  options?: { required?: boolean },
): Record<string, string>;
