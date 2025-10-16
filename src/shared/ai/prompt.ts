type PromptProvider = 'chrome' | 'standard';

export type PromptAvailabilityStatus = 'unsupported' | 'unavailable' | 'downloadable' | 'ready' | 'error';

export type PromptAvailability = {
  status: PromptAvailabilityStatus;
  provider?: PromptProvider;
  message?: string;
  raw?: unknown;
};

export type PromptAvailabilityRequest = {
  expectedInputs?: LanguageModelModalityDescriptor[];
  expectedOutputs?: LanguageModelModalityDescriptor[];
};

export type PromptSessionOptions = {
  expectedInputs?: LanguageModelModalityDescriptor[];
  expectedOutputs?: LanguageModelModalityDescriptor[];
  temperature?: number;
  topK?: number;
  outputLanguage?: string;
  onStatusChange?: (status: PromptAvailabilityStatus) => void;
  monitor?: (monitor: LanguageModelMonitor) => void;
};

export type ComposeFromAudioRequest = {
  audio: ArrayBuffer;
  systemPrompt: string;
  instruction?: string;
  expectedInputs?: LanguageModelModalityDescriptor[];
  expectedOutputs?: LanguageModelModalityDescriptor[];
  temperature?: number;
  topK?: number;
  outputLanguage?: string;
  onChunk?: (text: string) => void;
  onStatusChange?: (status: PromptAvailabilityStatus) => void;
  signal?: AbortSignal;
  session?: LanguageModelSession | null;
  monitor?: (monitor: LanguageModelMonitor) => void;
};

type DetectedLanguageModel = {
  provider: PromptProvider;
  api: LanguageModelStatic;
};

let cachedDetection: DetectedLanguageModel | null = null;

function detectLanguageModel(): DetectedLanguageModel | null {
  if (cachedDetection) {
    return cachedDetection;
  }

  if (typeof chrome !== 'undefined') {
    const aiNamespace = (chrome as unknown as { ai?: { languageModel?: ChromeAILanguageModelNamespace } }).ai;
    if (aiNamespace?.languageModel) {
      cachedDetection = { provider: 'chrome', api: aiNamespace.languageModel };
      return cachedDetection;
    }
  }

  if (typeof globalThis !== 'undefined') {
    const languageModel = (globalThis as unknown as { LanguageModel?: LanguageModelStatic }).LanguageModel;
    if (languageModel) {
      cachedDetection = { provider: 'standard', api: languageModel };
      return cachedDetection;
    }
  }

  return null;
}

function normalizeAvailability(raw: unknown): PromptAvailabilityStatus {
  if (raw == null) {
    return 'unavailable';
  }

  let candidate: string | undefined;

  if (typeof raw === 'string') {
    candidate = raw;
  } else if (typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    candidate =
      typeof record.availability === 'string'
        ? record.availability
        : typeof record.status === 'string'
        ? record.status
        : typeof record.state === 'string'
        ? record.state
        : typeof record.available === 'string'
        ? record.available
        : undefined;
  } else {
    candidate = String(raw);
  }

  if (!candidate) {
    return 'unavailable';
  }

  const normalized = candidate.toLowerCase();
  if (normalized.includes('unsupported')) {
    return 'unsupported';
  }
  if (normalized.includes('download')) {
    return 'downloadable';
  }
  if (normalized.includes('ready') || normalized.includes('available')) {
    return 'ready';
  }

  return 'unavailable';
}

export async function getPromptAvailability(options: PromptAvailabilityRequest = {}): Promise<PromptAvailability> {
  const detection = detectLanguageModel();
  if (!detection) {
    return {
      status: 'unsupported',
      message: 'Prompt API is not available in this browser.',
      raw: null
    };
  }

  try {
    const raw = await detection.api.availability({
      expectedInputs: options.expectedInputs,
      expectedOutputs: options.expectedOutputs
    });

    const status = normalizeAvailability(raw);
    let message: string | undefined;

    if (status === 'downloadable') {
      message =
        'Gemini Nano model needs to download before audio prompts can run. Start a capture to trigger the download and keep this page open.';
    } else if (status === 'unavailable') {
      message = 'Prompt API is currently unavailable on this device.';
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
      message: error instanceof Error ? error.message : 'Prompt API availability check failed.',
      raw: error
    };
  }
}

function extractChunkText(chunk: LanguageModelStreamingChunk): string {
  if (typeof chunk === 'string') {
    return chunk;
  }
  if (chunk == null || typeof chunk !== 'object') {
    return '';
  }
  if (typeof chunk.output === 'string') {
    return chunk.output;
  }
  if (typeof chunk.text === 'string') {
    return chunk.text;
  }
  if (typeof (chunk as { content?: string }).content === 'string') {
    return (chunk as { content: string }).content;
  }
  return '';
}

function normalizeSessionInputs({
  expectedInputs,
  expectedOutputs,
  outputLanguage
}: {
  expectedInputs?: LanguageModelModalityDescriptor[];
  expectedOutputs?: LanguageModelModalityDescriptor[];
  outputLanguage?: string;
}) {
  const defaultInputLanguages = outputLanguage ? [outputLanguage] : undefined;
  return {
    expectedInputs: expectedInputs ?? [{ type: 'audio', languages: defaultInputLanguages }],
    expectedOutputs: expectedOutputs ?? [{ type: 'text', languages: defaultInputLanguages }]
  };
}

