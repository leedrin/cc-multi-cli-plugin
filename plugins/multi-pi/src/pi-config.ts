import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type PiProviderId, piProvider, validatedPiKey, validatedStrataUrl } from './providers.ts';

/**
 * Pi's own upstream addresses for the providers Multi serves. Kept here so reading Pi
 * config never loads pi-ai; `pi-config.test.ts` asserts they match pi-ai's descriptors.
 */
export const PI_UPSTREAM_BASE_URLS: Readonly<Record<'deepseek' | 'zai' | 'zai-coding-cn', string>> =
  {
    deepseek: 'https://api.deepseek.com',
    zai: 'https://api.z.ai/api/coding/paas/v4',
    'zai-coding-cn': 'https://open.bigmodel.cn/api/coding/paas/v4',
  };

type AuthProviderId = keyof typeof PI_UPSTREAM_BASE_URLS;
type PiConfigFile = 'auth.json' | 'models.json';

export type PiConfigFileReader = (file: string) => string | undefined;

export interface PiConfigInput {
  env: NodeJS.ProcessEnv;
  /** Pi providers whose key the environment did not supply. */
  providers: readonly PiProviderId[];
  /** True when Strata is enabled and `MULTI_STRATA_BASE_URL` is unset. */
  strataBaseUrl: boolean;
  platform?: NodeJS.Platform;
  homedir?: string;
  readFile?: PiConfigFileReader;
}

export interface PiConfigResult {
  /** Credential environment variable name → key, only for requested providers. */
  credentials: Map<string, string>;
  strataBaseUrl?: string;
  /** Environment variables a Pi `apiKey` referenced and Multi adopted. */
  consumedEnv: string[];
  /** Providers whose key came from Pi config. */
  sources: PiProviderId[];
}

interface Candidate {
  file: PiConfigFile;
  raw: string;
}

class PiConfigError extends Error {
  constructor(file: PiConfigFile | undefined, reason: string) {
    super(
      `Pi config${file === undefined ? '' : `: ${file}`}: ${reason} Set MULTI_PI_CONFIG=0 to ignore Pi config.`,
    );
    this.name = 'PiConfigError';
  }
}

function defaultReadFile(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return undefined;
    }
    throw new PiConfigError(path.basename(file) as PiConfigFile, 'cannot be read.');
  }
}

export function piConfigDirectory(env: NodeJS.ProcessEnv, homedir: string = os.homedir()): string {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  return override ? override : path.join(homedir, '.pi', 'agent');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseObject(
  file: PiConfigFile,
  text: string | undefined,
): Record<string, unknown> | undefined {
  if (text === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The parser message can quote file content, so it is never surfaced.
    throw new PiConfigError(file, 'cannot be parsed as JSON.');
  }
  if (!isObject(parsed)) {
    throw new PiConfigError(file, 'has an unexpected structure.');
  }
  return parsed;
}

function optionalString(file: PiConfigFile, entry: Record<string, unknown>, field: string) {
  const value = entry[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new PiConfigError(file, 'has an unexpected structure.');
  }
  return value;
}

function comparableUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

function upstreamOwner(baseUrl: string): AuthProviderId | undefined {
  const comparable = comparableUrl(baseUrl);
  return (Object.keys(PI_UPSTREAM_BASE_URLS) as AuthProviderId[]).find(
    (id) => comparableUrl(PI_UPSTREAM_BASE_URLS[id]) === comparable,
  );
}

function authCandidates(
  auth: Record<string, unknown> | undefined,
  providers: ReadonlySet<PiProviderId>,
): [PiProviderId, Candidate][] {
  const found: [PiProviderId, Candidate][] = [];
  for (const id of Object.keys(PI_UPSTREAM_BASE_URLS) as AuthProviderId[]) {
    const entry = auth?.[id];
    if (!providers.has(id) || entry === undefined) {
      continue;
    }
    if (!isObject(entry)) {
      throw new PiConfigError('auth.json', 'has an unexpected structure.');
    }
    const key = optionalString('auth.json', entry, 'key');
    if (entry.type === 'api_key' && key !== undefined) {
      found.push([id, { file: 'auth.json', raw: key }]);
    }
  }
  return found;
}

function modelsProviders(models: Record<string, unknown> | undefined) {
  const providers = models?.providers;
  if (providers === undefined) {
    return {};
  }
  if (!isObject(providers)) {
    throw new PiConfigError('models.json', 'has an unexpected structure.');
  }
  return providers;
}

function modelCandidates(
  providers: Record<string, unknown>,
  wanted: ReadonlySet<PiProviderId>,
): [PiProviderId, Candidate][] {
  const found: [PiProviderId, Candidate][] = [];
  for (const [name, entry] of Object.entries(providers)) {
    if (name === 'strata' || !isObject(entry)) {
      continue;
    }
    const baseUrl = optionalString('models.json', entry, 'baseUrl');
    const owner = baseUrl === undefined ? undefined : upstreamOwner(baseUrl);
    const apiKey = optionalString('models.json', entry, 'apiKey');
    if (owner !== undefined && wanted.has(owner) && apiKey !== undefined) {
      found.push([owner, { file: 'models.json', raw: apiKey }]);
    }
  }
  return found;
}

function strataEntry(providers: Record<string, unknown>): Record<string, unknown> | undefined {
  const entry = providers.strata;
  if (entry === undefined) {
    return undefined;
  }
  if (!isObject(entry)) {
    throw new PiConfigError('models.json', 'has an unexpected structure.');
  }
  return entry;
}

function environmentReference(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  const exact = Object.hasOwn(env, name) ? name : undefined;
  const match =
    exact ??
    (platform === 'win32'
      ? Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase())
      : undefined);
  return match !== undefined && validatedPiKey(env[match]) ? match : undefined;
}

