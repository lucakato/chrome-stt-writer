export {};

declare global {
  type LanguageModelAvailabilityValue =
    | 'unavailable'
    | 'available'
    | 'ready'
    | 'downloadable'
    | 'unsupported'
    | string;

  type PromptRole = 'system' | 'user' | 'assistant';

  type PromptContentPart =
    | string
    | {
        type: 'text' | 'audio' | 'image';
        value: string | ArrayBuffer | Blob;
      };

  interface PromptMessage {
    role: PromptRole;
    content: PromptContentPart | PromptContentPart[];
    prefix?: boolean;
  }

  interface LanguageModelMonitorEventMap {
    downloadprogress: CustomEvent<{ loaded: number; total?: number }>;
  }

  interface LanguageModelMonitor extends EventTarget {
    addEventListener<K extends keyof LanguageModelMonitorEventMap>(
      type: K,
      listener: (event: LanguageModelMonitorEventMap[K]) => void,
      options?: AddEventListenerOptions | boolean
    ): void;
  }

  interface LanguageModelModalityDescriptor {
    type: 'text' | 'image' | 'audio';
    languages?: string[];
  }

  interface LanguageModelCreateOptions {
    expectedInputs?: LanguageModelModalityDescriptor[];
    expectedOutputs?: LanguageModelModalityDescriptor[];
    temperature?: number;
    topK?: number;
    topP?: number;
    initialPrompts?: PromptMessage[];
    monitor?: (monitor: LanguageModelMonitor) => void;
    signal?: AbortSignal;
  }

  interface LanguageModelAvailabilityOptions {
    expectedInputs?: LanguageModelModalityDescriptor[];
    expectedOutputs?: LanguageModelModalityDescriptor[];
  }

  type LanguageModelStreamingChunk =
    | string
    | {
        type?: string;
        text?: string;
        output?: string;
        content?: string;
      };

  interface LanguageModelPromptResult {
    output?: string;
    response?: string;
    candidates?: Array<{ content: string }>;
  }

  interface LanguageModelSession {
    prompt(messages: PromptMessage[], options?: { signal?: AbortSignal }): Promise<LanguageModelPromptResult>;
    promptStreaming(messages: PromptMessage[], options?: { signal?: AbortSignal }): AsyncIterable<LanguageModelStreamingChunk>;
    append?(messages: PromptMessage[]): Promise<void>;
    destroy?(): void;
    close?(): void;
  }

  interface LanguageModelStatic {
    availability(options?: LanguageModelAvailabilityOptions): Promise<LanguageModelAvailabilityValue | Record<string, unknown>>;
    create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>;
    params(): Promise<Record<string, number | string | undefined>>;
  }

  interface ChromeAILanguageModelNamespace extends LanguageModelStatic {}

  interface Chrome {
    ai?: {
      languageModel?: ChromeAILanguageModelNamespace;
    };
  }

  const LanguageModel: LanguageModelStatic;
}
