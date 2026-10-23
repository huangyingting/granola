import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Track } from '@windows-ai-notes/contracts';
import { AudioHostClient } from './client.js';
import { parseOptions } from './options.js';
import { measureCalibration, writeCalibrationFixture } from './calibration.js';

const help = `Windows AI Notes - P0 audio probe

pnpm audio:probe devices
pnpm audio:probe record --seconds 60 [--microphone default|off|DEVICE_ID] [--loopback default|off|DEVICE_ID]
pnpm audio:probe record --seconds 60 --pause-at 20 --pause-for 5
pnpm audio:probe record --seconds 60 --capture-clock wasapi_qpc_v1
pnpm audio:probe inspect RECORDING_ID [--data-dir PATH]
pnpm audio:probe recover RECORDING_ID --accept-incomplete [--data-dir PATH]
pnpm audio:probe calibration-audio [--data-dir PATH]
pnpm audio:probe calibrate RECORDING_ID [--data-dir PATH]

Capture is endpoint-wide, NOT application-isolated. Only record with consent.
Both tracks default to the Windows multimedia endpoints. Ctrl+C requests a clean stop.
Encrypted files default to .probe-data; keep them on the same Windows account.
Device-clock capture is experimental, opt-in and not physical drift acceptance.
Calibration measurements never automatically accept physical capture or production readiness.
The probe makes no network or AI calls.`;

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(help);
    return;
  }
  if (options.command === 'calibration-audio') {
    const interrupted = new AbortController();
    const interrupt = () => interrupted.abort();
    process.on('SIGINT', interrupt);
    try {
      const path = await writeCalibrationFixture(
        options.dataDir,
        interrupted.signal,
      );
      console.log(
        JSON.stringify({
          fixture_path: path,
          seconds: 3600,
          production_accepted: false,
        }),
      );
    } finally {
      process.off('SIGINT', interrupt);
    }
    return;
  }
  if (process.platform !== 'win32') {
    throw new Error(
      'This probe requires Windows 11. The portable recovery tests can run on Linux.',
    );
  }
  const hostPath = fileURLToPath(
    new URL(
      '../../../native/audio-host/AudioHost/bin/Release/net10.0-windows/AudioHost.dll',
      import.meta.url,
    ),
  );
  if (!existsSync(hostPath)) {
    throw new Error('Build the native probe first: pnpm build:native');
  }
  const client = new AudioHostClient(
    'dotnet',
    [hostPath, '--data-dir', options.dataDir],
    (event) => {
      if (options.command !== 'calibrate') console.log(JSON.stringify(event));
    },
  );
  const interrupted = new AbortController();
  const interrupt = () => interrupted.abort();
  process.on('SIGINT', interrupt);
  async function wait(seconds: number) {
    try {
      await Promise.race([
        delay(seconds * 1000, undefined, { signal: interrupted.signal }),
        client.failure,
      ]);
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) throw error;
    }
  }
  try {
    if (options.command === 'calibrate') {
      const report = await measureCalibration(
        client,
        options.recordingId,
        interrupted.signal,
      );
      console.log(JSON.stringify(report));
      if (!report.sampled_landmarks_within_target)
        throw new Error(
          'Calibration landmarks are missing, ambiguous, too short or outside the sampled alignment target. No physical gate was accepted.',
        );
      return;
    }
    if (options.command === 'devices') {
      await client.request({ command: 'list_devices' });
      return;
    }
    if (options.command === 'inspect') {
      const report = await client.request({
        command: 'inspect_recording',
        recording_id: options.recordingId,
      });
      if (
        report.event_type !== 'recording.inspected' ||
        report.payload.state !== 'sealed'
      ) {
        throw new Error(
          'The recording is not verified complete. Review the inspection issues; no files were changed.',
        );
      }
      return;
    }
    if (options.command === 'recover') {
      const report = await client.request({
        command: 'recover_recording',
        recording_id: options.recordingId,
        accept_incomplete: true,
      });
      if (
        report.event_type !== 'recording.recovered' ||
        !['interrupted', 'incomplete'].includes(report.payload.state) ||
        report.payload.recovered_chunks !== 0 ||
        report.payload.issues.some(
          (issue) =>
            !['unsealed_tail', 'uncommitted_file'].includes(issue.code),
        )
      )
        throw new Error(
          'Recovery did not confirm safe chunk adoption. Inspect the preserved recording before retrying.',
        );
      console.error(
        'Authenticated saved chunks are attached. Capture was not resumed or sealed; the unsaved tail may still be missing.',
      );
      return;
    }
    const tracks: Track[] = [];
    for (const [kind, device] of [
      ['microphone', options.microphone],
      ['loopback', options.loopback],
    ] as const) {
      if (device !== 'off') {
        tracks.push({
          track_id: randomUUID(),
          kind,
          device_id: device,
          capture_scope: 'endpoint',
          device_selection_policy:
            device === 'default' ? 'default' : 'explicit',
        });
      }
    }
    if (tracks.length === 0)
      throw new Error('Enable at least one audio track.');
    console.error(
      `Endpoint capture may include other applications. Recording ${options.recordingId} to ${options.dataDir}`,
    );
    await client.request({
      command: 'start_recording',
      recording_id: options.recordingId,
      tracks,
      ...(options.captureClock === 'wasapi_qpc_v1'
        ? { capture_clock: options.captureClock }
        : {}),
    });
    if (options.pauseAt !== undefined) {
      await wait(options.pauseAt);
      if (!interrupted.signal.aborted) {
        await client.request({
          command: 'pause_recording',
          recording_id: options.recordingId,
        });
        await wait(options.pauseFor);
        if (!interrupted.signal.aborted) {
          await client.request({
            command: 'resume_recording',
            recording_id: options.recordingId,
          });
          await wait(options.seconds - options.pauseAt - options.pauseFor);
        }
      }
    } else {
      await wait(options.seconds);
    }
    const stopped = await client.request({
      command: 'stop_recording',
      recording_id: options.recordingId,
    });
    if (
      stopped.event_type !== 'recording.stopped' ||
      stopped.payload.state !== 'sealed'
    ) {
      throw new Error('Capture did not seal successfully.');
    }
    const report = await client.request({
      command: 'inspect_recording',
      recording_id: options.recordingId,
    });
    if (
      report.event_type !== 'recording.inspected' ||
      report.payload.state !== 'sealed'
    ) {
      throw new Error('Saved audio did not pass the integrity check.');
    }
  } finally {
    process.off('SIGINT', interrupt);
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