interface ResolvedValue {
  value: string;
  reference?: string;
}

function resolveValue(
  candidate: Candidate,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ResolvedValue | undefined {
  const trimmed = candidate.raw.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (trimmed.startsWith('!')) {
    throw new PiConfigError(candidate.file, 'command values (!command) are not supported.');
  }
  const reference = environmentReference(env, trimmed, platform);
  if (reference !== undefined) {
    return { value: env[reference] as string, reference };
  }
  return { value: trimmed };
}

function chooseValue(
  id: PiProviderId,
  candidates: readonly Candidate[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ResolvedValue | undefined {
  const resolved = candidates.flatMap((candidate) => resolveValue(candidate, env, platform) ?? []);
  const distinct = new Set(resolved.map(({ value }) => value));
  if (distinct.size > 1) {
    const files = [...new Set(candidates.map(({ file }) => file))].join(', ');
    throw new PiConfigError(undefined, `${id} has more than one different credential (${files}).`);
  }
  return resolved[0];
}

function strataUrl(entry: Record<string, unknown> | undefined): string | undefined {
  const baseUrl = entry === undefined ? undefined : optionalString('models.json', entry, 'baseUrl');
  if (baseUrl === undefined || baseUrl.trim() === '') {
    return undefined;
  }
  try {
    validatedStrataUrl(baseUrl.trim());
  } catch (error) {
    throw new PiConfigError('models.json', `strata ${(error as Error).message}`);
  }
  return baseUrl.trim();
}

function collectCandidates(
  input: PiConfigInput,
  auth: Record<string, unknown> | undefined,
  providers: Record<string, unknown>,
): Map<PiProviderId, Candidate[]> {
  const wanted = new Set(input.providers);
  const byProvider = new Map<PiProviderId, Candidate[]>();
  const strata = wanted.has('strata') ? strataEntry(providers) : undefined;
  const strataKey =
    strata === undefined ? undefined : optionalString('models.json', strata, 'apiKey');
  const strataCandidates: [PiProviderId, Candidate][] =
    strataKey === undefined ? [] : [['strata', { file: 'models.json', raw: strataKey }]];
  for (const [id, candidate] of [
    ...authCandidates(auth, wanted),
    ...modelCandidates(providers, wanted),
    ...strataCandidates,
  ]) {
    byProvider.set(id, [...(byProvider.get(id) ?? []), candidate]);
  }
  return byProvider;
}

/**
 * Reads `auth.json` and `models.json` from the Pi agent directory and returns credentials
 * for the requested providers only. Never executes `!command` values and never surfaces
 * file content, keys or URL secrets in errors.
 */
export function readPiConfigCredentials(input: PiConfigInput): PiConfigResult {
  const result: PiConfigResult = { credentials: new Map(), consumedEnv: [], sources: [] };
  if (input.providers.length === 0 && !input.strataBaseUrl) {
    return result;
  }
  const platform = input.platform ?? process.platform;
  const directory = piConfigDirectory(input.env, input.homedir);
  const readFile = input.readFile ?? defaultReadFile;
  const auth =
    input.providers.length === 0
      ? undefined
      : parseObject('auth.json', readFile(path.join(directory, 'auth.json')));
  const providers = modelsProviders(
    parseObject('models.json', readFile(path.join(directory, 'models.json'))),
  );
  for (const [id, candidates] of collectCandidates(input, auth, providers)) {
    const chosen = chooseValue(id, candidates, input.env, platform);
    if (chosen === undefined) {
      continue;
    }
    result.credentials.set(piProvider(id).credentialEnv, chosen.value);
    result.sources.push(id);
    if (chosen.reference !== undefined && !result.consumedEnv.includes(chosen.reference)) {
      result.consumedEnv.push(chosen.reference);
    }
  }
  if (input.strataBaseUrl) {
    const url = strataUrl(strataEntry(providers));
    if (url !== undefined) {
      result.strataBaseUrl = url;
    }
  }
  return result;
}
