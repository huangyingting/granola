# Windows AI Notes

An independent, self-hostable Windows meeting-notes project. The implementation
includes a **secure offline-first desktop editor with account synchronization, P0 audio/recovery probe and initial server-side AI slice**, following the
[implementation plan](WINDOWS-AI-NOTES-IMPLEMENTATION-PLAN.md). It does not use
Granola code, branding, credentials, or private services.

**This is a developer preview, not production-ready software or a completed P0 gate.**
The server can transcribe short WAV clips with Azure Speech and produce cited,
structured meeting summaries with Azure OpenAI. Explicit saved-recording uploads
connect the Windows helper to private server storage, not yet to meeting transcription.
The Electron editor supports browser login, isolated cloud workspaces, background
synchronization and explicit conflict recovery. Complete-meeting transcription,
live transcription and interactive AI workflows remain in progress.
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
- Authenticated manifest/timeline and per-track chunk pagination, deterministic
  canonical WAV descriptors and checksums, and bounded 32 KiB WAV range export
  through the helper's framed protocol. The reusable main-process client streams
  and verifies ranges without forwarding media to UI/status observers. No
  plaintext audio temporary files are created. Consented desktop uploads reuse
  this authenticated export path.
- A small CLI using inherited, length-prefixed stdio, and Linux/Windows CI.
- Explicit desktop microphone/system-output selection, local start/pause/resume/stop,
  an always-visible stop control, acknowledged saved-chunk durations and recording
  integrity inspection. Capture is optional and bounded to the helper's one-hour
  preview limit; capture alone never uploads audio or calls Azure.
- Encrypted, durable recording ownership is committed before launching capture.
  Restart marks unfinished sessions for inspection, never automatic capture.
  Document deletion, workspace revocation and disconnect journal physical audio
  cleanup before dropping their association; failed removal remains observable
  and retryable. Explicit audio-only deletion preserves written notes.
- Structured basic rich-text notes, tags, Markdown/plain-text export, stable
  offline document IDs, idempotent saves, and owner-scoped snapshot/incremental
  synchronization with deletion tombstones and expired-cursor handling.
- Sandboxed Electron/React editor with local search, basic formatting, tags,
  inline deletion confirmation and native exports. SQLite draft bodies,
  main-only credentials and frozen outbox requests use AES-256-GCM;
  Windows DPAPI protects the content key. Wrong or missing keys fail closed,
  without resetting existing notes. Browser-based OIDC login, workspace switching,
  bounded background sync, two-version conflict decisions, deleted-document
  recovery and cached transcript/job views are connected to the desktop.
- A Fastify API and separate worker, backed by PostgreSQL: provisioned OIDC
  identities, workspace membership, private owner-only documents, optimistic
  revisions, immutable note/transcript history, idempotent AI jobs, leases/fences,
  cancellation, bounded retries, and replayable SSE lifecycle events.
- Private S3-compatible recording storage: immutable metadata, repairable frozen
  seals, bounded signed staging PUTs, full WAV/PCM integrity verification and
  server-only immutable promotion. Durable deletion tracks objects across
  document deletion, revocation, expired grants and late upload replay.
- Explicit desktop upload consent, encrypted per-profile intents and immutable
  native plans, verified progress, pause/retry with durable backoff and restart
  reconciliation. Verified chunks are not re-uploaded. Temporary helpers/network
  work stop before shutdown or ownership cleanup; local audio stays until
  explicitly deleted.
- Azure Speech Fast Transcription and Azure OpenAI structured summaries. Inputs
  freeze their revisions; generated summaries never overwrite notes. Citations
  must resolve to the supplied immutable evidence. Provider errors are explicit.
- Revision-pinned transcript pages backed by indexed immutable PostgreSQL segments.
  Synchronization atomically caches the first bounded page with the document and
  cursor; the desktop loads additional pages on demand into its encrypted cache.
  Server Markdown/plain-text exports stream the entire pinned transcript instead
  of truncating it. Legacy short-transcript and summary context limits remain unchanged.

