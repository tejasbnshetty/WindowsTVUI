import { inkOn, wordmarkSize } from "./color";
import type { PublicApp } from "./types";

export const cssVars = (vars: Record<string, string>) => vars as unknown as Record<string, string>;

/**
 * An app's logo: a custom image if one was provided, else its bundled simple-icons logo, else a bold
 * wordmark generated from the name (for brands simple-icons does not carry).
 */
export function Logo({ app }: { app: Pick<PublicApp, "name" | "color" | "iconPath" | "imageUrl"> }) {
  const ink = inkOn(app.color);
  if (app.imageUrl) return <img class="logo-img" src={app.imageUrl} alt="" draggable={false} />;
  if (app.iconPath) {
    return (
      <svg class="logo-svg" viewBox="0 0 24 24" aria-hidden="true" style={cssVars({ color: ink })}>
        <path d={app.iconPath} fill="currentColor" />
      </svg>
    );
  }
  return (
    <span class="wordmark" style={cssVars({ color: ink, fontSize: `${wordmarkSize(app.name)}rem` })}>
      {app.name}
    </span>
  );
}
