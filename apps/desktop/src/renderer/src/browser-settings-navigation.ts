export const browserSettingsHash = "/settings?tab=platform&section=browser";

export function isBrowserSettingsLocation(hash: string): boolean {
  const [path, query] = hash.replace(/^#/, "").split("?");
  const parameters = new URLSearchParams(query);
  return (
    path === "/settings" &&
    parameters.get("tab") === "platform" &&
    parameters.get("section") === "browser"
  );
}
