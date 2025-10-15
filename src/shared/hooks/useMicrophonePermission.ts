import { useCallback, useEffect, useState } from 'react';

type MicrophonePermissionState = 'prompt' | 'granted' | 'denied' | 'unsupported' | 'pending';

export function useMicrophonePermission() {
  const [state, setState] = useState<MicrophonePermissionState>('pending');
  const [lastError, setLastError] = useState<string | null>(null);

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

        setState(status.state as MicrophonePermissionState);
        status.onchange = () => {
          if (!mounted) return;
          setState(status.state as MicrophonePermissionState);
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
      return true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Microphone permissions denied or unavailable.';
      setLastError(message);
      setState('denied');
      return false;
    }
  }, [state]);

  return {
    status: state,
    requestPermission,
    error: lastError
  };
}
