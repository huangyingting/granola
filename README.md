# Windows AI Notes

An independent, self-hostable Windows meeting-notes project. The implementation
includes the **P0 audio/recovery probe and an initial server-side AI slice**, following the
[implementation plan](WINDOWS-AI-NOTES-IMPLEMENTATION-PLAN.md). It does not use
Granola code, branding, credentials, or private services.

**This is a developer milestone, not a finished notes app or a completed P0 gate.**
The server can transcribe short WAV clips with Azure Speech and produce cited,
structured meeting summaries with Azure OpenAI. The Windows helper is not yet
wired to that server, and there is no Electron editor or desktop login.
Real Windows audio behavior still requires the hardware checks below.

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
- A Fastify API and separate worker, backed by PostgreSQL: provisioned OIDC
  identities, workspace membership, private owner-only documents, optimistic
  revisions, immutable note/transcript history, idempotent AI jobs, leases/fences,
  cancellation, bounded retries, and replayable SSE lifecycle events.
- Azure Speech Fast Transcription and Azure OpenAI structured summaries. Inputs
  freeze their revisions; generated summaries never overwrite notes. Citations
  must resolve to the supplied immutable evidence. Provider errors are explicit.

## Server setup

The server runs on Linux or Windows with Node.js 24 and PostgreSQL 16. Docker is
optional for the application; Compose provides a loopback-only development
database. Start from the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
cp .env.example .env
docker compose --env-file .env -f infra/compose/compose.yml up -d --wait
pnpm db:migrate
pnpm user:provision --dev
```

The last command prints a `workspace_id` and `development_subject`. Start these
in separate terminals:

```sh
pnpm api
pnpm worker
```

The API defaults to `http://127.0.0.1:4411`. In explicit development mode, send
`X-Dev-Subject: DEVELOPMENT_SUBJECT` with each `/v1` request. This is intentionally
not production authentication: another local process can impersonate a known
development subject. Non-loopback binding and `NODE_ENV=production` both reject
development authentication.

The worker reads six configured Azure variables: `AZURE_OPENAI_ENDPOINT`,
`AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENT`,
`AZURE_SPEECH_KEY`, and `AZURE_SPEECH_REGION`. `AZURE_ENV_FILE` can import only
those fields from an existing env file, including `../ReadWise/.env`; explicitly
set environment values take precedence. Other application credentials are not
propagated. No keys are copied into source, responses, logs, or desktop code.
The API itself does not need the Azure credentials; only the worker uses them.

Production requires explicit `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL` and
`OIDC_REQUIRED_SCOPE` with `AUTH_MODE=oidc`, plus HTTPS termination, encrypted
database/storage/backup infrastructure and appropriate operational controls.
Use an API-specific OIDC registration; this does not reuse another app's
client secret or automatically trust its tokens. Access tokens must pass RS256
signature, issuer, audience, time and delegated-scope validation. An administrator
provisions identities with a CLI, never an HTTP bootstrap endpoint:

```sh
pnpm user:provision --issuer https://YOUR-ISSUER/ --subject OIDC_SUBJECT
```

Use `--workspace-id UUID` to add an explicitly provisioned identity to an existing
workspace. Membership alone never grants access to another member's private
documents. Team sharing, desktop PKCE, refresh-token handling and account UI are
not implemented by this server slice.

### Server API

Contracts are in `packages/contracts/src/server.ts`. Errors include `code`,
`message`, `retryable` and `request_id`; conflicts also include
`current_revision`. Create operations require an `Idempotency-Key` of 8-128
letters, digits, dots, colons, underscores or hyphens.

| Method               | Path                                                                 | Input / behavior                                                                         |
| -------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| GET                  | `/health`                                                            | Database readiness; no authentication or meeting content                                 |
| GET                  | `/v1/me`, `/v1/workspaces`                                           | Current provisioned user and active memberships                                          |
| POST / GET           | `/v1/documents`                                                      | Create `{workspace_id,title,notes}`; list with `workspace_id`, optional `limit`/`offset` |
| GET / PATCH / DELETE | `/v1/documents/{id}`                                                 | Read; change `{base_revision,title}`; tombstone and purge online content                 |
| PUT / GET            | `/v1/documents/{id}/notes`                                           | Save `{base_revision,notes}`; read an immutable `?revision=N`                            |
| PUT / GET            | `/v1/documents/{id}/transcript`                                      | Save `{base_revision,segments}`; read current or `?revision=N`                           |
| POST                 | `/v1/documents/{id}/transcription-runs?base_revision=0&locale=en-US` | Raw `audio/wav` body, returns a durable job                                              |
| POST                 | `/v1/documents/{id}/summary-runs`                                    | `{note_revision,transcript_revision,language:"en"}`; returns a durable job               |
| GET                  | `/v1/jobs/{id}`                                                      | Status, independent result, failure, and input-staleness flag                            |
| POST                 | `/v1/jobs/{id}/cancel`                                               | Explicit cancellation, with terminal-state arbitration                                   |
| GET                  | `/v1/jobs/{id}/events`                                               | SSE; numeric `Last-Event-ID` for replay                                                  |
| GET                  | `/v1/models`, `/v1/templates`                                        | Fixed deployment capability catalog, never keys or arbitrary provider URLs               |

