import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const repositoryName = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
const validRepository = (value) =>
  typeof value === 'string' &&
  value === value.trim() &&
  repositoryName.test(value) &&
  !['.', '..'].includes(value.split('/')[1]);
const environmentName = 'signed-release';
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;

export class SigningAdmissionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function signingContext(environment) {
  if (
    !object(environment) ||
    environment.GITHUB_ACTIONS !== 'true' ||
    environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    environment.GITHUB_REF !== 'refs/heads/main' ||
    environment.GITHUB_SERVER_URL !== 'https://github.com' ||
    environment.GITHUB_API_URL !== 'https://api.github.com' ||
    !validRepository(environment.GITHUB_REPOSITORY) ||
    typeof environment.GITHUB_SHA !== 'string' ||
    environment.GITHUB_SHA.length !== 40 ||
    !/^[0-9a-f]{40}$/.test(environment.GITHUB_SHA)
  )
    throw new SigningAdmissionError(
      'signing_context_invalid',
      'Signing admission requires a manual GitHub.com main-branch workflow run.',
    );
  return {
    repository: environment.GITHUB_REPOSITORY,
    source_commit: environment.GITHUB_SHA,
  };
}

async function githubMetadata(endpoint) {
  let stdout;
  try {
    ({ stdout } = await execute(
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
        endpoint,
      ],
      {
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
    ));
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !(
        typeof error.code === 'string' ||
        typeof error.code === 'number' ||
        error.killed === true
      )
    )
      throw error;
    throw new SigningAdmissionError(
      'signing_metadata_unavailable',
      'Could not read signing protection metadata; configure the environment and verify read access.',
    );
  }
  try {
    return JSON.parse(stdout);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new SigningAdmissionError(
      'signing_metadata_invalid',
      'GitHub returned invalid signing protection metadata.',
    );
  }
}

export async function requireSigningEnvironment(repository) {
  if (!validRepository(repository))
    throw new SigningAdmissionError(
      'signing_context_invalid',
      'A valid GitHub repository is required.',
    );
  const prefix = `repos/${repository}`;
  const source = await githubMetadata(prefix);
  if (
    !object(source) ||
    !positiveId(source.id) ||
    typeof source.full_name !== 'string' ||
    source.full_name.toLowerCase() !== repository.toLowerCase() ||
    typeof source.private !== 'boolean' ||
    !['public', 'private', 'internal'].includes(source.visibility)
  )
    throw new SigningAdmissionError(
      'signing_metadata_invalid',
      'GitHub returned missing, invalid or mismatched repository metadata.',
    );
  if (source.private || source.visibility !== 'public')
    throw new SigningAdmissionError(
      'signing_repository_unsupported',
      'This workflow requires a public repository; private/internal protection availability has not been verified.',
    );
  const environment = await githubMetadata(
    `${prefix}/environments/${environmentName}`,
  );
  if (
    !object(environment) ||
    !positiveId(environment.id) ||
    typeof environment.name !== 'string' ||
    environment.name.toLowerCase() !== environmentName ||
    !Array.isArray(environment.protection_rules)
  )
    throw new SigningAdmissionError(
      'signing_metadata_invalid',
      'The signed-release environment metadata is missing or invalid.',
    );
  const reviewers = environment.protection_rules.filter(
    (rule) => object(rule) && rule.type === 'required_reviewers',
  );
  const policy = environment.deployment_branch_policy;
  if (
    reviewers.length !== 1 ||
    !Array.isArray(reviewers[0].reviewers) ||
    reviewers[0].reviewers.length === 0 ||
    !reviewers[0].reviewers.every(
      (entry) =>
        object(entry) &&
        (entry.type === 'User' || entry.type === 'Team') &&
        object(entry.reviewer) &&
        positiveId(entry.reviewer.id),
    ) ||
    !object(policy) ||
    typeof policy.protected_branches !== 'boolean' ||
    typeof policy.custom_branch_policies !== 'boolean' ||
    policy.protected_branches === policy.custom_branch_policies
  )
    throw new SigningAdmissionError(
      'signing_environment_unprotected',
      'signed-release requires configured reviewers and a deployment branch restriction policy.',
    );
  if (policy.protected_branches) {
    const branch = await githubMetadata(`${prefix}/branches/main`);
    if (!object(branch) || branch.name !== 'main' || branch.protected !== true)
      throw new SigningAdmissionError(
        'signing_main_unprotected',
        'Protected-branches-only signing requires main to be protected.',
      );
  }
  return {
    version: 1,
    kind: 'signing_environment_preflight',
    repository_visibility: 'public',
    environment: environmentName,
    required_reviewers_configured: true,
    branch_policy: policy.protected_branches
      ? 'protected_main'
      : 'selected_branches_and_tags',
    production_accepted: false,
  };
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    const context = signingContext(process.env);
    const result = await requireSigningEnvironment(context.repository);
    console.log(
      JSON.stringify({ ...result, source_commit: context.source_commit }),
    );
  } catch (error) {
    console.error(
      error instanceof SigningAdmissionError
        ? `${error.code}: ${error.message}`
        : 'signing_admission_failed: Signing protection verification failed.',
    );
    process.exitCode = 1;
  }
}
