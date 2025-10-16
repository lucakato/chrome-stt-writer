import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type SpeechRecorderStatus = 'idle' | 'listening' | 'stopping' | 'unsupported';

export type SpeechRecorderOptions = {
  language: string;
  autoStopMs?: number;
  onFinalResult?: (text: string) => void;
  onSegmentCaptured?: (finalSegment: string) => void;
};

type SpeechRecognitionInstance = SpeechRecognition | null;

export function useSpeechRecorder({
  language,
  autoStopMs = 3 * 60 * 1000,
  onFinalResult,
  onSegmentCaptured
}: SpeechRecorderOptions) {
  const [status, setStatus] = useState<SpeechRecorderStatus>(() =>
    typeof window === 'undefined' ||
    (!(window.SpeechRecognition || window.webkitSpeechRecognition))
      ? 'unsupported'
      : 'idle'
  );
  const [error, setError] = useState<string | null>(null);
  const [interimTranscript, setInterimTranscript] = useState('');

  const recognitionRef = useRef<SpeechRecognitionInstance>(null);
  const timerRef = useRef<number | null>(null);
  const languageRef = useRef(language);

  const isSupported = useMemo(() => status !== 'unsupported', [status]);
  const isListening = status === 'listening';

  useEffect(() => {
    languageRef.current = language;
    if (recognitionRef.current) {
      recognitionRef.current.lang = language;
    }
  }, [language]);

  const cleanupRecognition = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.onresult = null;
      recognitionRef.current.onerror = null;
      recognitionRef.current.onend = null;
      recognitionRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }
      cleanupRecognition();
    };
  }, [cleanupRecognition]);

  const stop = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (recognitionRef.current) {
      setStatus('stopping');
      recognitionRef.current.stop();
    } else {
      setStatus((prev) => (prev === 'unsupported' ? prev : 'idle'));
    }
  }, []);

  const start = useCallback(() => {
    if (!isSupported) {
      setError('Browser does not support the Web Speech API.');
      return false;
    }

    if (isListening) {
      return true;
    }

    setError(null);

    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      setStatus('unsupported');
      setError('Browser does not expose SpeechRecognition.');
      return false;
    }

    try {
      const recognition = new SpeechRecognitionCtor();
      recognition.lang = languageRef.current;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let interim = '';
        let finalText = '';

        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const transcript = result[0]?.transcript ?? '';
          if (!transcript) continue;
          if (result.isFinal) {
            finalText += transcript;
          } else {
            interim += transcript;
          }
        }

        if (interim) {
          setInterimTranscript(interim.trim());
        } else {
          setInterimTranscript('');
        }

        if (finalText) {
          const normalized = finalText.trim();
          onFinalResult?.(normalized);
          onSegmentCaptured?.(normalized);
          setInterimTranscript('');
        }
      };

      const clearAutoStopTimer = () => {
        if (timerRef.current) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      };

      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        const message =
          event.error === 'aborted'
            ? null
            : event.message || `Speech recognition error: ${event.error}`;
        if (message) {
          setError(message);
        }
        setStatus('idle');
        setInterimTranscript('');
        clearAutoStopTimer();
        cleanupRecognition();
      };

      recognition.onend = () => {
        setStatus((prev) => (prev === 'unsupported' ? prev : 'idle'));
        setInterimTranscript('');
        clearAutoStopTimer();
        cleanupRecognition();
      };

      recognitionRef.current = recognition;
      recognition.start();
      setStatus('listening');

      if (autoStopMs > 0) {
        timerRef.current = window.setTimeout(() => {
          setError('Recording stopped after 3 minutes to keep sessions responsive.');
          stop();
        }, autoStopMs);
      }

      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to start speech recognition.';
      setError(message);
      setStatus('idle');
      cleanupRecognition();
      return false;
    }
  }, [autoStopMs, cleanupRecognition, isListening, isSupported, onFinalResult, onSegmentCaptured, stop]);

  const resetError = useCallback(() => setError(null), []);

  const clearInterim = useCallback(() => setInterimTranscript(''), []);

  return {
    isSupported,
    isListening,
    error,
    interimTranscript,
    start,
    stop,
    resetError,
    clearInterim
  };
}
