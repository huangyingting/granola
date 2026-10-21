import { loadAzureSpeechConfig } from '@windows-ai-notes/ai/config';
import { createAzureRealtimeProvider } from '@windows-ai-notes/ai/realtime';

export function loadLiveProvider(environment: NodeJS.ProcessEnv = process.env) {
  if (
    environment.LIVE_SPEECH_ENABLED === undefined ||
    environment.LIVE_SPEECH_ENABLED === 'false'
  )
    return null;
  if (environment.LIVE_SPEECH_ENABLED !== 'true')
    throw new Error('LIVE_SPEECH_ENABLED must be true or false.');
  return createAzureRealtimeProvider(loadAzureSpeechConfig(environment));
}
