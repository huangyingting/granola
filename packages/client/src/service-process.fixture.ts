import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, vi } from 'vitest';

export const SYNTHETIC_AZURE_HOST = 'synthetic.openai.azure.com';
export const SYNTHETIC_AZURE_KEY = 'synthetic-azure-key-not-a-secret';

type Exit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | undefined;
};

export async function unusedServicePort() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === 'string')
    throw new Error('The isolated service did not acquire a port.');
  return address.port;
}

export function launchService(
  database: string,
  port: number,
  entry: 'api' | 'worker',
  options: {
    durationMs?: number;
    health?: boolean;
    proxy?: { url: string; certificate: string };
  } = {},
) {
  const duration = options.durationMs ?? 20_000;
  if (options.health && entry !== 'worker')
    throw new Error(
      'The private health option applies only to the Worker fixture.',
    );
  if (!Number.isInteger(duration) || duration < 1000 || duration > 240_000)
    throw new Error('The isolated service exceeds its process lifetime bound.');
  if (options.proxy) {
    const url = new URL(options.proxy.url);
    if (
      entry !== 'worker' ||
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !url.port ||
      url.pathname !== '/' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !isAbsolute(options.proxy.certificate)
    )
      throw new Error(
        'The worker fixture requires an isolated loopback proxy and private test TLS context.',
      );
  }
  const child = spawn(
    process.execPath,
    [
      ...(options.proxy ? ['--use-env-proxy'] : []),
      fileURLToPath(
        new URL(`../../../apps/${entry}/dist/main.js`, import.meta.url),
      ),
    ],
    {
      env: {
        NODE_ENV: 'development',
        DATABASE_URL: database,
        AUTH_MODE: 'development',
        HOST: '127.0.0.1',
        PORT: String(port),
        ...(entry === 'worker'
          ? {
              AZURE_OPENAI_ENDPOINT: `https://${SYNTHETIC_AZURE_HOST}/`,
              AZURE_OPENAI_API_KEY: SYNTHETIC_AZURE_KEY,
              AZURE_OPENAI_API_VERSION: '2024-10-21',
              AZURE_OPENAI_DEPLOYMENT: 'synthetic',
              AZURE_SPEECH_KEY: 'synthetic-speech-key-not-a-secret',
              AZURE_SPEECH_REGION: 'eastus',
              ...(options.health ? { WORKER_HEALTH_PORT: String(port) } : {}),
            }
          : {}),
        ...(options.proxy
          ? {
              HTTP_PROXY: options.proxy.url,
              HTTPS_PROXY: options.proxy.url,
              NO_PROXY: '',
              NODE_EXTRA_CA_CERTS: options.proxy.certificate,
            }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: duration,
      killSignal: 'SIGKILL',
    },
  );
  let stdout = '',
    stderr = '',
    failure: Error | undefined,
    result: Exit | undefined;
  child.once('error', (error) => {
    failure = error;
  });
  function collect(text: string, bytes: Buffer) {
    if (Buffer.byteLength(text) + bytes.length > 65_536) {
      failure = new Error(
        'The isolated service exceeded its diagnostic bound.',
      );
      child.kill('SIGKILL');
      return text;
    }
    return text + bytes.toString('utf8');
  }
  child.stdout.on('data', (bytes: Buffer) => {
    stdout = collect(stdout, bytes);
  });
  child.stderr.on('data', (bytes: Buffer) => {
    stderr = collect(stderr, bytes);
  });
  const closed = new Promise<Exit>((resolve) =>
    child.once('close', (code, signal) => {
      result = { code, signal, error: failure };
      resolve(result);
    }),
  );
  return {
    child,
    closed,
    port,
    base: `http://127.0.0.1:${port}`,
    get result() {
      return result;
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    async observed(code: string) {
      await vi.waitFor(
        () => {
          if (stdout.includes(`"code":"${code}"`)) return;
          throw new Error(
            result
              ? `Service exited before ${code}: ${JSON.stringify(result)} ${stderr}`
              : `Waiting for ${code}.`,
          );
        },
        { timeout: 10_000, interval: 20 },
      );
    },
    async exit() {
      await vi.waitFor(() => expect(result).toBeDefined(), {
        timeout: 10_000,
        interval: 20,
      });
      return closed;
    },
  };
}
