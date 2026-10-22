import type { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { boundedTelemetry } from '@windows-ai-notes/ai/telemetry';
import { ServiceError } from '@windows-ai-notes/contracts/server';

type VerificationStage =
  'read' | 'validate' | 'authorize' | 'promote' | 'commit';
const failures = new Set([
  'checksum_mismatch',
  'invalid_audio',
  'upload_missing',
  'storage_unavailable',
  'immutable_object_conflict',
  'recording_not_found',
  'document_not_found',
  'recording_retention_expired',
  'verification_superseded',
]);

export function uploadObservability(
  app: FastifyInstance,
  output: Writable = process.stdout,
) {
  const telemetry = boundedTelemetry(output, 'upload_verification');
  app.addHook('onClose', async () => telemetry.close());
  return {
    start(requestId: string) {
      const started = performance.now();
      let stage: VerificationStage = 'read';
      let finished = false;
      const report = (outcome: string, aborted: boolean) => {
        if (finished) return;
        finished = true;
        telemetry.emit({
          code: 'upload_verification_completed',
          finished_at: new Date().toISOString(),
          request_id: requestId,
          stage,
          outcome,
          aborted,
          duration_ms: Math.round(performance.now() - started),
        });
      };
      return {
        stage(value: VerificationStage) {
          stage = value;
        },
        verified(aborted: boolean) {
          report('verified', aborted);
        },
        failed(error: unknown, aborted: boolean) {
          report(
            error instanceof ServiceError && failures.has(error.code)
              ? error.code
              : 'operation_failed',
            aborted,
          );
        },
      };
    },
  };
}
