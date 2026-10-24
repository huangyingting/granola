import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  requireSigningEnvironment,
  signingContext,
} from './signing-admission.mjs';

const { github } = vi.hoisted(() => ({ github: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original();
  const { promisify } = await import('node:util');
  const execFile = (...args) => actual.execFile(...args);
  execFile[promisify.custom] = github;
  return { ...actual, execFile };
});
afterEach(() => {
  github.mockReset();
});

const repository = 'synthetic-owner/notes';
const context = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_API_URL: 'https://api.github.com',
  GITHUB_REPOSITORY: repository,
  GITHUB_SHA: 'a'.repeat(40),
};
const marker = 'SYNTHETIC_PRIVATE_METADATA_NOT_FOR_LOGS';
function environment() {
  return {
    id: 1,
    name: 'signed-release',
    can_admins_bypass: true,
    protection_rules: [
      {
        type: 'required_reviewers',
        prevent_self_review: false,
        reviewers: [{ type: 'User', reviewer: { id: 2, login: marker } }],
      },
    ],
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
  };
}
const respond = (value) =>
  github.mockResolvedValueOnce({ stdout: JSON.stringify(value) });
const publicRepository = () => ({
  id: 3,
  full_name: repository,
  private: false,
  visibility: 'public',
});
beforeEach(() => {
  respond(publicRepository());
});

