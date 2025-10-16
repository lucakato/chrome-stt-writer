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

  interface RewriterDownloadProgressEvent extends Event {
    loaded: number;
    total?: number;
  }

  interface SummarizerMonitor extends EventTarget {
    addEventListener(
      type: 'downloadprogress',
      listener: (event: SummarizerDownloadProgressEvent) => void,
      options?: AddEventListenerOptions | boolean
    ): void;
  }

  interface RewriterMonitor extends EventTarget {
    addEventListener(
      type: 'downloadprogress',
      listener: (event: RewriterDownloadProgressEvent) => void,
      options?: AddEventListenerOptions | boolean
    ): void;
  }

  interface SummarizerCreateOptions extends SummarizerOptions {
    monitor?: (monitor: SummarizerMonitor) => void;
  }

  interface RewriterOptions {
    context?: string | null;
    tone?: 'more-formal' | 'more-casual' | 'more-direct' | 'more-confident' | 'more-empathetic' | 'more-enthusiastic' | string;
    format?: 'plain-text' | 'bullet' | 'email' | string;
    length?: 'shorter' | 'longer' | string;
    outputLanguage?: string | null;
  }

  interface RewriterCreateOptions extends RewriterOptions {
    sharedContext?: string | null;
    monitor?: (monitor: RewriterMonitor) => void;
  }

  interface RewriterHandle {
    rewrite(text: string, options?: RewriterOptions): Promise<string>;
    rewriteStreaming?(text: string, options?: RewriterOptions): Promise<AsyncIterable<string>> | AsyncIterable<string>;
    destroy?(): void;
  }

  interface RewriterNamespace {
    availability(): Promise<
      | SummarizerAvailabilityValue
      | { availability?: SummarizerAvailabilityValue; available?: SummarizerAvailabilityValue }
    >;
    create(options?: RewriterCreateOptions): Promise<RewriterHandle>;
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
  interface ChromeAIRewriterNamespace extends RewriterNamespace {}

  interface Window {
    Summarizer?: SummarizerNamespace;
    Rewriter?: RewriterNamespace;
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
      rewriter?: ChromeAIRewriterNamespace;
    };
  }
}
