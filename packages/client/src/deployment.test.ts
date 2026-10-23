import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const execute = promisify(execFile);
const manifest = fileURLToPath(
  new URL('../../../infra/compose/runtime.yml', import.meta.url),
);
const serviceSchema = z.object({
  image: z.string(),
  user: z.string(),
  init: z.boolean(),
  restart: z.string(),
  read_only: z.boolean(),
  cap_drop: z.array(z.string()),
  security_opt: z.array(z.string()),
  tmpfs: z.array(z.string()),
  stop_grace_period: z.string(),
  command: z.array(z.string()),
  environment: z.record(z.string(), z.string()),
  ports: z
    .array(
      z.object({
        target: z.number(),
        published: z.string(),
        host_ip: z.string(),
        protocol: z.string(),
      }),
    )
    .optional(),
  healthcheck: z
    .object({
      test: z.array(z.string()),
      interval: z.string(),
      timeout: z.string(),
      start_period: z.string(),
      retries: z.number(),
    })
    .optional(),
  volumes: z.array(z.unknown()).optional(),
});
const modelSchema = z.object({
  services: z.record(z.string(), serviceSchema),
});

describe.skipIf(process.env.SERVER_COMPOSE_ACCEPTANCE !== '1')(
  'operator-controlled production runtime Compose',
  () => {
    let directory: string, emptyEnv: string, override: string;
    let environment: NodeJS.ProcessEnv;
    const project = `notes-runtime-test-${randomUUID()}`;
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'notes-runtime-'));
      emptyEnv = join(directory, 'interpolation.env');
      override = join(directory, 'isolated.json');
      await writeFile(emptyEnv, '', { mode: 0o600 });
      const common = join(directory, 'common.env');
      const api = join(directory, 'api.env');
      const worker = join(directory, 'worker.env');
      await writeFile(
        common,
        [
          'NODE_ENV=development',
          'AUTH_MODE=development',
          'HOST=192.0.2.10',
          'PORT=80',
          'WORKER_HEALTH_PORT=0',
          'DATABASE_URL=postgres://synthetic:synthetic@database.invalid/notes',
          'S3_BUCKET=synthetic-private-media',
          'DELETION_ARCHIVE_BUCKET=synthetic-independent-archive',
        ].join('\n'),
        { mode: 0o600 },
      );
      await writeFile(
        api,
        [
          'OIDC_ISSUER=https://identity.example.test/',
          'AZURE_SPEECH_KEY=synthetic-api-speech-only',
        ].join('\n'),
        { mode: 0o600 },
      );
      await writeFile(
        worker,
        [
          'AZURE_OPENAI_API_KEY=synthetic-worker-only',
          'AZURE_SPEECH_KEY=synthetic-worker-speech-only',
        ].join('\n'),
        { mode: 0o600 },
      );
      await writeFile(
        override,
        JSON.stringify({
          services: {
            api: { network_mode: 'none', restart: 'no' },
            worker: { network_mode: 'none', restart: 'no' },
          },
        }),
        { mode: 0o600 },
      );
      environment = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: 'C.UTF-8',
        NOTES_SERVER_IMAGE:
          process.env.TEST_SERVER_IMAGE ??
          `synthetic.example.test/windows-ai-notes@sha256:${'a'.repeat(64)}`,
        NOTES_COMMON_ENV_FILE: common,
        NOTES_API_ENV_FILE: api,
        NOTES_WORKER_ENV_FILE: worker,
      };
    });
    afterAll(async () => {
      try {
        if (process.env.TEST_SERVER_IMAGE) {
          const result = await execute(
            'docker',
            [
              'container',
              'ls',
              '--all',
              '--no-trunc',
              '--filter',
              `label=com.docker.compose.project=${project}`,
              '--format',
              '{{.ID}}',
            ],
            { timeout: 10_000, maxBuffer: 4096 },
          );
          const ids = result.stdout.trim()
            ? result.stdout.trim().split('\n')
            : [];
          for (const id of ids) {
            if (!/^[a-f0-9]{64}$/.test(id))
              throw new Error(
                'The owned runtime container identity is invalid.',
              );
            await execute('docker', ['rm', '--force', id], { timeout: 10_000 });
          }
        }
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    });
    async function compose(
      args: string[],
      env = environment,
      isolated = false,
    ) {
      return execute(
        'docker',
        [
          'compose',
          '--project-name',
          project,
          '--env-file',
          emptyEnv,
          '--file',
          manifest,
          ...(isolated ? ['--file', override] : []),
          ...args,
        ],
        { env, cwd: directory, timeout: 20_000, maxBuffer: 262_144 },
      );
    }
    async function model(env = environment) {
      const result = await compose(['config', '--format', 'json'], env);
      return modelSchema.parse(JSON.parse(result.stdout));
    }
    it('runs only the existing API and Worker entry points without implicit provisioning or data mounts', async () => {
      const { services } = await model();
      expect(Object.keys(services).sort()).toEqual(['api', 'worker']);
      expect(services.api?.command).toEqual(['node', 'apps/api/dist/main.js']);
      expect(services.worker?.command).toEqual([
        'node',
        'apps/worker/dist/main.js',
      ]);
      for (const service of Object.values(services)) {
        expect(service.image).toBe(environment.NOTES_SERVER_IMAGE);
        expect(service.volumes).toBeUndefined();
        expect(service.command.join(' ')).not.toMatch(
          /migrate|deletion-init|deletion-recover|provision/,
        );
      }
    });
    it('overrides development flags and keeps service-only credentials separate', async () => {
      const { services } = await model();
      expect(services.api?.environment).toMatchObject({
        NODE_ENV: 'production',
        AUTH_MODE: 'oidc',
        HOST: '0.0.0.0',
        PORT: '4411',
        AZURE_SPEECH_KEY: 'synthetic-api-speech-only',
        DATABASE_URL: 'postgres://synthetic:synthetic@database.invalid/notes',
      });
      expect(services.api?.environment.AZURE_OPENAI_API_KEY).toBeUndefined();
      expect(services.worker?.environment).toMatchObject({
        NODE_ENV: 'production',
        WORKER_HEALTH_PORT: '4412',
        AZURE_OPENAI_API_KEY: 'synthetic-worker-only',
        AZURE_SPEECH_KEY: 'synthetic-worker-speech-only',
      });
      expect(services.worker?.environment.OIDC_ISSUER).toBeUndefined();
    });
    it('keeps both probes private and restricts filesystem, privileges and shutdown', async () => {
      const { services } = await model();
      expect(services.api?.ports).toEqual([
        {
          target: 4411,
          published: '4411',
          host_ip: '127.0.0.1',
          protocol: 'tcp',
        },
      ]);
      expect(services.worker?.ports).toBeUndefined();
      for (const service of Object.values(services)) {
        expect(service).toMatchObject({
          user: 'node',
          init: true,
          restart: 'unless-stopped',
          read_only: true,
          cap_drop: ['ALL'],
          security_opt: ['no-new-privileges:true'],
          stop_grace_period: '5m0s',
        });
        expect(service.tmpfs).toEqual([
          '/tmp:rw,noexec,nosuid,size=64m,mode=1777',
        ]);
        expect(service.healthcheck).toMatchObject({
          interval: '15s',
          timeout: '3s',
          start_period: '5m0s',
          retries: 3,
        });
        expect(service.healthcheck?.test.slice(0, 4)).toEqual([
          'CMD',
          'node',
          '--input-type=module',
          '--eval',
        ]);
      }
      expect(services.worker?.healthcheck?.test.at(-1)).toContain(
        'http://127.0.0.1:4412/health',
      );
    });
    it('keeps a custom published port on loopback without changing the application port', async () => {
      const { services } = await model({
        ...environment,
        NOTES_API_PORT: '49441',
      });
      expect(services.api?.ports?.[0]).toMatchObject({
        published: '49441',
        host_ip: '127.0.0.1',
        target: 4411,
      });
      expect(services.api?.environment.PORT).toBe('4411');
    });
    it.each([
      'NOTES_SERVER_IMAGE',
      'NOTES_COMMON_ENV_FILE',
      'NOTES_API_ENV_FILE',
      'NOTES_WORKER_ENV_FILE',
    ])('refuses missing %s before starting anything', async (key) => {
      const env = { ...environment };
      delete env[key];
      await expect(model(env)).rejects.toThrow(key);
      await expect(model({ ...environment, [key]: '' })).rejects.toThrow(key);
    });
    it.each([
      'NOTES_COMMON_ENV_FILE',
      'NOTES_API_ENV_FILE',
      'NOTES_WORKER_ENV_FILE',
    ])(
      'refuses an absent %s instead of silently omitting configuration',
      async (key) => {
        await expect(
          model({ ...environment, [key]: join(directory, 'absent.env') }),
        ).rejects.toThrow('absent.env');
      },
    );
    it('refuses host-address injection through the published port', async () => {
      await expect(
        model({ ...environment, NOTES_API_PORT: '0.0.0.0:4411' }),
      ).rejects.toThrow();
    });
    it.skipIf(!process.env.TEST_SERVER_IMAGE).each(['api', 'worker'])(
      'runs the real %s container with the declared restrictions and no external network',
      async (service) => {
        const config = await model();
        const health = config.services[service]?.healthcheck?.test.slice(2);
        if (!health?.length)
          throw new Error('A production service health command is missing.');
        const script = `
        import assert from 'node:assert/strict';
        import {readFile, writeFile, unlink} from 'node:fs/promises';
        import {execFile} from 'node:child_process';
        import {promisify} from 'node:util';
        import {createServer} from 'node:http';
        assert.notEqual(process.getuid(), 0);
        assert.equal(process.env.NODE_ENV, 'production');
        const status = await readFile('/proc/self/status', 'utf8');
        assert.match(status, /^NoNewPrivs:\\s+1$/m);
        assert.match(status, /^CapEff:\\s+0+$/m);
        const mounts = (await readFile('/proc/self/mountinfo', 'utf8')).split('\\n').map(line => line.split(' '));
        assert.ok(mounts.find(parts => parts[4] === '/')?.[5].split(',').includes('ro'));
        const temporary = mounts.find(parts => parts[4] === '/tmp');
        for (const option of ['rw', 'noexec', 'nosuid']) assert.ok(temporary?.[5].split(',').includes(option));
        await writeFile('/tmp/runtime-probe', 'synthetic');
        await unlink('/tmp/runtime-probe');
        if (process.argv[1] === 'api') {
          let code = 200;
          let stalled = false;
          const server = createServer((_request, response) => {
            if (!stalled) response.writeHead(code).end('synthetic-private-response');
          });
          await new Promise(resolve => server.listen(4411, '127.0.0.1', resolve));
          try {
            const probe = JSON.parse(process.argv[2]);
            await promisify(execFile)(process.execPath, probe, {timeout: 5000});
            code = 503;
            await assert.rejects(promisify(execFile)(process.execPath, probe, {timeout: 5000}),
              error => error.code === 1 && error.stderr.trim() === 'api_readiness_failed' && error.stdout === '');
            stalled = true;
            await assert.rejects(promisify(execFile)(process.execPath, probe, {timeout: 5000}),
              error => error.code === 1 && error.stderr.trim() === 'api_readiness_failed' && error.stdout === '');
          } finally { await new Promise(resolve => server.close(resolve)); }
        } else {
          const {startWorkerHealth} = await import('./apps/worker/dist/health.js');
          const shutdown = new AbortController();
          let failure = false, blocked, release;
          const endpoint = await startWorkerHealth(Number(process.env.WORKER_HEALTH_PORT),
            {checkHealth: async () => { if (blocked) await blocked; if (failure) throw new Error('private-health-error'); }},
            shutdown.signal);
          const probe = JSON.parse(process.argv[2]);
          const execute = () => promisify(execFile)(process.execPath, probe, {timeout: 5000});
          const unavailable = () => assert.rejects(execute(),
            error => error.code === 1 && error.stderr.trim() === 'worker_readiness_failed' && error.stdout === '');
          try {
            await unavailable();
            endpoint.markReady();
            await execute();
            failure = true;
            await unavailable();
            failure = false;
            await execute();
            blocked = new Promise(resolve => { release = resolve; });
            await unavailable();
            release();
            shutdown.abort();
            await unavailable();
            const live = await fetch(endpoint.url + '/health/live');
            assert.equal(live.status, 200);
            await live.body.cancel();
          } finally { release?.(); await endpoint.close(); }
        }
        console.log(JSON.stringify({unprivileged: true, read_only: true, no_new_privileges: true, capabilities_dropped: true, writable_private_tmpfs: true}));
      `;
        const result = await compose(
          [
            'run',
            '--rm',
            '--no-deps',
            '--pull',
            'never',
            service,
            'node',
            '--input-type=module',
            '--eval',
            script,
            service,
            JSON.stringify(health),
          ],
          environment,
          true,
        );
        expect(JSON.parse(result.stdout)).toEqual({
          unprivileged: true,
          read_only: true,
          no_new_privileges: true,
          capabilities_dropped: true,
          writable_private_tmpfs: true,
        });
      },
      30_000,
    );
  },
);
