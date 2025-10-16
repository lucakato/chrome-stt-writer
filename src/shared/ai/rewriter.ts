type Provider = 'chrome' | 'standard';

export type RewriterAvailabilityStatus = 'unsupported' | 'unavailable' | 'downloadable' | 'ready' | 'error';

export type RewriterAvailability = {
  status: RewriterAvailabilityStatus;
  message?: string;
  provider?: Provider;
  raw?: unknown;
};

export type RewriteRequest = {
  text: string;
  sharedContext?: string;
  context?: string;
  tone?: string;
  format?: string;
  length?: string;
  outputLanguage?: string;
  onDownloadProgress?: (progress: number) => void;
  onStatusChange?: (status: RewriterAvailabilityStatus) => void;
  onChunk?: (chunk: string) => void;
};

export type RewriteResponse = {
  content: string;
  provider: Provider;
};

type RewriterNamespaceLike = RewriterNamespace & {
  availability(options?: RewriterAvailabilityOptions): Promise<unknown>;
  create(options?: RewriterCreateOptions): Promise<RewriterHandle>;
};

type RewriterDetection = {
  provider: Provider;
  api: RewriterNamespaceLike;
};

let cachedDetection: RewriterDetection | null = null;
let rewriterInstance: RewriterHandle | null = null;
let creationPromise: Promise<RewriterHandle> | null = null;

function detectRewriter(): RewriterDetection | null {
  if (cachedDetection) {
    return cachedDetection;
  }

  const chromeRewriter =
    typeof chrome !== 'undefined'
      ? (chrome as unknown as { ai?: { rewriter?: RewriterNamespaceLike } }).ai?.rewriter
      : undefined;
  if (chromeRewriter) {
    cachedDetection = { provider: 'chrome', api: chromeRewriter };
    return cachedDetection;
  }

  const globalRewriter =
    typeof globalThis !== 'undefined'
      ? (globalThis as unknown as { Rewriter?: RewriterNamespaceLike }).Rewriter
      : undefined;
  if (globalRewriter) {
    cachedDetection = { provider: 'standard', api: globalRewriter };
    return cachedDetection;
  }

  return null;
}

function normalizeAvailability(raw: unknown): RewriterAvailabilityStatus {
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

export async function getRewriterAvailability(outputLanguage?: string): Promise<RewriterAvailability> {
  const detection = detectRewriter();
  if (!detection) {
    return {
      status: 'unsupported',
      message: 'Rewriter API is not available in this version of Chrome.',
      raw: null
    };
  }

  try {
    let raw: unknown;
    if (outputLanguage) {
      raw = await detection.api.availability({ outputLanguage });
    } else {
      raw = await detection.api.availability();
    }
    const status = normalizeAvailability(raw);
    let message: string | undefined;

    if (status === 'unavailable') {
      message = 'Rewriter API is currently unavailable on this device.';
    } else if (status === 'downloadable') {
      message = 'Rewriter model needs to download before use.';
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
      message: error instanceof Error ? error.message : 'Unknown Rewriter API error',
      raw: error
    };
  }
}

function ensureUserActivation() {
  if (typeof navigator !== 'undefined' && navigator.userActivation && !navigator.userActivation.isActive) {
    throw new Error('Rewriter requires a user activation. Trigger rewriting from a user gesture.');
  }
}

async function createRewriter(
  sharedContext: string | undefined,
  onDownloadProgress?: (progress: number) => void,
  onStatusChange?: (status: RewriterAvailabilityStatus) => void,
  outputLanguage?: string
) {
  const detection = detectRewriter();
  if (!detection) {
    throw new Error('Rewriter API is not supported in this environment.');
  }

  if (rewriterInstance) {
    return rewriterInstance;
  }

  if (creationPromise) {
    return creationPromise;
  }

  ensureUserActivation();

  onStatusChange?.('downloadable');

  creationPromise = detection.api.create({
    sharedContext,
    outputLanguage,
    monitor: (monitor) => {
      if (!onDownloadProgress) {
        return;
      }
      monitor.addEventListener('downloadprogress', (event: RewriterDownloadProgressEvent) => {
        onDownloadProgress(Math.min(Math.max(event.loaded, 0), 1));
      });
    }
  } as RewriterCreateOptions);

  try {
    rewriterInstance = await creationPromise;
    onStatusChange?.('ready');
    return rewriterInstance;
  } finally {
    creationPromise = null;
  }
}

function getRewriteOptions(options: RewriteRequest): RewriterOptions {
  return {
    context: options.context,
    tone: options.tone,
    format: options.format,
    length: options.length,
    outputLanguage: options.outputLanguage
  };
}

export async function rewriteText(options: RewriteRequest): Promise<RewriteResponse> {
  if (!options.text.trim()) {
    throw new Error('Cannot rewrite empty text.');
  }

  const availability = await getRewriterAvailability(options.outputLanguage);

  if (availability.status === 'unsupported') {
    throw new Error('Rewriter API is not supported on this device.');
  }

  if (availability.status === 'unavailable') {
    throw new Error(availability.message ?? 'Rewriter API is unavailable right now.');
  }

  const rewriter = await createRewriter(
    options.sharedContext,
    options.onDownloadProgress,
    options.onStatusChange,
    options.outputLanguage
  );
  const provider = detectRewriter()?.provider ?? 'standard';

  const rewriterOptions = getRewriteOptions(options);

  const supportsStreaming = typeof rewriter.rewriteStreaming === 'function';

  if (supportsStreaming && options.onChunk) {
    const stream = await rewriter.rewriteStreaming!(options.text, rewriterOptions as RewriterOptions);
    let assembled = '';
    for await (const chunk of stream as AsyncIterable<string>) {
      assembled += chunk;
      options.onChunk?.(assembled);
    }
    if (!assembled) {
      const content = await rewriter.rewrite(options.text, rewriterOptions);
      options.onChunk?.(content);
      return { content, provider };
    }
    return { content: assembled, provider };
  }

  const content = await rewriter.rewrite(options.text, rewriterOptions);
  options.onChunk?.(content);
  return { content, provider };
}

export function resetRewriterCache() {
  if (typeof rewriterInstance?.destroy === 'function') {
    rewriterInstance.destroy();
  }
  rewriterInstance = null;
  creationPromise = null;
  cachedDetection = null;
}
