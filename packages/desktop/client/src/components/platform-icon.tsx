export function PlatformIcon({
  iconUrl,
  platformName,
  compact = false,
}: {
  iconUrl?: string;
  platformName: string;
  compact?: boolean;
}) {
  const className = compact ? "platform-mini-logo" : "platform-logo";

  return (
    <span class={className} aria-hidden="true">
      {iconUrl ? (
        <img src={iconUrl} alt="" />
      ) : (
        (Array.from(platformName.trim())[0] ?? "平")
      )}
    </span>
  );
}
