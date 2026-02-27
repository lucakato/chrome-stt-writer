export type EchoMode = 'transcribe' | 'compose';

export type EchoSettings = {
  floatingWidgetEnabled: boolean;
  mode: EchoMode;
  composePrompt: string;
};

const WIDGET_KEY = 'echo:floatingWidgetEnabled';
const MODE_KEY = 'echo:mode';
const PROMPT_KEY = 'echo:composePrompt';

export const DEFAULT_SETTINGS: EchoSettings = {
  floatingWidgetEnabled: true,
  mode: 'transcribe',
  composePrompt: ''
};

export async function getEchoSettings(): Promise<EchoSettings> {
  const record = await chrome.storage.local.get([WIDGET_KEY, MODE_KEY, PROMPT_KEY]);

  const floatingWidgetEnabled = record[WIDGET_KEY];
  const storedMode = record[MODE_KEY];
  const storedPrompt = record[PROMPT_KEY];

  return {
    floatingWidgetEnabled:
      typeof floatingWidgetEnabled === 'boolean' ? floatingWidgetEnabled : DEFAULT_SETTINGS.floatingWidgetEnabled,
    mode: storedMode === 'compose' || storedMode === 'transcribe' ? storedMode : DEFAULT_SETTINGS.mode,
    composePrompt: typeof storedPrompt === 'string' ? storedPrompt : DEFAULT_SETTINGS.composePrompt
  };
}

export async function setEchoSettings(partial: Partial<EchoSettings>): Promise<EchoSettings> {
  const updates: Record<string, EchoSettings[keyof EchoSettings]> = {};

  if (partial.floatingWidgetEnabled !== undefined) {
    updates[WIDGET_KEY] = partial.floatingWidgetEnabled;
  }

  if (partial.mode !== undefined) {
    updates[MODE_KEY] = partial.mode;
  }

  if (partial.composePrompt !== undefined) {
    updates[PROMPT_KEY] = partial.composePrompt;
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }

  return getEchoSettings();
}

export type EchoSettingsChange = Partial<Record<keyof EchoSettings, boolean>>;

export function observeEchoSettings(callback: (settings: EchoSettings, changed: EchoSettingsChange) => void): () => void {
  const listener = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: 'local' | 'sync' | 'managed') => {
    if (areaName !== 'local') {
      return;
    }

    const changed: EchoSettingsChange = {};

    if (WIDGET_KEY in changes) {
      changed.floatingWidgetEnabled = true;
    }

    if (MODE_KEY in changes) {
      changed.mode = true;
    }

    if (PROMPT_KEY in changes) {
      changed.composePrompt = true;
    }

    if (changed.floatingWidgetEnabled || changed.mode || changed.composePrompt) {
      void getEchoSettings()
        .then((value) => callback(value, changed))
        .catch(() => {
          /* ignore */
        });
    }
  };

  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