describe('signing environment admission', () => {
  it('does not treat stored rules in a private repository as supported reviewer protection', async () => {
    github.mockReset();
    github.mockImplementation(async (_command, args) => ({
      stdout: JSON.stringify(
        args.at(-1) === `repos/${repository}`
          ? {
              id: 3,
              full_name: repository,
              private: true,
              visibility: 'private',
            }
          : environment(),
      ),
    }));
    await expect(requireSigningEnvironment(repository)).rejects.toMatchObject({
      code: 'signing_repository_unsupported',
    });
    expect(github).toHaveBeenCalledTimes(1);
    expect(github.mock.calls[0][1].at(-1)).toBe(`repos/${repository}`);
  });
  it.each(
    [
      null,
      [],
      {},
      { ...publicRepository(), id: 0 },
      { ...publicRepository(), id: '3' },
      { ...publicRepository(), full_name: 'other-owner/notes' },
      { ...publicRepository(), full_name: null },
      { ...publicRepository(), private: undefined },
      { ...publicRepository(), private: 'false' },
      { ...publicRepository(), visibility: undefined },
      { ...publicRepository(), visibility: 'unknown' },
    ].map((value) => [value]),
  )(
    'rejects invalid or foreign repository metadata %j before reading environment controls',
    async (value) => {
      github.mockReset();
      respond(value);
      await expect(requireSigningEnvironment(repository)).rejects.toMatchObject(
        {
          code: 'signing_metadata_invalid',
        },
      );
      expect(github).toHaveBeenCalledTimes(1);
      expect(github.mock.calls[0][1].at(-1)).toBe(`repos/${repository}`);
    },
  );
  it.each([
    { private: true, visibility: 'internal' },
    { private: false, visibility: 'internal' },
    { private: true, visibility: 'public' },
    { private: false, visibility: 'private' },
  ])(
    'rejects unsupported or inconsistent repository visibility %j',
    async (value) => {
      github.mockReset();
      respond({ ...publicRepository(), ...value });
      await expect(requireSigningEnvironment(repository)).rejects.toMatchObject(
        {
          code: 'signing_repository_unsupported',
        },
      );
      expect(github).toHaveBeenCalledTimes(1);
    },
  );
  it('accepts GitHub case-insensitive repository identity without defaulting visibility', async () => {
    github.mockReset();
    respond({ ...publicRepository(), full_name: repository.toUpperCase() });
    respond(environment());
    await expect(requireSigningEnvironment(repository)).resolves.toMatchObject({
      repository_visibility: 'public',
    });
  });
  it('does not read environment controls after a failed repository lookup', async () => {
    github.mockReset();
    github.mockRejectedValueOnce(
      Object.assign(new Error(marker), { code: 1, stderr: marker }),
    );
    await expect(requireSigningEnvironment(repository)).rejects.toMatchObject({
      code: 'signing_metadata_unavailable',
      message: expect.not.stringContaining(marker),
    });
    expect(github).toHaveBeenCalledTimes(1);
  });
  it('does not read environment controls after malformed repository JSON', async () => {
    github.mockReset();
    github.mockResolvedValueOnce({ stdout: '{invalid' });
    await expect(requireSigningEnvironment(repository)).rejects.toMatchObject({
      code: 'signing_metadata_invalid',
    });
    expect(github).toHaveBeenCalledTimes(1);
  });
  it('freshly rejects a public-to-private conversion between admission and candidate recheck', async () => {
    respond(environment());
    await requireSigningEnvironment(repository);
    respond({ ...publicRepository(), private: true, visibility: 'private' });
    respond(environment());
    await expect(requireSigningEnvironment(repository)).rejects.toMatchObject({
      code: 'signing_repository_unsupported',
    });
    expect(github).toHaveBeenCalledTimes(3);
    expect(github.mock.calls[2][1].at(-1)).toBe(`repos/${repository}`);
  });
  it('binds admission to a manual GitHub.com main workflow without reading signing credentials', () => {
    expect(signingContext(context)).toEqual({
      repository,
      source_commit: context.GITHUB_SHA,
    });
    expect(github).not.toHaveBeenCalled();
  });
  it.each([
    ['GITHUB_ACTIONS', undefined],
    ['GITHUB_ACTIONS', 'false'],
    ['GITHUB_EVENT_NAME', 'push'],
    ['GITHUB_EVENT_NAME', 'pull_request'],
    ['GITHUB_REF', 'refs/heads/other'],
    ['GITHUB_REF', 'refs/tags/main'],
    ['GITHUB_SERVER_URL', 'https://untrusted.example'],
    ['GITHUB_API_URL', 'https://untrusted.example'],
    ['GITHUB_SHA', 'a'.repeat(39)],
    ['GITHUB_SHA', 'a'.repeat(40) + '\n'],
    ['GITHUB_SHA', 'g'.repeat(40)],
    ['GITHUB_REPOSITORY', undefined],
    ['GITHUB_REPOSITORY', 'owner/../notes'],
    ['GITHUB_REPOSITORY', 'owner/..'],
    ['GITHUB_REPOSITORY', 'owner/.'],
    ['GITHUB_REPOSITORY', repository + '\n'],
    ['GITHUB_REPOSITORY', 'owner/notes?host=other'],
  ])('rejects invalid context %s=%s before metadata access', (key, value) => {
    expect(() => signingContext({ ...context, [key]: value })).toThrow(
      expect.objectContaining({ code: 'signing_context_invalid' }),
    );
    expect(github).not.toHaveBeenCalled();
  });
  it.each([undefined, null, '', 'owner/..', 'owner/notes\n'])(
    'rejects invalid repository %s before metadata access',
    async (value) => {
      await expect(requireSigningEnvironment(value)).rejects.toMatchObject({
        code: 'signing_context_invalid',
      });
      expect(github).not.toHaveBeenCalled();
    },
  );
  it('accepts configured selected-ref controls without inventing owner review/bypass policy or disclosing reviewer metadata', async () => {
    respond(environment());
    const result = await requireSigningEnvironment(repository);
    expect(result).toEqual({
      version: 1,
      kind: 'signing_environment_preflight',
      repository_visibility: 'public',
      environment: 'signed-release',
      required_reviewers_configured: true,
      branch_policy: 'selected_branches_and_tags',
      production_accepted: false,
    });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(github).toHaveBeenCalledTimes(2);
    expect(github.mock.calls[0][1].at(-1)).toBe(`repos/${repository}`);
    expect(github).toHaveBeenCalledWith(
      'gh',
      [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'GET',
        '-H',
        'Accept: application/vnd.github+json',
        '-H',
        'X-GitHub-Api-Version: 2022-11-28',
        `repos/${repository}/environments/signed-release`,
      ],
      {
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
    );
  });
  it('accepts Team reviewers and case-insensitive environment names', async () => {
    const value = environment();
    value.name = 'Signed-Release';
    value.protection_rules[0].reviewers[0].type = 'Team';
    respond(value);
    await expect(requireSigningEnvironment(repository)).resolves.toMatchObject({
      required_reviewers_configured: true,
    });
  });
  it('requires a fresh protected-main read for protected-branches-only controls', async () => {
    const value = environment();
    value.deployment_branch_policy = {
      protected_branches: true,
      custom_branch_policies: false,
    };
    respond(value);
    respond({ name: 'main', protected: true });
    await expect(requireSigningEnvironment(repository)).resolves.toMatchObject({
      branch_policy: 'protected_main',
      production_accepted: false,
    });
    expect(github).toHaveBeenCalledTimes(3);
    expect(github.mock.calls[2][1]).toEqual([
      ...github.mock.calls[1][1].slice(0, -1),
      `repos/${repository}/branches/main`,
    ]);
  });
  it.each(
    [
      null,
      [],
      {},
      { ...environment(), id: 0 },
      { ...environment(), id: '1' },
      { ...environment(), name: 'other' },
      { ...environment(), protection_rules: null },
      { ...environment(), protection_rules: {} },
    ].map((value) => [value]),
  )('rejects invalid environment metadata %j', async (value) => {
    respond(value);
    await expect(requireSigningEnvironment(repository)).rejects.toMatchObject({
      code: 'signing_metadata_invalid',
    });
  });
  it.each(
    [
      [],
      [{ type: 'wait_timer', wait_timer: 1 }],
      [{ type: 'required_reviewers', reviewers: [] }],
      [{ type: 'required_reviewers', reviewers: null }],
      [{ type: 'required_reviewers', reviewers: [{ type: 'User' }] }],
      [
        {
          type: 'required_reviewers',
          reviewers: [{ type: 'User', reviewer: { id: 0 } }],
        },
      ],
      [
        {
          type: 'required_reviewers',
          reviewers: [{ type: 'Bot', reviewer: { id: 1 } }],
        },
      ],
      [
        { type: 'required_reviewers', reviewers: [] },
        ...environment().protection_rules,
      ],
    ].map((rules) => [rules]),
  )(
    'rejects absent, malformed or ambiguous reviewer rules %j',
    async (rules) => {
      respond({ ...environment(), protection_rules: rules });
      await expect(requireSigningEnvironment(repository)).rejects.toMatchObject(
        {
          code: 'signing_environment_unprotected',
        },
      );
      expect(github).toHaveBeenCalledTimes(2);
    },
  );
  it.each(
    [
      null,
      {},
      { protected_branches: false, custom_branch_policies: false },
      { protected_branches: true, custom_branch_policies: true },
      { protected_branches: 'true', custom_branch_policies: false },
      { protected_branches: true },
      [],
    ].map((policy) => [policy]),
  )('rejects unrestricted or invalid branch policy %j', async (policy) => {
    respond({ ...environment(), deployment_branch_policy: policy });
    await expect(requireSigningEnvironment(repository)).rejects.toMatchObject({
      code: 'signing_environment_unprotected',
    });
    expect(github).toHaveBeenCalledTimes(2);
  });
  it.each([
    null,
    {},
    { name: 'other', protected: true },
    { name: 'main', protected: false },
    { name: 'main', protected: 'true' },
  ])('rejects unprotected or ambiguous main metadata %j', async (branch) => {
    respond({
      ...environment(),
      deployment_branch_policy: {
        protected_branches: true,
        custom_branch_policies: false,
      },
    });
    respond(branch);
    await expect(requireSigningEnvironment(repository)).rejects.toMatchObject({
      code: 'signing_main_unprotected',
    });
  });
  it.each(['', '{invalid', 'null', '[]'])(
    'rejects malformed or invalid API JSON %j',
    async (stdout) => {
      github.mockResolvedValueOnce({ stdout });
      await expect(requireSigningEnvironment(repository)).rejects.toMatchObject(
        {
          code: 'signing_metadata_invalid',
        },
      );
    },
  );
  it.each([
    'HTTP 403',
    'HTTP 404',
    'ETIMEDOUT',
    'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  ])(
    'fails explicitly on %s without copying upstream output or retrying',
    async (code) => {
      github.mockRejectedValueOnce(
        Object.assign(new Error(marker), { code, stderr: marker }),
      );
      await expect(requireSigningEnvironment(repository)).rejects.toMatchObject(
        {
          code: 'signing_metadata_unavailable',
          message: expect.not.stringContaining(marker),
        },
      );
      expect(github).toHaveBeenCalledTimes(2);
    },
  );
  it('does not reuse an earlier successful metadata check', async () => {
    respond(environment());
    respond(publicRepository());
    respond({ ...environment(), protection_rules: [] });
    await requireSigningEnvironment(repository);
    await expect(requireSigningEnvironment(repository)).rejects.toMatchObject({
      code: 'signing_environment_unprotected',
    });
    expect(github).toHaveBeenCalledTimes(4);
  });
  it('fails explicitly when the bounded metadata process is terminated at its deadline', async () => {
    github.mockRejectedValueOnce(
      Object.assign(new Error(marker), {
        code: null,
        killed: true,
        signal: 'SIGTERM',
      }),
    );
    await expect(requireSigningEnvironment(repository)).rejects.toMatchObject({
      code: 'signing_metadata_unavailable',
      message: expect.not.stringContaining(marker),
    });
  });
  it('does not misclassify unexpected implementation errors as metadata access failures', async () => {
    const error = new TypeError('synthetic implementation failure');
    github.mockRejectedValueOnce(error);
    await expect(requireSigningEnvironment(repository)).rejects.toBe(error);
  });
  it('rejects a real CLI invocation with invalid context without disclosing environment values', () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./signing-admission.mjs', import.meta.url))],
      {
        env: {
          ...context,
          GITHUB_REF: 'refs/heads/other',
          GH_TOKEN: marker,
          WINDOWS_SIGNING_PFX_BASE64: marker,
        },
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('signing_context_invalid:');
    expect(result.stderr).not.toContain(marker);
  });
  it('requires read-only admission before entering the signing environment and rechecks before dependency installation', async () => {
    const workflow = await readFile(
      new URL('../../.github/workflows/signed-candidate.yml', import.meta.url),
      'utf8',
    );
    expect(workflow).toMatch(/^  admission:\n/m);
    const admission = workflow.slice(
      workflow.indexOf('  admission:\n'),
      workflow.indexOf('  candidate:\n'),
    );
    const candidate = workflow.slice(workflow.indexOf('  candidate:\n'));
    expect(admission).not.toMatch(/^\s+environment:|secrets\./m);
    expect(admission).toContain("if: github.ref == 'refs/heads/main'");
    expect(admission).toContain(
      'Require successful Checks for this exact main commit',
    );
    expect(admission).toContain(
      '--workflow ci.yml --commit $env:GITHUB_SHA --branch main --event push --status success',
    );
    expect(admission).toContain(
      "if ($verified.Count -eq 0) { throw 'This exact main commit needs successful Checks before signing.' }",
    );
    expect(admission.indexOf('gh run list')).toBeLessThan(
      admission.indexOf('uses: actions/checkout@'),
    );
    expect(admission).toContain('node apps/desktop/signing-admission.mjs');
    expect(candidate).toMatch(/^\s+needs: admission$/m);
    expect(candidate).toMatch(/^\s+environment: signed-release$/m);
    expect(candidate).toContain("if: github.ref == 'refs/heads/main'");
    const recheck = candidate.indexOf(
      'node apps/desktop/signing-admission.mjs',
    );
    expect(recheck).toBeGreaterThan(0);
    expect(recheck).toBeLessThan(
      candidate.indexOf('pnpm install --frozen-lockfile'),
    );
    expect(recheck).toBeLessThan(
      candidate.indexOf('secrets.WINDOWS_SIGNING_PFX_BASE64'),
    );
    expect(workflow).toMatch(/activation_acceptance:[\s\S]*?default: false/);
    expect(workflow).not.toMatch(
      /^\s+(?:deployments|contents|actions): write$/m,
    );
    const actions = [...workflow.matchAll(/^\s+(?:- )?uses: (\S+)/gm)];
    expect(actions).toHaveLength(6);
    for (const [, action] of actions)
      expect(action).toMatch(/^actions\/[\w-]+@[0-9a-f]{40}$/);
  });
});
