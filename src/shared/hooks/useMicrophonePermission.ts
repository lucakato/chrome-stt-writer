import { useCallback, useEffect, useState } from 'react';

type MicrophonePermissionState = 'prompt' | 'granted' | 'denied' | 'unsupported' | 'pending';

export function useMicrophonePermission() {
  const [state, setState] = useState<MicrophonePermissionState>('pending');
  const [lastError, setLastError] = useState<string | null>(null);

  const describeError = useCallback((error: unknown): string => {
    if (error instanceof DOMException) {
      switch (error.name) {
        case 'NotAllowedError':
          return 'Microphone access was blocked. Click the lock icon in the address bar, set Microphone to "Allow", and try again.';
        case 'NotFoundError':
          return 'No microphone was found. Connect a microphone and try again.';
        case 'NotReadableError':
        case 'SecurityError':
          return 'Chrome could not start the microphone. Check system privacy settings and ensure no other app is using the mic.';
        case 'AbortError':
          return 'The permission prompt was dismissed. Click the lock icon in the address bar and allow microphone access.';
        default:
          return `Microphone permission error: ${error.message}`;
      }
    }

    if (error instanceof Error) {
      return error.message;
    }

    return 'Microphone permissions denied or unavailable.';
  }, []);

  useEffect(() => {
    let mounted = true;

    async function hydrateFromPermissionsApi() {
      if (!('permissions' in navigator) || !navigator.permissions?.query) {
        if (mounted) {
          setState('unsupported');
        }
        return;
      }

      try {
        const status = await navigator.permissions.query({
          // The Permissions API typing does not include 'microphone' yet.
          // Casting keeps TypeScript happy while the spec catches up.
          name: 'microphone' as PermissionName
        });

        if (!mounted) return;

        const nextState = status.state as MicrophonePermissionState;
        setState(nextState);
        if (nextState === 'granted') {
          setLastError(null);
        }
        status.onchange = () => {
          if (!mounted) return;
          const updatedState = status.state as MicrophonePermissionState;
          setState(updatedState);
          if (updatedState === 'granted') {
            setLastError(null);
          }
        };
      } catch (error) {
        if (!mounted) return;
        console.warn('Unable to read microphone permissions', error);
        setState('unsupported');
      }
    }

    hydrateFromPermissionsApi();

    return () => {
      mounted = false;
    };
  }, []);

  const requestPermission = useCallback(async () => {
    try {
      setLastError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      if (state !== 'granted') {
        setState('granted');
      }
      setLastError(null);
      return true;
    } catch (error) {
      const message = describeError(error);
      setLastError(message);
      setState('denied');
      return false;
    }
  }, [describeError, state]);

  return {
    status: state,
    requestPermission,
    error: lastError
  };
}
