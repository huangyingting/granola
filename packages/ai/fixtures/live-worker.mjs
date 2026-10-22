import { parentPort, workerData } from 'node:worker_threads';

const { mode = 'normal', results = {}, identities = [] } = workerData;
let samples = 0;
let outputSequence = 0;
function send(result) {
  parentPort.postMessage({
    kind: 'result',
    sequence: ++outputSequence,
    result_type: 'final',
    result_id: 'synthetic-result',
    offset_ticks: 0,
    duration_ticks: samples * 625,
    text: 'Orion launch',
    ...result,
  });
}
parentPort.on('message', (message) => {
  if (message.kind === 'audio') {
    if (message.sequence !== samples / 800 || message.pcm.byteLength !== 1600)
      process.exit(2);
    samples += 800;
    if (mode === 'busy') {
      while (true) {
        /* Exercise hard thread cancellation. */
      }
    }
    if (mode === 'crash') throw new Error('sensitive-synthetic-provider-body');
    if (mode === 'diagnostics')
      console.error('sensitive-synthetic-provider-body');
    if (mode === 'invalid')
      parentPort.postMessage({ kind: 'result', text: 'invalid' });
    if (mode === 'error')
      parentPort.postMessage({
        kind: 'error',
        code: 'provider_authentication_failed',
      });
    if (mode === 'partials') send({ result_type: 'partial' });
    for (const result of results[message.sequence] ?? []) send(result);
    if (mode === 'progress' && samples % 1600 === 0)
      send({
        result_type: 'no_match',
        text: '',
        offset_ticks: (samples - 1600) * 625,
        duration_ticks: 1_000_000,
      });
  } else if (message.kind === 'end' && mode !== 'never-finish') {
    if (mode === 'normal' && samples) send({});
    parentPort.postMessage({
      kind: 'stopped',
      samples: mode === 'wrong-receipt' ? samples + 800 : samples,
    });
  }
});
if (mode !== 'never-start' && mode !== 'identity-before-ready')
  parentPort.postMessage({ kind: 'ready' });
for (const identity of identities) parentPort.postMessage(identity);
if (mode === 'identity-before-ready') parentPort.postMessage({ kind: 'ready' });