## Desktop preview

On Windows 11 x64, with Node.js 24 and Corepack/pnpm:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm desktop
```

The **Audio devices** screen uses only the fixed-path bundled Windows helper to
list microphones and system-output endpoints; checking devices does not record
audio. System audio is device-level, not isolated to one meeting app. Helper
failures are shown inline; the application never downloads or searches PATH for
an alternative executable. For a source checkout, install the .NET SDK selected
by `global.json` and run `pnpm audio:publish` before opening that screen.

Inside a meeting, choose **Record audio**, review the sources and explicitly
choose **Start recording**. System audio is off initially. The top recording bar
keeps pause/resume/stop available while you edit or navigate; stopping is not
blocked by invalid note text. Changing accounts/workspaces requires stopping
capture first. Closing the window waits for capture shutdown; interrupted sessions
remain under **Saved audio** for inspection. Saved durations count only acknowledged
encrypted chunks and may trail capture by up to 30 seconds. Audio meters and
physical-device reliability evidence remain release work.

After inspection finds safe, authenticated orphan chunks, **Recover saved chunks**
offers an inline confirmation before attaching them to the encrypted manifest.
Recovery updates per-track saved durations but never resumes capture or marks an
interrupted recording complete. Missing or ambiguous chunks, damaged manifests,
and unavailable keys block adoption without deleting audio. Temporary inspection
and recovery helpers also shut down before account revocation deletes their files.

In a signed-in cloud workspace, synchronize the meeting first, then expand
**Saved audio** and choose **Upload saved audio**. Inline confirmation names the
destination service and separately accepts incomplete capture. Native integrity
inspection must pass; recover safe orphan chunks before uploading. Only explicit
upload intents resume after restart, and only in their original authorized
workspace. **Pause upload** remains available during transfer; waiting retries
honor server backoff. Upload progress is separate from note synchronization.
The encrypted journal stores no media, tokens or signed URLs, and private plans
are not sent to the renderer.

A verified remote copy does not remove local audio or start Azure transcription.
For a recording with upload intent, **Delete audio only** journals deletion of
both copies. A document-scoped server tombstone prevents an uncertain, late
creation from resurrecting it. Local audio stays until remote cleanup is
confirmed; offline or failed deletion stays visible and retryable. Confirmation
reflects the service's last successful cleanup sweep, not deletion from independent
backups or an instantaneous erasure guarantee.

No API credentials are needed for the offline editor. Edits display **Saved locally**
only after SQLite acknowledges the save. Document changes, exports and window
close wait for queued edits; invalid or failed saves keep the editor open.
Search covers local titles, tags and note text. Markdown and plain-text exports
are explicitly **unencrypted**. Keep the local data directory and protected
content key together; files copied to a different Windows account cannot
necessarily be unlocked. Do not delete the key to resolve a startup error.

The renderer has no Node.js, filesystem, token or network access. A bundled,
sandbox-compatible preload exposes a strictly validated, narrow IPC interface.
The application refuses Linux plaintext key-storage backends rather than silently
downgrading encryption; Windows is the supported desktop target.

The main-process client core also implements bounded HTTPS transport and durable
synchronization: frozen requests replay before pulls, snapshot pagination survives
restarts, missing-document reconciliation preserves unsubmitted edits, and
workspace revocation purges only the affected cache. Cursors, changed documents
and encrypted transcript/job artifacts commit together. The v1/v2/v3/v4 local vault is
migrated transactionally to v5 without resetting keys, drafts, recording intents or retries.
Legacy full-transcript caches remain readable offline. Older previews reject this
version rather than mistaking a cached transcript page for the complete revision. Real
HTTP/PostgreSQL/SQLite tests cover lost responses, two-device conflicts, expiry,
deletion and revocation.

The transcript viewer shows its current segment range and replaces, rather than
accumulates, rendered pages. Opened pages remain available offline after restart;
unopened pages require a connection and a failed fetch leaves the current page
visible with an explicit error. Switching workspaces, revocation or deletion fences
late page responses. This storage/viewing foundation does not yet connect saved
recordings to complete-meeting transcription.

Before starting an updated server, run `pnpm db:migrate`. PostgreSQL migration 004
preserves existing segment IDs, order and revisions while normalizing legacy JSON
arrays into indexed segment rows. Stored revisions are bounded to 100,000 segments
and 8,000,000 UTF-8 text bytes; each API page contains at most 50 segments and
128,000 UTF-8 text bytes. Oversized legacy API reads fail explicitly with
`transcript_pagination_required`; full exports use the streaming path.
The OIDC client core uses a system-browser code/S256 flow and a loopback-only
callback, validates signed ID/access tokens and state/nonce/audience/scope, and
stores rotating refresh credentials only in the encrypted main-process vault.
Refresh requests are durably fenced before sending; an uncertain rotation requires
sign-in again rather than replaying a possibly consumed refresh token. Real
synthetic-issuer tests cover rollover, cancellation and logout races; a production
identity-provider registration is still required.

Open **Account & sync**, enter your administrator's HTTPS service origin and
choose **Sign in with browser**. Select a provisioned workspace after signing in.
Device-only drafts are **not uploaded automatically**: explicitly check the copy
option when opening a workspace. Copies get new IDs; originals remain on the
device, and repeated imports of an unchanged draft do not duplicate it. Copies
include written notes only; they do not copy or upload raw audio.
Switching back to **On this device** pauses cloud sync without signing out.

Disconnecting clears all cached workspaces and local credentials transactionally.
You can explicitly keep unsynced drafts as new device-only copies; pending
deletions are not sent. Existing remote audio is not deleted by disconnect.
Workspace audio is also deleted, including not-yet-uploaded
recordings; the disconnect confirmation makes this explicit. Known access revocation removes the affected cache rather
than copying forbidden content into an offline profile. If storage prevents its
removal, the workspace is blocked and the failure is reported. Stale renderer
writes cannot cross workspace boundaries, and failed editor saves offer new-copy
or explicit discard/reload recovery. Provider revocation and browser-session
logout are different: the app reports unsupported/unconfirmed token revocation
and does not claim to sign out your browser.

Only unpackaged builds with `NODE_ENV=test` or `development` and
`WINDOWS_NOTES_ALLOW_LOOPBACK=1` permit HTTP loopback service/issuer fixtures.
Packaged builds always require HTTPS.

The sidebar pages fifty encrypted-note summaries at a time; only the selected
editor receives a full draft. Search covers titles, tags and the complete note
body, including text beyond its preview, without writing a plaintext search
index. Paging and filtering preserve the current editor. Cold full-body search
still scans and decrypts candidates in the main process; large-library latency
and full transcript/job payloads remain performance release gates.

```sh
pnpm audio:publish
pnpm desktop:build
pnpm desktop:test
pnpm desktop:package:unsigned
```

The installer includes the self-contained x64 audio helper and its .NET runtime;
an external .NET installation is not required. The helper inherits only
OS/runtime location variables, never model keys, login credentials or startup
hooks. Bundled JavaScript dependency notices are generated from actual bundle
inputs into `resources/THIRD_PARTY_NOTICES.txt`; native library and runtime
notices are included under `resources/audio-host/licenses`. Missing bundled
license texts fail the desktop build.

Windows CI exercises the actual Electron renderer and DPAPI, local restart
persistence, invalid-save close protection, renderer isolation, key-loss recovery,
real loopback OIDC, consent-gated synchronization, stale-editor recovery,
revocation-driven UI clearing and the packaged executable. It publishes an **unsigned developer-preview**
NSIS installer under the workflow artifacts; this is not a signed release or
evidence of clean-machine install/upgrade/rollback compatibility.

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
documents. Team sharing remains outside the first release.

To enable native-client configuration discovery, set `OIDC_DESKTOP_CLIENT_ID`,
`OIDC_DESKTOP_SCOPES` (including `openid`, `offline_access` and the API scope) and,
if needed, `OIDC_DESKTOP_LOOPBACK_HOST=localhost`. Register the corresponding
`http://127.0.0.1/oauth/callback` or `http://localhost/oauth/callback` as a native
loopback redirect supporting dynamic ports and PKCE S256. Do not configure a
native-client secret. The issuer and API must issue matching RS256 access tokens
with the configured audience/scope; Azure Entra registrations may require
explicitly enabling v2 access tokens.

