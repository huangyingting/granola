# Windows AI Notes

An independent, self-hostable Windows meeting-notes project. The implementation
starts with the **P0 audio and encrypted-recovery probe**, following the
[implementation plan](WINDOWS-AI-NOTES-IMPLEMENTATION-PLAN.md). It does not use
Granola code, branding, credentials, or private services.

**This is a developer probe, not a finished notes app or a completed P0 gate.**
There is no Electron UI, backend, account system, ASR, or LLM integration yet.
It makes no external AI calls. Real Windows audio behavior still requires the
hardware checks below.

## Implemented

- pnpm workspace with TypeScript/Zod contracts and shared native validation vectors.
- C#/.NET 10 Windows AudioHost using separate WASAPI microphone and render-loopback
  tracks; downmixing/resampling to 16 kHz mono PCM16.
- Explicit endpoint selection, pause/resume epochs, monotonic callback timestamps,
  bounded capture queues, and saved-sample counts. Queue overflow or device loss
  stops capture with an explicit failure instead of silently dropping audio.
- Up to 30 seconds per independently encrypted AES-256-GCM chunk. Each chunk has a
  fresh random key and nonce; Windows current-user DPAPI wraps the key. The
  authenticated header binds recording/track/chunk IDs, sample ranges, format,
  epoch, clock range, and PCM checksum. The manifest is also authenticated and
  encrypted.
- Flush-before-rename chunk commits, encrypted manifest updates, and read-only
  recovery inspection. Missing/truncated/tampered chunks, gaps in sample ranges,
  unfinished files, unavailable keys, and unsealed tails are reported separately.
  Authenticated chunks committed before a manifest update are rediscovered.
- Deterministic in-memory PCM-to-WAV reconstruction for subsequent upload work.
  No plaintext audio temporary files are created.
- A small CLI using inherited, length-prefixed stdio, and Linux/Windows CI.

## Requirements and setup