Notes currently contain plain text. Segments have UUID `id`, `start_ms`, `end_ms`
and `text`. A summary has `overview`, `topics`, `decisions`, `action_items` and
`open_questions`; each fact cites `{source,id,revision}`. Note references use the
document ID and note revision; transcript references use a segment ID and
transcript revision. The history endpoints locate those citations and recheck
permissions. Structural citation validation is not proof of semantic accuracy.

Use `base_revision` for optimistic updates; an optional `If-Match: "N"` must
agree. Conflicts never silently replace user edits. Summary results remain
separate even when their inputs become stale. Transcription completion fails if
a manual transcript edit arrived while recognition was running.

**Current server limits:** canonical PCM16 mono 16 kHz WAV, at most 60 seconds
per imported clip; English (`en-US`) and Chinese (`zh-CN`); 48,000 bytes of summary
context; eight pending jobs and two SSE subscriptions per user. Clips stage
temporarily in PostgreSQL and are removed on terminal completion or cancellation;
the running worker expires unprocessed clips after 24 hours and prunes replay
events older than seven days. SSE currently streams lifecycle/completion events, not
model-token previews. To retry a terminal failure, create a new run with a new
idempotency key.

This first slice uses PostgreSQL polling/leases as the durable scheduler rather
than introducing unused Redis/BullMQ infrastructure. Full S3/resumable uploads,
recording manifests/sealing, complete-meeting finalization, realtime STT, chat,
sync, rich text, budget reservation/settlement and token streaming remain later
implementation work. Successful jobs expose provider usage, but this is not a
billing ledger; retries can incur duplicate provider charges.

An unprivileged server image is available through `docker build -t notes-server .`.
Its default command runs the API in OIDC mode; override the command with
`node apps/worker/dist/main.js` for a separate worker, or
`node packages/db/dist/cli.js migrate` for migrations. Supply configuration via
your deployment secret manager/environment. The development Compose file
deliberately starts only PostgreSQL, not an unauthenticated public API.

### Azure end-to-end probe

This opt-in command makes paid calls to the configured services using a generated
English speech sample and synthetic meeting notes. It uses Azure Speech TTS only
to generate the sample, Fast Transcription for STT, and the configured Azure
OpenAI deployment for a structured, citation-validated summary. It never sends a
real meeting. No cross-provider or cross-region fallback is performed.

```sh
DATABASE_URL=postgresql://notes:local-development-only@127.0.0.1:55432/notes \
  pnpm azure:probe --env-file ../ReadWise/.env
```

The probe creates and removes its own isolated database schema, holds the WAV in
memory, and prints only pass/fail counts and token usage, never credentials or
provider response bodies. An English synthetic end-to-end run has passed; this
does not establish Chinese recognition quality or real-meeting accuracy.

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
single recording lifetime. This first contract is for local control only; desktop
audio streaming and upload integration remain later work.
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

The server CI job also runs real PostgreSQL integration tests and builds the
server image, without Azure credentials. Locally, set `TEST_DATABASE_URL` to run
those tests; they create and remove their own isolated schema:

```sh
TEST_DATABASE_URL=postgresql://notes:local-development-only@127.0.0.1:55432/notes pnpm test
```

Without `TEST_DATABASE_URL`, database integration tests are explicitly skipped.
Provider unit tests use labeled fixtures and mocked transports. Live Azure calls
run only through the opt-in probe above, never automatically in public CI.

## Open P0 release gates

| Gate          | Required evidence                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Real capture  | Microphone and loopback independently/together; headset, speakers, Bluetooth; one-hour capture with calibration audio                |
| Timeline      | Native device-clock strategy; drift within the plan's target; silence, callback gaps, pause, sleep and device unplug/replug behavior |
| Recovery      | Forced-kill and disk-full runs on Windows; account/key loss; interrupted file and manifest commits                                   |
| Capture scope | Play meeting and unrelated audio on same/different endpoints; verify actual endpoint scope                                           |
| Providers     | Azure English synthetic STT/summary path verified; Chinese/real-meeting quality, long audio and cost evaluation remain               |
| Identity      | Test OIDC issuer, desktop PKCE callback, token audience, refresh and revocation                                                      |
| Packaging     | Clean Windows machine without an SDK; Electron/helper integration; signed installer and updates remain later work                    |

These gates must be resolved before treating the probe as a supported recording
product or claiming P0 complete. The remaining architecture and acceptance
criteria are in the implementation plan; the reverse-engineering report is
background evidence, not a specification to clone.

## Dependency boundaries

JavaScript resolution is locked by `pnpm-lock.yaml`; .NET projects include
`packages.lock.json`, checked with locked restore in CI. Direct implementation
dependencies include Zod, Fastify, node-postgres, jose, NAudio.Core/NAudio.Wasapi,
and Microsoft's ProtectedData package (MIT). Tooling includes TypeScript (Apache-2.0), Vitest and
Prettier (MIT), xUnit (Apache-2.0), and the .NET test SDK (MIT).
NAudio's WinForms/ASIO/MIDI packages are intentionally not included.
Use `pnpm licenses list` and the locked NuGet package metadata when preparing the
distribution's full third-party notices. No application license is granted yet.
