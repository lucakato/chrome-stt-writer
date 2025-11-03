const ONBOARDING_KEY = 'ekko:onboarding';

type OnboardingState = {
  microphoneAccepted: boolean;
};

const defaultState: OnboardingState = {
  microphoneAccepted: false
};

export async function readOnboardingState(): Promise<OnboardingState> {
  if (!chrome.storage?.local) {
    return defaultState;
  }

  const record = await chrome.storage.local.get(ONBOARDING_KEY);
  return { ...defaultState, ...(record[ONBOARDING_KEY] as OnboardingState | undefined) };
}

export async function updateOnboardingState(patch: Partial<OnboardingState>) {
  if (!chrome.storage?.local) {
    return;
  }

  const current = await readOnboardingState();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [ONBOARDING_KEY]: next });
}