`GET /v1/client-config` returns only this public issuer/client/scope information,
without authentication or deployment secrets. It never creates users or grants
access. Unconfigured deployments return `503 desktop_login_not_configured`.
Administrative account provisioning remains CLI-only. Logout always removes the
local credential record; the client reports provider revocation as confirmed,
unsupported or unconfirmed rather than claiming an unavailable remote logout.

### Optional private recording storage

Set the `S3_*` variables shown in `.env.example` and provision a **private,
unversioned** bucket. The API checks bucket access policy, ACL and versioning
before accepting traffic. Production requires an HTTPS object endpoint and
explicit `AES256` or `aws:kms` server-side encryption; KMS also requires
`S3_KMS_KEY_ID`. Omit both static credential variables to use the server workload
identity. Credentials stay on the server; desktop clients receive only bounded,
short-lived, checksum/header-bound staging PUT authorization.
The server role needs bucket readiness reads (`ListBucket`, `GetBucketAcl`,
`GetBucketPolicy`, `GetBucketVersioning`) and object `GetObject`, `PutObject`,
`DeleteObject` under `recordings/v1/`. Staging PUTs use the signed
`bucket-owner-full-control` ACL, so account for `PutObjectAcl` where required.
KMS deployments also need the corresponding key permissions. The API does not
need permission to create buckets, change their policy or enable public access.

