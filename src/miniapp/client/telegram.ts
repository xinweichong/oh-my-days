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
  BackButton: TelegramButton;
  MainButton: TelegramMainButton;
  HapticFeedback?: {
    notificationOccurred(type: "error" | "success" | "warning"): void;
    selectionChanged(): void;
  };
  showConfirm?(message: string, callback: (confirmed: boolean) => void): void;
}

export function telegram(): TelegramWebApp | null {
  const w = window as unknown as { Telegram?: { WebApp?: TelegramWebApp } };
  return w.Telegram?.WebApp ?? null;
}
