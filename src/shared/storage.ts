export type TranscriptAction = 'Summarized' | 'Rewritten' | 'Captured' | 'Composed';

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
  compositions?: Array<{
    id: string;
    preset: string;
    instructions?: string;
    content: string;
    createdAt: number;
  }>;
  actions: TranscriptAction[];
  tag?: string;
  sourceUrl?: string;
};

const STORAGE_KEY = 'ekko:sessions';
const ACTIVE_SESSION_KEY = 'ekko:activeSessionId';

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

let activeSessionId: string | null = null;
let activeSessionLoaded = false;

async function ensureActiveSessionLoaded() {
  if (activeSessionLoaded) {
    return activeSessionId;
  }

  if (!chrome.storage?.local) {
    activeSessionLoaded = true;
    activeSessionId = null;
    return activeSessionId;
  }

  const record = await chrome.storage.local.get(ACTIVE_SESSION_KEY);
  const storedId = record[ACTIVE_SESSION_KEY];
  activeSessionId = typeof storedId === 'string' ? storedId : null;
  activeSessionLoaded = true;
  return activeSessionId;
}

function persistActiveSession(id: string | null) {
  if (!chrome.storage?.local) {
    return;
  }

  if (id) {
    chrome.storage.local.set({ [ACTIVE_SESSION_KEY]: id }).catch(() => {
      /* noop */
    });
  } else {
    chrome.storage.local.remove(ACTIVE_SESSION_KEY).catch(() => {
      /* noop */
    });
  }
}

export async function upsertTranscript(transcript: string, metadata: Partial<TranscriptSession> = {}) {
  const sessions = await readSessions();
  await ensureActiveSessionLoaded();
  let currentId: string;

  if (metadata.id) {
    currentId = metadata.id;
    activeSessionId = metadata.id;
    persistActiveSession(activeSessionId);
  } else {
    const normalized = transcript.trim();

    let candidateId: string | null = activeSessionId;

    if (!candidateId && sessions.length > 0) {
      candidateId = sessions[0].id;
    }

    if (normalized.length === 0) {
      currentId = crypto.randomUUID();
    } else if (candidateId && sessions.some((entry) => entry.id === candidateId)) {
      currentId = candidateId;
    } else if (sessions.length > 0) {
      currentId = sessions[0].id;
    } else {
      currentId = crypto.randomUUID();
    }

    activeSessionId = currentId;
    persistActiveSession(activeSessionId);
  }
  const now = Date.now();
  const existing = sessions.find((entry) => entry.id === currentId);

  let combinedActions = [...(existing?.actions ?? []), ...(metadata.actions ?? [])];

  if (combinedActions.length === 0) {
    combinedActions = ['Captured'];
  } else if (!combinedActions.includes('Captured')) {
    combinedActions = ['Captured', ...combinedActions];
  }

  const dedupedActions = combinedActions.filter((action, index) => combinedActions.indexOf(action) === index);

  const updated: TranscriptSession = {
    id: currentId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    transcript,
    summary: metadata.summary ?? existing?.summary,
    rewrites: metadata.rewrites ?? existing?.rewrites,
    compositions: metadata.compositions ?? existing?.compositions,
    actions: dedupedActions,
    tag: metadata.tag ?? existing?.tag,
    sourceUrl: metadata.sourceUrl ?? existing?.sourceUrl
  };

  await saveSession(updated);
  return updated;
}
