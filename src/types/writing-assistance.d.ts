export {};

declare global {
  type SummarizerAvailabilityValue =
    | 'unavailable'
    | 'no'
    | 'downloadable'
    | 'after-download'
    | 'readily'
    | 'available'
    | 'ready'
    | string;

  interface SummarizerOptions {
    context?: string;
    type?: string;
    length?: string;
    format?: string;
    signal?: AbortSignal;
    outputLanguage?: string;
  }

  interface SummarizerDownloadProgressEvent extends Event {
    loaded: number;
  }

  interface SummarizerMonitor extends EventTarget {
    addEventListener(
      type: 'downloadprogress',
      listener: (event: SummarizerDownloadProgressEvent) => void,
      options?: AddEventListenerOptions | boolean
    ): void;
  }

  interface SummarizerCreateOptions extends SummarizerOptions {
    monitor?: (monitor: SummarizerMonitor) => void;
  }

  interface SummarizerHandle {
    summarize(text: string, options?: SummarizerOptions): Promise<string>;
    summarizeStreaming?(text: string, options?: SummarizerOptions): AsyncIterable<string>;
    destroy?(): void;
  }

  interface SummarizerNamespace {
    availability(): Promise<
      | SummarizerAvailabilityValue
      | { availability?: SummarizerAvailabilityValue; available?: SummarizerAvailabilityValue }
    >;
    create(options?: SummarizerCreateOptions): Promise<SummarizerHandle>;
  }

  interface ChromeAISummarizerNamespace extends SummarizerNamespace {}

  interface Window {
    Summarizer?: SummarizerNamespace;
  }

  const Summarizer: SummarizerNamespace;

  interface NavigatorUADataBrandVersion {
    brand: string;
    version: string;
  }

  interface NavigatorUAData {
    brands: NavigatorUADataBrandVersion[];
  }

  interface Navigator {
    userActivation: {
      isActive: boolean;
    };
    userAgentData?: NavigatorUAData;
  }

  interface Chrome {
    ai?: {
      summarizer?: ChromeAISummarizerNamespace;
    };
  }
}
