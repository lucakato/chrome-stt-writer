export type TranscriptAction = 'Summarized' | 'Rewritten' | 'Captured';

export type TranscriptSession = {
  id: string;
  createdAt: number;
  updatedAt: number;
  transcript: string;
  summary?: string;
  rewrites?: Array<{
    id: string;
    preset: string;
    content: string;
    createdAt: number;
  }>;
  actions: TranscriptAction[];
  tag?: string;
  sourceUrl?: string;
};

const STORAGE_KEY = 'ekko:sessions';

async function readSessions(): Promise<TranscriptSession[]> {
  if (!chrome.storage?.local) {
    console.warn('chrome.storage.local unavailable; returning empty history');
    return [];
  }
  const record = await chrome.storage.local.get(STORAGE_KEY);
  return (record[STORAGE_KEY] as TranscriptSession[]) ?? [];
}

async function writeSessions(next: TranscriptSession[]) {
  if (!chrome.storage?.local) {
    console.warn('chrome.storage.local unavailable; skipping persistence');
    return;
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
}

export async function listSessions() {
  return readSessions();
}

export async function saveSession(session: TranscriptSession) {
  const sessions = await readSessions();
  const existingIndex = sessions.findIndex((entry) => entry.id === session.id);

  if (existingIndex >= 0) {
    sessions[existingIndex] = session;
  } else {
    sessions.unshift(session);
  }

  await writeSessions(sessions);
}

export async function upsertTranscript(transcript: string, metadata: Partial<TranscriptSession> = {}) {
  const sessions = await readSessions();
  const currentId = metadata.id ?? sessions[0]?.id ?? crypto.randomUUID();
  const now = Date.now();
  const existing = sessions.find((entry) => entry.id === currentId);

  const updated: TranscriptSession = {
    id: currentId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    transcript,
    summary: metadata.summary ?? existing?.summary,
    rewrites: metadata.rewrites ?? existing?.rewrites,
    actions: metadata.actions ?? existing?.actions ?? ['Captured'],
    tag: metadata.tag ?? existing?.tag,
    sourceUrl: metadata.sourceUrl ?? existing?.sourceUrl
  };

  await saveSession(updated);
  return updated;
}
