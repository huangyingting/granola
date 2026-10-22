import type { Writable } from 'node:stream';

export function boundedTelemetry(
  output: Writable,
  prefix: 'http_request' | 'live_gateway' | 'provider' | 'upload_verification',
) {
  let dropped = 0n;
  let waiting = false;
  let failed = false;
  const droppedRecord = () => ({
    code: `${prefix}_telemetry_dropped`,
    finished_at: new Date().toISOString(),
    count: dropped.toString(),
  });
  const drain = () => {
    waiting = false;
    if (!dropped || failed) return;
    const record = droppedRecord();
    dropped = 0n;
    write(record);
  };
  function awaitDrain() {
    if (waiting) return;
    waiting = true;
    output.once('drain', drain);
  }
  function write(record: object) {
    const encoded = `${JSON.stringify(record)}\n`;
    try {
      if (!output.write(encoded)) awaitDrain();
    } catch {
      unavailable();
    }
  }
  const unavailable = () => {
    if (failed) return;
    failed = true;
    console.error(
      JSON.stringify({
        code: `${prefix}_telemetry_unavailable`,
        finished_at: new Date().toISOString(),
      }),
    );
  };
  output.on('error', unavailable);
  if (!output.writable) unavailable();
  return {
    emit(record: object) {
      if (failed || output.writableNeedDrain) {
        dropped++;
        if (!failed) awaitDrain();
        return;
      }
      write(record);
    },
    close() {
      output.off('drain', drain);
      output.off('error', unavailable);
      if (dropped) console.error(JSON.stringify(droppedRecord()));
    },
  };
}
