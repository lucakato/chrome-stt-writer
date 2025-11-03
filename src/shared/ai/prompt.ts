import {
  COMPOSE_RESPONSE_SCHEMA,
  ComposeDraftResult,
  coerceComposeDraft,
  createFallbackDraft
} from '@shared/compose';

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

type ComposePromptBaseRequest = {
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
  responseConstraint?: Record<string, unknown>;
  omitResponseConstraintInput?: boolean;
};

type ComposePromptInternalRequest = ComposePromptBaseRequest & {
  userContent: PromptContentPart[];
};

export type ComposeFromAudioRequest = ComposePromptBaseRequest & {
  audio: ArrayBuffer | Blob;
};

export type ComposeFromTextRequest = ComposePromptBaseRequest & {
  text: string;
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

function extractPromptResultPayload(result: LanguageModelPromptResult | null | undefined): unknown {
  if (!result) {
    return undefined;
  }
  if (typeof result.output !== 'undefined') {
    return result.output;
  }
  if (typeof result.response !== 'undefined') {
    return result.response;
  }
  if (Array.isArray(result.candidates) && result.candidates.length > 0) {
    const candidate = result.candidates.find(
      (entry) => typeof entry.content === 'string' && entry.content.trim().length > 0
    );
    if (candidate) {
      return candidate.content;
    }
  }
  return undefined;
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

const COMPOSE_STRUCTURED_GUIDANCE =
  'Populate the JSON response fields exactly as follows: `subject` must always be a concise subject line (never omit it—craft one even if the user does not mention it). `paragraphs` must be an ordered array covering greeting, body sections, sign-off, and signature as separate entries with no blank strings. `content` must join those paragraphs using double newline characters so each appears on its own line when inserted. Do not include meta commentary or any fields outside this schema.';

async function runComposePrompt({
  userContent,
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
  monitor,
  responseConstraint,
  omitResponseConstraintInput
}: ComposePromptInternalRequest): Promise<ComposeDraftResult> {
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
    const combinedUserContent: PromptContentPart[] = [];
    const trimmedInstruction = instruction?.trim();
    if (trimmedInstruction) {
      combinedUserContent.push({ type: 'text', value: trimmedInstruction });
    }
    combinedUserContent.push(...userContent);

    const structuredSystemPrompt = [systemPrompt, COMPOSE_STRUCTURED_GUIDANCE]
      .map((segment) => (typeof segment === 'string' ? segment.trim() : ''))
      .filter((segment) => segment.length > 0)
      .join('\n\n');

    const messages: PromptMessage[] = [
      {
        role: 'system',
        content: [{ type: 'text', value: structuredSystemPrompt }]
      },
      {
        role: 'user',
        content: combinedUserContent
      }
    ];

    const constraint = responseConstraint ?? COMPOSE_RESPONSE_SCHEMA;
    const promptOptions: LanguageModelPromptOptions = {
      signal,
      responseConstraint: constraint,
      omitResponseConstraintInput: omitResponseConstraintInput ?? true
    };

    let fallbackRaw = '';

    if (typeof resolvedSession.promptStreaming === 'function') {
      try {
        const stream = resolvedSession.promptStreaming(messages, promptOptions);
        let aggregated = '';
        for await (const chunk of stream) {
          const piece = extractChunkText(chunk);
          if (!piece) {
            continue;
          }
          aggregated += piece;
          fallbackRaw = aggregated;
          onChunk?.(aggregated);
        }

        if (aggregated.trim().length > 0) {
          const draft = coerceComposeDraft(aggregated);
          if (draft) {
            console.info('[Ekko] Prompt API structured compose result (streaming)', {
              draft,
              raw: aggregated
            });
            onChunk?.(draft.content);
            return draft;
          }
          const fallbackDraft = createFallbackDraft(aggregated);
          console.info('[Ekko] Prompt API compose fallback (streaming aggregate)', {
            draft: fallbackDraft,
            raw: aggregated
          });
          onChunk?.(fallbackDraft.content);
          return fallbackDraft;
        }
      } catch (streamError) {
        if (streamError instanceof DOMException && streamError.name === 'AbortError') {
          throw streamError;
        }
        console.warn('Prompt streaming failed, falling back to non-streaming mode', streamError);
      }
    }

    const result = await resolvedSession.prompt(messages, promptOptions);
    const payload = extractPromptResultPayload(result);

    if (typeof payload !== 'undefined') {
      const rawString = typeof payload === 'string' ? payload : JSON.stringify(payload);
      fallbackRaw = rawString;
      const draft = coerceComposeDraft(payload);
      if (draft) {
        console.info('[Ekko] Prompt API structured compose result', { draft, raw: rawString });
        onChunk?.(draft.content);
        return draft;
      }

      if (typeof payload === 'string' && payload.trim().length > 0) {
        const fallbackDraft = createFallbackDraft(payload);
        console.info('[Ekko] Prompt API compose fallback (string payload)', {
          payload,
          draft: fallbackDraft
        });
        onChunk?.(fallbackDraft.content);
        return fallbackDraft;
      }
    }

    if (fallbackRaw.trim().length > 0) {
      const fallbackDraft = createFallbackDraft(fallbackRaw);
      console.info('[Ekko] Prompt API compose fallback (aggregated raw)', {
        raw: fallbackRaw,
        draft: fallbackDraft
      });
      onChunk?.(fallbackDraft.content);
      return fallbackDraft;
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
  monitor,
  responseConstraint,
  omitResponseConstraintInput
}: ComposeFromAudioRequest): Promise<ComposeDraftResult> {
  return runComposePrompt({
    userContent: [{ type: 'audio', value: audio }],
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
    monitor,
    responseConstraint,
    omitResponseConstraintInput
  });
}

export async function composeFromText({
  text,
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
  monitor,
  responseConstraint,
  omitResponseConstraintInput
}: ComposeFromTextRequest): Promise<ComposeDraftResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Cannot compose from empty text.');
  }

  const defaultInputs =
    expectedInputs ?? [{ type: 'text', languages: outputLanguage ? [outputLanguage] : undefined }];

  return runComposePrompt({
    userContent: [{ type: 'text', value: trimmed }],
    systemPrompt,
    instruction,
    expectedInputs: defaultInputs,
    expectedOutputs,
    temperature,
    topK,
    outputLanguage,
    onChunk,
    onStatusChange,
    signal,
    session,
    monitor,
    responseConstraint,
    omitResponseConstraintInput
  });
}

export const TRANSCRIBE_STRUCTURED_SYSTEM_PROMPT =
  'You help users turn dictated email text into a finished draft. Keep the user’s intent and wording, organize it into clear paragraphs, and always produce a concise subject line. Do not add extra commentary.';
