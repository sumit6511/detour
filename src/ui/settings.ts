export type ThemeChoice = "system" | "light" | "dark";

export interface Settings {
  sound: boolean;
  routes: boolean;
  coords: boolean;
  theme: ThemeChoice;
}

export const DEFAULT_SETTINGS: Settings = {
  sound: true,
  routes: true,
  coords: true,
  theme: "system",
};

export function isSettings(value: unknown): boolean {
  const s = value as Partial<Settings> | null;
  return (
    !!s &&
    typeof s.sound === "boolean" &&
    typeof s.routes === "boolean" &&
    typeof s.coords === "boolean" &&
    (s.theme === "system" || s.theme === "light" || s.theme === "dark")
  );
}

let appliedByUs = false;

/**
 * An explicit choice sets data-theme on the root element. "System" only clears the attribute if
 * this app set it, so a host page's own theme choice is never overridden.
 */
export function applyTheme(theme: ThemeChoice) {
  const root = document.documentElement;
  if (theme === "system") {
    if (appliedByUs) root.removeAttribute("data-theme");
    appliedByUs = false;
    return;
  }
  root.setAttribute("data-theme", theme);
  appliedByUs = true;
}