For synthetic local development, the optional composition builds the pinned
official MinIO source and binds only loopback:

```sh
docker compose --env-file .env -f infra/compose/storage.yml up -d --build
```

Supply explicit nonproduction credentials and create your private bucket using
your S3 administration tooling. This source-built fixture is **not a production
object-store deployment**. The normal PostgreSQL composition remains unchanged.

The recording API accepts canonical native chunks up to 960,044 bytes / 30
seconds. These use single PUT, not multipart or arbitrary file upload.
Register immutable chunk metadata, request authorization, PUT the exact WAV with
all returned headers, then complete verification. A successful PUT is not proof
of durable completion: retain local audio until the API reports it verified.
The server reads and verifies the actual bytes, then writes those exact bytes
to a private opaque key; it never trusts an ETag or copies a mutable staging key.

Sealing freezes the complete chunk order, tracks and sample ends independently
of upload completion. `sealed_pending` remains repairable; `ready` means every
declared chunk is verified. Interrupted captures require explicit
`accept_incomplete` and remain marked partial. Initial per-user limits are
100 retained recordings, 10,000 retained chunks and 5 GiB of declared audio;
temporary objects and per-chunk attempts are also bounded.

Audio-only deletion preserves written notes. Deletion returns `202` and remains
observable through its status endpoint; cleanup protects outstanding
authorizations/in-flight checks, retries failures and resweeps tombstones for
late PUTs. `cleanup_confirmed` describes the last successful sweep, not an
instantaneous erasure guarantee. Independent backup deletion-ledger replay,
retention policies and production storage drills remain release work.
The main-process transfer core reads authenticated native ranges, checks the
approved object origin/staging path and immutable checksum, excludes API
credentials, rejects redirects, and reconciles already-verified chunks after a
lost response without rereading local media. Durable encrypted desktop intent,
consent/progress/pause/retry and immutable native manifest/seal orchestration are
connected. Complete-meeting transcription remains unconnected. Local recordings
are never removed by the transfer core.

### Server API

