import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sdk = require('microsoft-cognitiveservices-speech-sdk');
const endpoint = new URL(process.env.SYNTHETIC_SPEECH_ENDPOINT);
if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1')
  throw new Error('The SDK fixture requires a synthetic loopback endpoint.');
sdk.SpeechConfig.fromSubscription = () =>
  sdk.SpeechConfig.fromEndpoint(endpoint, 'synthetic-speech-key');
