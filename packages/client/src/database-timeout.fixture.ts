import { connect, createServer, type Socket } from 'node:net';
import { acceptanceDatabaseUrl } from './load.fixture.js';

export async function databaseResponseLossProxy(destination: string) {
  const target = acceptanceDatabaseUrl(destination);
  const sockets = new Set<Socket>();
  let armed: 'SELECT 1' | 'COMMIT' | undefined;
  let faults = 0,
    droppedBytes = 0,
    rollbackAfterFault = 0,
    connections = 0,
    unexpectedErrors = 0,
    closing = false;
  const server = createServer((incoming) => {
    connections++;
    const upstream = connect({
      host: target.hostname === '[::1]' ? '::1' : target.hostname,
      port: Number(target.port || 5432),
    });
    let buffered = Buffer.alloc(0);
    let startup = true,
      blocked = false;
    for (const socket of [incoming, upstream]) {
      sockets.add(socket);
      socket.setNoDelay(true);
      socket.setTimeout(30_000, () => socket.destroy());
      socket.on('close', () => {
        sockets.delete(socket);
        incoming.destroy();
        upstream.destroy();
      });
      socket.on('error', () => {
        if (!closing && !blocked) unexpectedErrors++;
        incoming.destroy();
        upstream.destroy();
      });
    }
    incoming.on('data', (bytes: Buffer) => {
      buffered = Buffer.concat([buffered, bytes]);
      while (buffered.length >= (startup ? 4 : 5)) {
        const length = buffered.readUInt32BE(startup ? 0 : 1);
        if (length < 4 || length > 1_048_576) {
          unexpectedErrors++;
          incoming.destroy();
          upstream.destroy();
          return;
        }
        const size = length + (startup ? 0 : 1);
        if (buffered.length < size) break;
        if (!startup && buffered[0] === 81) {
          const sql = buffered.subarray(5, size - 1).toString('utf8');
          if (blocked && sql === 'ROLLBACK') rollbackAfterFault++;
          if (armed && sql === armed) {
            armed = undefined;
            blocked = true;
            faults++;
          }
        }
        startup = false;
        buffered = buffered.subarray(size);
      }
      if (!upstream.write(bytes)) incoming.pause();
    });
    upstream.on('drain', () => incoming.resume());
    upstream.on('data', (bytes: Buffer) => {
      if (blocked) droppedBytes += bytes.length;
      else if (!incoming.write(bytes)) upstream.pause();
    });
    incoming.on('drain', () => upstream.resume());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('The private PostgreSQL proxy did not acquire a port.');
  const url = new URL(target);
  url.hostname = '127.0.0.1';
  url.port = String(address.port);
  url.searchParams.set('sslmode', 'disable');
  return {
    url: url.href,
    arm(sql: 'SELECT 1' | 'COMMIT') {
      if (armed || faults || closing)
        throw new Error('The bounded PostgreSQL fault was already used.');
      armed = sql;
    },
    get observations() {
      return {
        faults,
        droppedBytes,
        rollbackAfterFault,
        connections,
        unexpectedErrors,
      };
    },
    async close() {
      closing = true;
      const stopped = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      for (const socket of sockets) socket.destroy();
      await stopped;
    },
  };
}
