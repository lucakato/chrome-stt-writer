type Provider = 'chrome' | 'standard';

export type SummarizerAvailabilityStatus = 'unsupported' | 'unavailable' | 'downloadable' | 'ready' | 'error';

export type SummarizerAvailability = {
  status: SummarizerAvailabilityStatus;
  message?: string;
  provider?: Provider;
  raw?: unknown;
};

export type SummarizeRequest = {
  text: string;
  context?: string;
  type?: string;
  length?: string;
  format?: string;
  outputLanguage?: string;
  onDownloadProgress?: (progress: number) => void;
  onStatusChange?: (status: SummarizerAvailabilityStatus) => void;
  onChunk?: (chunk: string) => void;
};

export type SummarizeResponse = {
  summary: string;
  provider: Provider;
};

type SummarizerNamespaceLike = SummarizerNamespace & {
  availability(): Promise<unknown>;
  create(options?: SummarizerCreateOptions): Promise<SummarizerHandle>;
};

type SummarizerDetection = {
  provider: Provider;
  api: SummarizerNamespaceLike;
};

let cachedDetection: SummarizerDetection | null = null;
let summarizerInstance: SummarizerHandle | null = null;
let creationPromise: Promise<SummarizerHandle> | null = null;

function detectSummarizer(): SummarizerDetection | null {
  if (cachedDetection) {
    return cachedDetection;
  }

  const chromeSummarizer =
    typeof chrome !== 'undefined'
      ? (chrome as unknown as { ai?: { summarizer?: SummarizerNamespaceLike } }).ai?.summarizer
      : undefined;
  if (chromeSummarizer) {
    cachedDetection = { provider: 'chrome', api: chromeSummarizer as SummarizerNamespaceLike };
    return cachedDetection;
  }

  const globalSummarizer =
    typeof globalThis !== 'undefined'
      ? (globalThis as unknown as { Summarizer?: SummarizerNamespaceLike }).Summarizer
      : undefined;
  if (globalSummarizer) {
    cachedDetection = { provider: 'standard', api: globalSummarizer as SummarizerNamespaceLike };
    return cachedDetection;
  }

  return null;
}

function normalizeAvailability(raw: unknown): SummarizerAvailabilityStatus {
  if (raw == null) {
    return 'unavailable';
  }

  let value: string;

  if (typeof raw === 'string') {
    value = raw;
  } else if (typeof raw === 'object') {
    const candidate = (raw as Record<string, unknown>).availability ??
      (raw as Record<string, unknown>).available ??
      (raw as Record<string, unknown>).state ??
      (raw as Record<string, unknown>).status;
    value = typeof candidate === 'string' ? candidate : '';
  } else {
    value = String(raw);
  }

  const normalized = value.toLowerCase();

  if (!normalized) {
    return 'unavailable';
  }

  if (normalized.includes('no') || normalized.includes('unavailable')) {
    return 'unavailable';
  }

  if (normalized.includes('download')) {
    return 'downloadable';
  }

  if (normalized.includes('ready') || normalized.includes('available')) {
    return 'ready';
  }

  return 'unavailable';
}

export async function getSummarizerAvailability(): Promise<SummarizerAvailability> {
  const detection = detectSummarizer();
  if (!detection) {
    return {
      status: 'unsupported',
      message: 'Summarizer API is not available in this version of Chrome.',
      raw: null
    };
  }

  try {
    const raw = await detection.api.availability();
    const status = normalizeAvailability(raw);
    let message: string | undefined;

    if (status === 'unavailable') {
      message = 'Summarizer API is currently unavailable on this device.';
    } else if (status === 'downloadable') {
      message = 'Summarizer model needs to download before use.';
    }

    return {
      status,
      provider: detection.provider,
      message,
      raw
    };
  } catch (error) {
    return {
      status: 'error',
      provider: detection.provider,
      message: error instanceof Error ? error.message : 'Unknown Summarizer API error',
      raw: error
    };
  }
}

function ensureUserActivation() {
  if (typeof navigator !== 'undefined' && navigator.userActivation && !navigator.userActivation.isActive) {
    throw new Error('Summarizer requires a user activation. Trigger summarization from a user gesture.');
  }
}

async function createSummarizer(onDownloadProgress?: (progress: number) => void, onStatusChange?: (status: SummarizerAvailabilityStatus) => void) {
  const detection = detectSummarizer();
  if (!detection) {
    throw new Error('Summarizer API is not supported in this environment.');
  }

  if (summarizerInstance) {
    return summarizerInstance;
  }

  if (creationPromise) {
    return creationPromise;
  }

  ensureUserActivation();

  onStatusChange?.('downloadable');

  creationPromise = detection.api.create({
    monitor: (monitor) => {
      if (!onDownloadProgress) {
        return;
      }
      monitor.addEventListener('downloadprogress', (event: SummarizerDownloadProgressEvent) => {
        onDownloadProgress(Math.min(Math.max(event.loaded, 0), 1));
      });
    }
  });

  try {
    summarizerInstance = await creationPromise;
    onStatusChange?.('ready');
    return summarizerInstance;
  } finally {
    creationPromise = null;
  }
}

function getSummarizerOptions(options: SummarizeRequest): SummarizerOptions {
  return {
    context: options.context,
    type: options.type ?? 'key-points',
    length: options.length ?? 'medium',
    format: options.format ?? 'markdown',
    outputLanguage: options.outputLanguage
  };
}

export async function summarizeText(options: SummarizeRequest): Promise<SummarizeResponse> {
  if (!options.text.trim()) {
    throw new Error('Cannot summarize empty text.');
  }

  const availability = await getSummarizerAvailability();

  if (availability.status === 'unsupported') {
    throw new Error('Summarizer API is not supported on this device.');
  }

  if (availability.status === 'unavailable') {
    throw new Error(availability.message ?? 'Summarizer API is unavailable right now.');
  }

  const summarizer = await createSummarizer(options.onDownloadProgress, options.onStatusChange);
  const provider = detectSummarizer()?.provider ?? 'standard';

  const summarizerOptions = getSummarizerOptions(options);

  const supportsStreaming = typeof summarizer.summarizeStreaming === 'function';

  if (supportsStreaming && options.onChunk) {
    const stream = await summarizer.summarizeStreaming!(options.text, summarizerOptions);
    let assembled = '';
    for await (const chunk of stream) {
      assembled += chunk;
      options.onChunk?.(assembled);
    }
    if (!assembled) {
      const summary = await summarizer.summarize(options.text, summarizerOptions);
      options.onChunk?.(summary);
      return { summary, provider };
    }
    return { summary: assembled, provider };
  }

  const summary = await summarizer.summarize(options.text, summarizerOptions);
  options.onChunk?.(summary);
  return { summary, provider };
}

export function resetSummarizerCache() {
  if (typeof summarizerInstance?.destroy === 'function') {
    summarizerInstance.destroy();
  }
  summarizerInstance = null;
  creationPromise = null;
  cachedDetection = null;
}
