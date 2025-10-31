export type EchoMode = 'transcribe' | 'compose';

export type EchoSettings = {
  floatingWidgetEnabled: boolean;
  mode: EchoMode;
  composePrompt: string;
};

const WIDGET_KEY = 'ekko:floatingWidgetEnabled';
const MODE_KEY = 'ekko:mode';
const PROMPT_KEY = 'ekko:composePrompt';

export const DEFAULT_SETTINGS: EchoSettings = {
  floatingWidgetEnabled: true,
  mode: 'transcribe',
  composePrompt: ''
};

export async function getEchoSettings(): Promise<EchoSettings> {
  const [widget, mode, prompt] = await Promise.all([
    chrome.storage.local.get(WIDGET_KEY),
    chrome.storage.local.get(MODE_KEY),
    chrome.storage.local.get(PROMPT_KEY)
  ]);

  const floatingWidgetEnabled = widget[WIDGET_KEY];
  const storedMode = mode[MODE_KEY];
  const storedPrompt = prompt[PROMPT_KEY];

  return {
    floatingWidgetEnabled:
      typeof floatingWidgetEnabled === 'boolean' ? floatingWidgetEnabled : DEFAULT_SETTINGS.floatingWidgetEnabled,
    mode: storedMode === 'compose' || storedMode === 'transcribe' ? storedMode : DEFAULT_SETTINGS.mode,
    composePrompt: typeof storedPrompt === 'string' ? storedPrompt : DEFAULT_SETTINGS.composePrompt
  };
}

export async function setEchoSettings(partial: Partial<EchoSettings>): Promise<EchoSettings> {
  const tasks: Promise<unknown>[] = [];

  if (partial.floatingWidgetEnabled !== undefined) {
    tasks.push(chrome.storage.local.set({ [WIDGET_KEY]: partial.floatingWidgetEnabled }));
  }

  if (partial.mode !== undefined) {
    tasks.push(chrome.storage.local.set({ [MODE_KEY]: partial.mode }));
  }

  if (partial.composePrompt !== undefined) {
    tasks.push(chrome.storage.local.set({ [PROMPT_KEY]: partial.composePrompt }));
  }

  await Promise.all(tasks);

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
