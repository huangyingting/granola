import {
  SUMMARY_USAGE_RESERVATION,
  factsSummaryPromptVersion,
  type AiProviders,
  type UsageReporter,
} from '@windows-ai-notes/ai';
import { chunkFrozenMeeting } from '@windows-ai-notes/ai/chunks';
import {
  LONG_SUMMARY_VERSION,
  ServiceError,
  citationKey,
  validateSummaryCitations,
  type TranscriptPage,
  type Usage,
} from '@windows-ai-notes/contracts/server';
import {
  SUMMARY_EXTRACT_PROMPT,
  SUMMARY_MERGE_PROMPT,
  summaryFactsInputSchema,
  validatePipelineFacts,
  factCitations,
  type EvidenceFacts,
  type SummaryStageKey,
  type SummaryStageSpec,
} from '@windows-ai-notes/contracts/evidence';
import { digest, type Database, type ClaimedJob } from '@windows-ai-notes/db';
import { withUsage } from './usage.js';
import { summaryPreview } from './preview.js';

const interrupted = () =>
  new ServiceError(
    'summary_dispatch_unconfirmed',
    'An earlier evidence request has no saved output. Its usage is retained; explicitly confirm a resume before sending it again.',
    409,
  );
export async function summarizeLongMeeting(
  db: Database,
  job: ClaimedJob,
  providers: AiProviders,
  signal: AbortSignal,
) {
  if (job.input.kind !== 'summary' || !job.input.source)
    throw new Error('Expected a frozen indexed summary.');
  const { snapshot, source } = job.input;
  const cached = await db.summaries.completed(job);
  if (cached) return { ...cached, usage: await db.summaries.totalUsage(job) };
  const extract = providers.extract?.bind(providers);
  const merge = providers.merge?.bind(providers);
  const generate = providers.summarizeFacts?.bind(providers);
  if (!extract || !merge || !generate)
    throw new ServiceError(
      'summary_pipeline_unavailable',
      'This worker does not support the authorized long-meeting generation pipeline.',
      503,
    );
  await db.summaries.begin(job, {
    provider: providers.provider,
    configurationVersion: providers.configurationVersion,
    pipelineVersion: LONG_SUMMARY_VERSION,
  });
  const { segments: _segments, ...meeting } = snapshot;
  const { notes: _notes, ...context } = meeting;
  const input = (facts: EvidenceFacts['facts']) =>
    summaryFactsInputSchema.parse({
      ...context,
      version: 'meeting-facts-input-v1',
      facts,
    });
  async function* pages(): AsyncGenerator<TranscriptPage> {
    let offset = 0,
      bytes = 0;
    while (offset < source.transcript.total_segments) {
      signal.throwIfAborted();
      const page = await db.transcripts.page(
        job.ownerId,
        job.documentId,
        snapshot.transcript_revision,
        offset,
      );
      offset += page.segments.length;
      bytes += page.segments.reduce(
        (sum, segment) => sum + Buffer.byteLength(segment.text),
        0,
      );
      yield page;
    }
    if (bytes !== source.text_bytes)
      throw new ServiceError(
        'summary_source_changed',
        'The frozen transcript text does not match its stored byte count.',
        410,
      );
  }
  async function factsStage(
    stage: SummaryStageSpec,
    run: (report: UsageReporter) => Promise<EvidenceFacts & { usage: Usage }>,
  ) {
    const accept = (value: unknown) => {
      const result = validatePipelineFacts(value, stage.citations);
      if (stage.phase === 'merge' && !result.facts.length)
        throw new ServiceError(
          'invalid_model_output',
          'The merge discarded all of its supplied evidence.',
          502,
        );
      return result;
    };
    signal.throwIfAborted();
    const prepared = await db.summaries.prepare(job, stage);
    if (prepared.state === 'completed') {
      if (prepared.output?.kind !== 'facts')
        throw new Error('Expected saved evidence facts.');
      return accept({ facts: prepared.output.facts });
    }
    if (prepared.state !== 'pending') throw interrupted();
    const call = await db.summaries.sending(
      job,
      stage,
      SUMMARY_USAGE_RESERVATION,
    );
    const generated = await withUsage(db, call, run);
    const result = accept({ facts: generated.facts });
    await db.summaries.save(job, stage, {
      kind: 'facts',
      ...result,
      usage: generated.usage,
    });
    return result;
  }
  let references: SummaryStageKey[] = [];
  for await (const chunk of chunkFrozenMeeting(
    meeting,
    source.transcript,
    pages(),
    signal,
  )) {
    const citations = [
      ...new Map(
        chunk.units.map((unit) => [citationKey(unit.citation), unit.citation]),
      ).values(),
    ];
    const stage: SummaryStageSpec = {
      phase: 'extract',
      round: 0,
      index: chunk.index,
      input_hash: digest(chunk),
      prompt_version: SUMMARY_EXTRACT_PROMPT,
      citations,
    };
    const result = await factsStage(stage, (report) =>
      extract(chunk, signal, report),
    );
    if (result.facts.length)
      references.push({ phase: stage.phase, round: 0, index: stage.index });
  }
  if (!references.length)
    throw new ServiceError(
      'insufficient_evidence',
      'The complete frozen meeting did not yield confirmed evidence. Review the source before authorizing a new summary.',
      400,
    );
  let round = 0;
  while (references.length > 1) {
    round++;
    if (round > 8)
      throw new ServiceError(
        'context_too_large',
        'The meeting exceeds the merge budget for this pipeline version.',
        413,
      );
    const next: SummaryStageKey[] = [];
    for (let offset = 0; offset < references.length; offset += 4) {
      const group = references.slice(offset, offset + 4);
      if (group.length === 1) {
        next.push(group[0]!);
        continue;
      }
      const facts: EvidenceFacts['facts'] = [];
      for (const key of group) {
        const saved = await db.summaries.read(job, key);
        if (saved.kind !== 'facts')
          throw new Error('Expected a completed evidence stage.');
        facts.push(...saved.facts);
      }
      const evidence = input(facts);
      const stage: SummaryStageSpec = {
        phase: 'merge',
        round,
        index: offset / 4,
        input_hash: digest(evidence),
        prompt_version: SUMMARY_MERGE_PROMPT,
        citations: factCitations(evidence.facts),
      };
      const result = await factsStage(stage, (report) =>
        merge(evidence, signal, report),
      );
      if (result.facts.length)
        next.push({ phase: stage.phase, round, index: stage.index });
    }
    if (!next.length)
      throw new ServiceError(
        'insufficient_evidence',
        'The supplied evidence did not support a merged summary. Review the frozen sources before a new request.',
        400,
      );
    references = next;
  }
  const saved = await db.summaries.read(job, references[0]!);
  if (saved.kind !== 'facts')
    throw new Error('Expected final merged evidence.');
  const evidence = input(saved.facts);
  const stage: SummaryStageSpec = {
    phase: 'generate',
    round: 0,
    index: 0,
    input_hash: digest(evidence),
    prompt_version: factsSummaryPromptVersion(snapshot),
    citations: factCitations(evidence.facts),
  };
  const prepared = await db.summaries.prepare(job, stage);
  if (prepared.state !== 'pending') throw interrupted();
  signal.throwIfAborted();
  const call = await db.summaries.sending(
    job,
    stage,
    SUMMARY_USAGE_RESERVATION,
  );
  const generated = await withUsage(db, call, (report) =>
    generate(evidence, signal, report, summaryPreview(db, job)),
  );
  const result = {
    kind: 'summary' as const,
    summary: validateSummaryCitations(generated.summary, stage.citations),
    provider: providers.provider,
    configuration_version: providers.configurationVersion,
    prompt_version: stage.prompt_version,
    usage: generated.usage,
  };
  await db.summaries.save(job, stage, { kind: 'summary', result });
  return { ...result, usage: await db.summaries.totalUsage(job) };
}