Contracts are in `packages/contracts/src/server.ts`. Errors include `code`,
`message`, `retryable` and `request_id`; conflicts also include
`current_revision`. Create operations require an `Idempotency-Key` of 8-128
letters, digits, dots, colons, underscores or hyphens.

| Method               | Path                                                                 | Input / behavior                                                                                                                   |
| -------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| GET                  | `/health`                                                            | Database readiness; no authentication or meeting content                                                                           |
| GET                  | `/v1/client-config`                                                  | Public native OIDC registration; no secrets, bootstrap accounts or access grants                                                   |
| GET                  | `/v1/me`, `/v1/workspaces`                                           | Current provisioned user and active memberships                                                                                    |
| POST / GET           | `/v1/documents`                                                      | Create `{workspace_id,title,notes}`, optional offline `id`, `content`, `tags`; list with `workspace_id`, optional `limit`/`offset` |
| GET / PATCH / DELETE | `/v1/documents/{id}`                                                 | Read; change `{base_revision,title?,tags?}`; tombstone and purge online content                                                    |
| PUT / GET            | `/v1/documents/{id}/notes`                                           | Save `{base_revision,notes? ,content?}`; read an immutable `?revision=N`                                                           |
| GET                  | `/v1/documents/{id}/export`                                          | `format=markdown` or `text`, optional `timestamps=false`                                                                           |
| GET                  | `/v1/documents/{id}/jobs`                                            | Private job history with `limit`/`offset`                                                                                          |
| GET                  | `/v1/sync/snapshot`, `/v1/sync/changes`                              | Owner-scoped workspace bootstrap and ordered incremental metadata                                                                  |
| PUT / GET            | `/v1/documents/{id}/transcript`                                      | Save `{base_revision,segments}`; read current or `?revision=N`                                                                     |
| POST                 | `/v1/documents/{id}/transcription-runs?base_revision=0&locale=en-US` | Raw `audio/wav` body, returns a durable job                                                                                        |
| POST                 | `/v1/documents/{id}/summary-runs`                                    | `{note_revision,transcript_revision,language:"en"}`; returns a durable job                                                         |
| GET                  | `/v1/jobs/{id}`                                                      | Status, independent result, failure, and input-staleness flag                                                                      |
| POST                 | `/v1/jobs/{id}/cancel`                                               | Explicit cancellation, with terminal-state arbitration                                                                             |
| GET                  | `/v1/jobs/{id}/events`                                               | SSE; numeric `Last-Event-ID` for replay                                                                                            |
| GET                  | `/v1/models`, `/v1/templates`                                        | Fixed deployment capability catalog, never keys or arbitrary provider URLs                                                         |
| GET                  | `/v1/recording-capabilities`                                         | Authenticated storage availability, allowed upload origin and bounded chunk limits                                                 |
| POST / GET           | `/v1/documents/{id}/recordings`                                      | Create immutable `{id,created_at,tracks}`; list with `offset`                                                                      |
| GET                  | `/v1/recordings/{id}`                                                | Upload progress, immutable seal digest and readiness                                                                               |
| POST / GET           | `/v1/recordings/{id}/chunks`                                         | Register immutable native WAV descriptor; page with `offset`                                                                       |
| POST                 | `/v1/recordings/{id}/seal`                                           | Freeze exact track/chunk order, ends, timeline/gaps and incomplete acceptance                                                      |
| GET                  | `/v1/audio-chunks/{id}`                                              | Private immutable descriptor and verification state                                                                                |
| POST                 | `/v1/audio-chunks/{id}/upload`                                       | Empty object; issue/replay bounded staging authorization                                                                           |
| POST                 | `/v1/audio-chunks/{id}/complete`                                     | `{upload_id}`; verify actual bytes and publish immutable private object                                                            |
| DELETE / GET         | `/v1/recordings/{id}`, `/v1/recordings/{id}/deletion`                | Request audio-only deletion; observe durable cleanup                                                                               |
| DELETE               | `/v1/documents/{document}/recordings/{id}`                           | Tombstone audio even when an uncertain creation has not yet arrived; observe cleanup                                               |