export async function createPromptSession(options: PromptSessionOptions = {}): Promise<LanguageModelSession> {
  const detection = detectLanguageModel();
  if (!detection) {
    throw new Error('Prompt API is not available in this browser.');
  }

  const api = detection.api;
  const { expectedInputs, expectedOutputs } = normalizeSessionInputs(options);

  const availabilityRaw = await api.availability({
    expectedInputs,
    expectedOutputs
  });
  const availabilityStatus = normalizeAvailability(availabilityRaw);

  switch (availabilityStatus) {
    case 'ready':
      options.onStatusChange?.('ready');
      break;
    case 'downloadable':
      options.onStatusChange?.('downloadable');
      break;
    case 'unsupported':
      options.onStatusChange?.('unsupported');
      throw new Error('Prompt API audio support is not available on this device.');
    case 'unavailable':
    case 'error':
    default:
      options.onStatusChange?.(availabilityStatus);
      throw new Error(
        'Prompt API is not ready yet. Make sure the origin trial token is installed and Chrome finished downloading the on-device model.'
      );
  }

  const params = (await api.params().catch(() => ({}))) as Record<string, unknown>;
  const defaultTemperature =
    typeof params['defaultTemperature'] === 'number'
      ? (params['defaultTemperature'] as number)
      : undefined;
  const defaultTopK =
    typeof params['defaultTopK'] === 'number' ? (params['defaultTopK'] as number) : undefined;

  const hasProvidedTemperature = typeof options.temperature === 'number';
  const hasProvidedTopK = typeof options.topK === 'number';

  let temperatureOption: number | undefined;
  let topKOption: number | undefined;

  if (hasProvidedTemperature && hasProvidedTopK) {
    temperatureOption = options.temperature as number;
    topKOption = options.topK as number;
  } else if (!hasProvidedTemperature && !hasProvidedTopK) {
    if (typeof defaultTemperature === 'number' && typeof defaultTopK === 'number') {
      temperatureOption = defaultTemperature;
      topKOption = defaultTopK;
    }
  } else {
    console.warn('Prompt session requires both topK and temperature; using model defaults.');
    temperatureOption = undefined;
    topKOption = undefined;
  }

  const createOptions: LanguageModelCreateOptions = {
    expectedInputs,
    expectedOutputs
  };

  if (typeof temperatureOption === 'number' && typeof topKOption === 'number') {
    createOptions.temperature = temperatureOption;
    createOptions.topK = topKOption;
  }

  if (options.monitor) {
    createOptions.monitor = options.monitor;
  }

  try {
    const session = await api.create(createOptions);
    options.onStatusChange?.('ready');
    return session;
  } catch (error) {
    options.onStatusChange?.('error');
    throw error instanceof Error ? error : new Error('Prompt API session creation failed.');
  }
}

export async function composeFromAudio({
  audio,
  systemPrompt,
  instruction,
  expectedInputs,
  expectedOutputs,
  temperature,
  topK,
  outputLanguage,
  onChunk,
  onStatusChange,
  signal,
  session,
  monitor
}: ComposeFromAudioRequest): Promise<string> {
  const detection = detectLanguageModel();
  if (!detection) {
    throw new Error('Prompt API is not available in this browser.');
  }

  const api = detection.api;
  const { expectedInputs: normalizedInputs, expectedOutputs: normalizedOutputs } = normalizeSessionInputs({
    expectedInputs,
    expectedOutputs,
    outputLanguage
  });

  let resolvedSession = session ?? null;
  let ownsSession = false;

  if (!resolvedSession) {
    resolvedSession = await createPromptSession({
      expectedInputs: normalizedInputs,
      expectedOutputs: normalizedOutputs,
      temperature,
      topK,
      outputLanguage,
      onStatusChange,
      monitor
    });
    ownsSession = true;
  }

  try {
    const userContent: PromptContentPart[] = [];
    const trimmedInstruction = instruction?.trim();
    if (trimmedInstruction) {
      userContent.push({ type: 'text', value: trimmedInstruction });
    }
    userContent.push({ type: 'audio', value: audio });

    const messages: PromptMessage[] = [
      {
        role: 'system',
        content: [{ type: 'text', value: systemPrompt }]
      },
      {
        role: 'user',
        content: userContent
      }
    ];

    if (typeof resolvedSession.promptStreaming === 'function') {
      try {
        const stream = resolvedSession.promptStreaming(messages, { signal });
        let aggregated = '';
        for await (const chunk of stream) {
          const piece = extractChunkText(chunk);
          if (!piece) {
            continue;
          }
          aggregated += piece;
          onChunk?.(aggregated);
        }

        if (aggregated.trim().length > 0) {
          return aggregated;
        }
      } catch (streamError) {
        if (streamError instanceof DOMException && streamError.name === 'AbortError') {
          throw streamError;
        }
        console.warn('Prompt streaming failed, falling back to non-streaming mode', streamError);
      }
    }

    const result = await resolvedSession.prompt(messages, { signal });

    if (result) {
      if (typeof result.output === 'string' && result.output.trim()) {
        onChunk?.(result.output);
        return result.output;
      }
      if (typeof result.response === 'string' && result.response.trim()) {
        onChunk?.(result.response);
        return result.response;
      }
      if (Array.isArray(result.candidates) && result.candidates.length > 0) {
        const candidate = result.candidates.find((entry) => entry.content.trim().length > 0);
        if (candidate) {
          onChunk?.(candidate.content);
          return candidate.content;
        }
      }
    }

    throw new Error('Prompt API returned an empty response.');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    onStatusChange?.('error');
    throw error instanceof Error ? error : new Error('Prompt API request failed.');
  } finally {
    if (ownsSession) {
      resolvedSession?.destroy?.();
      resolvedSession?.close?.();
    }
  }
}
