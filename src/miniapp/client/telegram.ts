/** The parts of Telegram's Mini App API this app uses (core.telegram.org/bots/webapps). */

export interface TelegramButton {
  show(): void;
  hide(): void;
  onClick(callback: () => void): void;
  offClick(callback: () => void): void;
}

export interface TelegramMainButton extends TelegramButton {
  setText(text: string): void;
  enable(): void;
  disable(): void;
  showProgress(leaveActive?: boolean): void;
  hideProgress(): void;
}

export interface TelegramWebApp {
  initData: string;
  version: string;
  colorScheme: "light" | "dark";
  themeParams: Record<string, string | undefined>;
  ready(): void;
  expand(): void;
  isVersionAtLeast(version: string): boolean;
  openLink(url: string): void;
  onEvent(event: "themeChanged", callback: () => void): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  setBottomBarColor?(color: string): void;
  disableVerticalSwipes?(): void;
  enableVerticalSwipes?(): void;
  BackButton: TelegramButton;
  MainButton: TelegramMainButton;
  HapticFeedback?: {
    impactOccurred(style: "light" | "medium" | "heavy" | "rigid" | "soft"): void;
    notificationOccurred(type: "error" | "success" | "warning"): void;
    selectionChanged(): void;
  };
  showConfirm?(message: string, callback: (confirmed: boolean) => void): void;
}

export function telegram(): TelegramWebApp | null {
  const w = window as unknown as { Telegram?: { WebApp?: TelegramWebApp } };
  return w.Telegram?.WebApp ?? null;
}

/** Telegram methods newer than the client are skipped rather than called. */
export function supports(version: string): boolean {
  return telegram()?.isVersionAtLeast(version) ?? false;
}

let mainHandler: (() => void) | null = null;

/**
 * Puts one action on Telegram's main button (under the thumb), or hides it
 * with `null`. Returns false outside Telegram, where the page shows its own
 * button instead.
 */
export function mainButton(text: string | null, onClick?: () => void): boolean {
  const main = telegram()?.MainButton;
  if (!main) return false;
  if (mainHandler) main.offClick(mainHandler);
  mainHandler = null;
  if (text === null || !onClick) {
    main.hide();
    return true;
  }
  mainHandler = onClick;
  main.setText(text);
  main.onClick(onClick);
  main.enable();
  main.show();
  return true;
}

export function haptic(kind: "tap" | "select" | "success" | "error"): void {
  const feedback = telegram()?.HapticFeedback;
  if (!feedback) return;
  if (kind === "tap") feedback.impactOccurred("light");
  else if (kind === "select") feedback.selectionChanged();
  else feedback.notificationOccurred(kind);
}

/** Stops Telegram's swipe-down-to-close while a sideways drag is in progress. */
export function verticalSwipes(enabled: boolean): void {
  const tg = telegram();
  if (!tg || !supports("7.7")) return;
  if (enabled) tg.enableVerticalSwipes?.();
  else tg.disableVerticalSwipes?.();
}