Notes include canonical plain text and optional structured `content`, validated
by `packages/contracts/src/content.ts`. Supported blocks include paragraphs,
headings, lists, quotes, and fenced code; basic inline marks are supported.
Images, raw HTML, embedded files, and active links are not accepted.
When both `notes` and `content` are supplied, their text must agree. Existing
plain-text notes remain unchanged by the migration. Tags are limited to 16
unique values. Segments have UUID `id`, `start_ms`, `end_ms`
and `text`. A summary has `overview`, `topics`, `decisions`, `action_items` and
`open_questions`; each fact cites `{source,id,revision}`. Note references use the
document ID and note revision; transcript references use a segment ID and
transcript revision. The history endpoints locate those citations and recheck
permissions. Structural citation validation is not proof of semantic accuracy.

Use `base_revision` for optimistic updates; an optional `If-Match: "N"` must
agree. Conflicts never silently replace user edits. Summary results remain
separate even when their inputs become stale. Transcription completion fails if
a manual transcript edit arrived while recognition was running.

Send an `Idempotency-Key` with note and metadata saves to safely retry after a
lost response. A replay returns the current document and `applied_revision`
identifying the original mutation; it never reapplies an old edit over newer
content. Note and metadata keys have separate route scopes. Deleted document
IDs cannot be recreated by retrying a stale offline request.

For synchronization, first page through `/v1/sync/snapshot?workspace_id=UUID`,
passing the first page's `cursor` and the returned `next_after` unchanged on
subsequent pages. After the last page, consume `/v1/sync/changes` using that
cursor, then retain each response cursor only after applying its changes
locally. Fetch changed documents, transcripts or jobs through their authorized
endpoints. Workspace row locks serialize change numbers with their commits;
database sequences are not used as synchronization watermarks. Changes contain
IDs/revisions, never meeting bodies. Keep pending local edits on cursor expiry
(`410 sync_cursor_expired`) while refreshing the snapshot; on
`403 workspace_access_revoked`, remove that workspace's cached content.
The worker prunes change metadata after seven days. A revoked then reactivated
membership requires a fresh snapshot.

**Current server limits:** canonical PCM16 mono 16 kHz WAV, at most 60 seconds
per imported clip; English (`en-US`) and Chinese (`zh-CN`); 48,000 bytes of summary
context; eight pending jobs and two SSE subscriptions per user. Clips stage
temporarily in PostgreSQL and are removed on terminal completion or cancellation;
the running worker expires unprocessed clips after 24 hours and prunes replay
events older than seven days. SSE currently streams lifecycle/completion events, not
model-token previews. To retry a terminal failure, create a new run with a new
idempotency key.

This first slice uses PostgreSQL polling/leases as the durable scheduler rather
than introducing unused Redis/BullMQ infrastructure. Complete-meeting finalization, realtime STT, chat,
interactive desktop AI, budget reservation/settlement and token streaming remain later
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

To explicitly attach authenticated, contiguous orphan chunks left by a crash
between chunk and manifest commits:

```sh
pnpm audio:probe recover RECORDING_UUID --accept-incomplete --data-dir "C:\AudioProbeData"
```

Recovery atomically updates only the encrypted manifest and preserves audio and
unfinished files. It requires an unsealed, authentic manifest with consistent
declared chunks and unambiguous sample ranges. The result remains interrupted
(or incomplete when unfinished files remain), never `sealed`; an unsaved tail
cannot be reconstructed. Repeating a completed adoption does not rewrite files.
The command's success means adoption succeeded, not that a whole meeting survived.

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
`resume_recording`, `stop_recording`, `inspect_recording`, and `recover_recording`.
Recovery requires `accept_incomplete: true` and a fresh helper with no capture
session. Authenticated, bounded archive export uses `get_recording`,
`list_recording_chunks`, and `read_chunk`. A host handles a single recording
lifetime. Desktop saved-audio uploads use these authenticated exports; realtime
audio streaming remains later work.
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