Use **Windows 11 x64**, the .NET SDK selected by `global.json`, Node.js 24, and
Corepack/pnpm. Microphone access must be enabled in Windows privacy settings.
Only record synthetic audio or material everyone has consented to record.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm build:native
pnpm audio:probe devices
```

Record both default multimedia endpoints for one minute:

```sh
pnpm audio:probe record --seconds 60
```

**Loopback captures the selected output device's entire mix**, potentially
including notifications, music, and other applications. It is not Teams-only or
process-isolated capture. Headphones are the initial target; echo cancellation and
duplicate-transcript suppression are not implemented.

Select endpoint IDs from `devices`, disable a track, or exercise pause/resume:

```sh
pnpm audio:probe record --seconds 60 --loopback off
pnpm audio:probe record --seconds 60 --microphone off --loopback "ENDPOINT_ID"
pnpm audio:probe record --seconds 60 --pause-at 20 --pause-for 5
```

The CLI prints the recording UUID and typed JSON events. Status reports
`saved_samples`, not merely received audio: short tails are not committed until a
pause or clean stop. Ctrl+C asks the host to stop and seal. EOF also stops capture.
Endpoints are pinned at start; resume never silently switches to a different
device. Use a new host process and recording ID after a failure.

Inspect a stopped recording, including after forcibly terminating a test process:

```sh
pnpm audio:probe inspect RECORDING_UUID
pnpm audio:probe inspect RECORDING_UUID --data-dir "C:\AudioProbeData"
```

Use the same `--data-dir` when recording and inspecting. It defaults to
`.probe-data` relative to the current directory, excluded from Git. Keep this
directory private and on the same Windows account/machine: DPAPI data is not a
portable backup. Key-unlock failures never trigger key replacement or deletion.
One AudioHost process owns a data directory at a time.

`inspect` returns a nonzero exit status for anything other than `sealed`.
Inspection never modifies files or claims to recover an uncommitted tail. A hard
kill can lose up to the currently buffered 30-second chunk per track; committed
chunks remain independently verifiable. A damaged manifest blocks verification
rather than inventing a complete recording from partial evidence.

The probe stops after one hour of wall time, at 5 GiB of PCM per recording, or
when a chunk commit finds less than 64 MiB of free disk space. Recording data is not automatically
deleted. Manually remove a test recording only after reviewing its inspection.

## Protocol and storage

`packages/contracts/src/index.ts` defines requests/events. Each stdio frame is a
four-byte little-endian length followed by UTF-8 JSON, limited to 64 KiB. All
requests carry protocol version 1 and a UUID request ID. Recording commands also
carry a UUID recording ID. Unknown operations/fields, unsupported scope, invalid
track selection, and oversized frames are rejected. No control command accepts
a filesystem path or executable. Logs go only to stderr.

Commands are `list_devices`, `start_recording`, `pause_recording`,
`resume_recording`, `stop_recording`, and `inspect_recording`. A host handles a
single recording lifetime. This first contract is for local control only; audio
streaming, upload, and public HTTP contracts will be added in their later phases.
Native validation and Zod validation share checked-in request fixtures.

Recording directories contain an encrypted `manifest.enc`, UUID-named `.chunk`
files, and possibly uncommitted `.partial` files after a crash. The new
`WNOTE001` envelope is specific to this project, not Granola's format. Each
envelope stores a bounded authenticated JSON header, ciphertext, and a 16-byte
authentication tag. The PCM checksum is not an upload/WAV checksum or an ETag.

`sealed` establishes file integrity and agreement with the committed manifest,
**not** acoustic quality, complete device coverage, or clock-drift compliance.
Timestamps currently approximate capture using a shared monotonic callback
clock, not native WASAPI device/QPC positions. Loopback silence/callback gaps,
sleep, and delayed callbacks need hardware investigation before continuous
timeline fidelity can be claimed.

## Checks

On Linux, contracts, resampling, crypto, crash/recovery, and Windows cross-builds
can be checked without recording or credentials:

```sh
pnpm build
pnpm test
pnpm format:check
pnpm test:native
dotnet build native/audio-host/AudioHost.Windows.Tests/AudioHost.Windows.Tests.csproj --configuration Release
```

On Windows, additionally run the real DPAPI and stdio checks:

```sh
dotnet test native/audio-host/AudioHost.Windows.Tests/AudioHost.Windows.Tests.csproj --configuration Release
pnpm test
```

CI runs both operating systems and publishes an **unsigned, self-contained
Windows x64 helper**, not an installer. Automated tests use only generated audio.
The portable test key protector exists solely in the test assembly; the host
has no plaintext-key or non-DPAPI fallback. A Windows CI pass is not evidence of
physical audio capture.

## Open P0 release gates

| Gate          | Required evidence                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Real capture  | Microphone and loopback independently/together; headset, speakers, Bluetooth; one-hour capture with calibration audio                |
| Timeline      | Native device-clock strategy; drift within the plan's target; silence, callback gaps, pause, sleep and device unplug/replug behavior |
| Recovery      | Forced-kill and disk-full runs on Windows; account/key loss; interrupted file and manifest commits                                   |
| Capture scope | Play meeting and unrelated audio on same/different endpoints; verify actual endpoint scope                                           |
| Providers     | Explicitly selected ASR/LLM region and test accounts; authorized Chinese/English samples and structured-output/citation checks       |
| Identity      | Test OIDC issuer, desktop PKCE callback, token audience, refresh and revocation                                                      |
| Packaging     | Clean Windows machine without an SDK; Electron/helper integration; signed installer and updates remain later work                    |

These gates must be resolved before treating the probe as a supported recording
product or claiming P0 complete. The remaining architecture and acceptance
criteria are in the implementation plan; the reverse-engineering report is
background evidence, not a specification to clone.

## Dependency boundaries

JavaScript resolution is locked by `pnpm-lock.yaml`; .NET projects include
`packages.lock.json`, checked with locked restore in CI. Direct implementation
dependencies are Zod (MIT), NAudio.Core/NAudio.Wasapi (MIT), and Microsoft's
ProtectedData package (MIT). Tooling includes TypeScript (Apache-2.0), Vitest and
Prettier (MIT), xUnit (Apache-2.0), and the .NET test SDK (MIT).
NAudio's WinForms/ASIO/MIDI packages are intentionally not included.
Use `pnpm licenses list` and the locked NuGet package metadata when preparing the
distribution's full third-party notices. No application license is granted yet.
