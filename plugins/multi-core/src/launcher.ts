#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AntigravityHarness } from '../../multi-antigravity/src/harness.ts';
import {
  checkAntigravityHooks,
  installAntigravityHook,
} from '../../multi-antigravity/src/hooks.ts';
import {
  type AntigravityModel,
  antigravityDefaultWorkerModel,
  antigravityPickerOptions,
  discoverAntigravityModels,
} from '../../multi-antigravity/src/models.ts';
import { antigravityPermissionPolicy } from '../../multi-antigravity/src/permissions.ts';
import { discoverAntigravity } from '../../multi-antigravity/src/provider.ts';
import { antigravityUsageReader } from '../../multi-antigravity/src/usage-adapter.ts';
import type { Effort } from '../../multi-core/src/gateway/responses.ts';
import { CursorHarness } from '../../multi-cursor/src/harness.ts';
import type { CursorModelOption } from '../../multi-cursor/src/models.ts';
import { CURSOR_DEFAULT_WORKER_MODEL, cursorPickerOptions } from '../../multi-cursor/src/models.ts';
import { cursorPermissionPolicy } from '../../multi-cursor/src/permissions.ts';
import { discoverCursor } from '../../multi-cursor/src/provider.ts';
import { cursorUsageReader } from '../../multi-cursor/src/usage-adapter.ts';
import { CursorWorkspaces } from '../../multi-cursor/src/workspaces.ts';
import { GrokHarness } from '../../multi-grok/src/harness.ts';
import {
  discoverGrokModels,
  type GrokModel,
  grokDefaultWorkerModel,
  grokPickerOptions,
} from '../../multi-grok/src/models.ts';
import { grokPermissionPolicy } from '../../multi-grok/src/permissions.ts';
import { discoverGrok } from '../../multi-grok/src/provider.ts';
import { grokUsageReader } from '../../multi-grok/src/usage-adapter.ts';
import { createOpenAIReviewer } from '../../multi-openai/src/approval.ts';
import {
  MODELS,
  OPENAI_DEFAULT_WORKER_MODEL,
  OPENAI_WORKER_EFFORT,
} from '../../multi-openai/src/models.ts';
import { discoverOpenAI } from '../../multi-openai/src/provider.ts';
import { openAIUsageReader } from '../../multi-openai/src/usage-adapter.ts';
import { filterPiModelsForProvider } from '../../multi-pi/src/catalog.ts';
import {
  PI_PROVIDERS,
  strataUrlUsesLoopback,
  validatedPiKey,
  validatedStrataUrl,
} from '../../multi-pi/src/providers.ts';
import {
  ZEN_DEFAULT_WORKER_MODEL,
  ZEN_MODELS,
  ZEN_WORKER_EFFORT,
  zenModelOptions,
  zenPickerOptions,
} from '../../multi-zen/src/models.ts';
import { discoverZen } from '../../multi-zen/src/provider.ts';
import { zenUsageReader } from '../../multi-zen/src/usage-adapter.ts';
import {
  loadWorkerPermissions,
  type PluginPermissionInventory,
  pluginPermissions,
} from './gateway/agent-definitions.ts';
import {
  type BuiltinProviderCredentials,
  createBuiltinRegistry,
} from './gateway/builtin-providers.ts';
import { DISPLAY_TOOL_SERVER } from './gateway/display-rows.ts';
import { executableInvocation, resolveExecutable } from './gateway/executable.ts';
import {
  checkHarnessSettings,
  type HarnessSettingsOptions,
  mergePermissions,
} from './gateway/harness-settings.ts';
import { ModBridge } from './gateway/mod-bridge.ts';
import { PermissionModes } from './gateway/mode-hook.ts';
import { decodeModelRoute, encodeModelRoute } from './gateway/model-identity.ts';
import { nestedClaudeShim, withPathPrefix } from './gateway/nested-env.ts';
import { nativeSpelling } from './gateway/provider.ts';
import { takeProviderCredentials } from './gateway/provider-credentials.ts';
import { PROVIDER_FACTS, type ProviderId } from './gateway/provider-facts.ts';
import {
  type ActiveProvider,
  type ModelDescriptor,
  type ProviderDescriptor,
  type ProviderDiscoveryContext,
  type ProviderRegistry,
  ProviderRuntime,
} from './gateway/provider-registry.ts';
import type { ProviderUsageReader } from './gateway/provider-usage.ts';
import { ReceiptLedger } from './gateway/receipts.ts';
import type { GatewayEvent } from './gateway/server.ts';
import { createNativeGateway } from './gateway/server.ts';
import {
  buildWorkerCatalog,
  type WorkerCatalog,
  workerDescription,
} from './gateway/worker-catalog.ts';
import { providerSelection } from './install/plugins.ts';
import { needsEnvProxy, rememberOriginalEnvironment, withoutGateway } from './install/process.ts';
import {
  discoverAntigravityWithHook,
  discoverEnabledProviders,
  providerExplicit,
} from './provider-discovery.ts';

const enabledProviders = providerSelection(process.env.MULTI_ENABLED_PROVIDERS);
const enabledProviderIds: readonly string[] | undefined = enabledProviders;
/** Explicit map entries, including blank values, override the inherited environment. */
function effectiveCredentialValue(
  credentialEnv: string,
  env: NodeJS.ProcessEnv,
  credentials: ReadonlyMap<string, string>,
): string | undefined {
  return credentials.has(credentialEnv) ? credentials.get(credentialEnv) : env[credentialEnv];
}

const discoveryContext = (
  provider: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  credentials: ReadonlyMap<string, string> = new Map(),
  descriptor: ProviderDescriptor | undefined = undefined,
  selectedProviderIds: readonly string[] | undefined = enabledProviderIds,
): ProviderDiscoveryContext => {
  const env = { ...baseEnv };
  for (const name of descriptor?.credentialEnv ?? []) {
    env[name] = effectiveCredentialValue(name, baseEnv, credentials);
  }
  return {
    cwd: process.cwd(),
    env,
    explicit: providerExplicit(provider, selectedProviderIds),
    log: (message: string) => console.error(message),
  };
};
const claudeExecutable = process.env.MULTI_REAL_CLAUDE;

export type LaunchRegistryFactory = (credentials?: BuiltinProviderCredentials) => ProviderRegistry;

/** One registration path shared by launcher discovery and runtime assembly. */
export function createLaunchRegistry(credentials?: BuiltinProviderCredentials): ProviderRegistry {
  return createBuiltinRegistry(credentials);
}

function validatePiModelSelection(
  enabledDescriptors: readonly ProviderDescriptor[],
  env: NodeJS.ProcessEnv,
  credentials: ReadonlyMap<string, string>,
): void {
  const hasPiKey = PI_PROVIDERS.some(
    ({ id, credentialEnv }) =>
      id !== 'strata' &&
      enabledDescriptors.some((descriptor) => descriptor.id === id) &&
      validatedPiKey(effectiveCredentialValue(credentialEnv, env, credentials)),
  );
  const strataEnabled = enabledDescriptors.some(({ id }) => id === 'strata');
  const strataUrl = strataEnabled ? validatedStrataUrl(env.MULTI_STRATA_BASE_URL) : undefined;
  const strataKey = effectiveCredentialValue('STRATA_API_KEY', env, credentials);
  if (strataUrl && !strataUrlUsesLoopback(strataUrl) && !validatedPiKey(strataKey)) {
    throw new Error('Strata requires STRATA_API_KEY for a non-loopback base URL.');
  }
  if (hasPiKey || strataUrl) {
    filterPiModelsForProvider('deepseek', env.MULTI_PI_MODELS);
  }
}

function collectGenericModels(
  discovered: Record<string, unknown>,
): Record<string, readonly ModelDescriptor[]> {
  const genericModels: Record<string, readonly ModelDescriptor[]> = {};
  for (const { id } of PROVIDER_FACTS) {
    if (['openai', 'zen', 'cursor', 'antigravity', 'grok'].includes(id)) {
      continue;
    }
    const models = discovered[id];
    if (Array.isArray(models)) {
      genericModels[id] = models as ModelDescriptor[];
    }
  }
  return genericModels;
}

function launchProviderAvailable(
  id: string,
  registry: ProviderRegistry,
  discovered: Record<string, unknown>,
  explicitlyAvailable: ReadonlyMap<string, boolean>,
  genericModels: Record<string, readonly ModelDescriptor[]>,
): boolean {
  return Boolean(
    registry.get(id) &&
      Object.hasOwn(discovered, id) &&
      (explicitlyAvailable.get(id) ?? (genericModels[id]?.length ?? 0) > 0),
  );
}

export async function discoverLaunchProviders(
  registryFactory: LaunchRegistryFactory = createLaunchRegistry,
  selectedProviderIds: readonly string[] | undefined = enabledProviderIds,
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    credentials?: ReadonlyMap<string, string>;
  } = {},
) {
  const registry = registryFactory();
  const env = options.env ?? process.env;
  const enabledDescriptors = registry
    .list()
    .filter(({ id }) => selectedProviderIds === undefined || selectedProviderIds.includes(id));
  const credentials =
    options.credentials ??
    takeProviderCredentials(env, enabledDescriptors, {
      platform: options.platform,
    });
  validatePiModelSelection(enabledDescriptors, env, credentials);
  const discoveries = {
    openai: (context: ProviderDiscoveryContext) => discoverOpenAI(context),
    zen: (context: ProviderDiscoveryContext) => discoverZen(context),
    cursor: (context: ProviderDiscoveryContext) => discoverCursor(context, false),
    antigravity: (context: ProviderDiscoveryContext) =>
      discoverAntigravityWithHook(context, discoverAntigravity, installAntigravityHook),
    grok: (context: ProviderDiscoveryContext) => discoverGrok(context),
  };
  const discovered = await discoverEnabledProviders(
    registry,
    selectedProviderIds,
    discoveries,
    (provider) =>
      discoveryContext(provider, env, credentials, registry.get(provider), selectedProviderIds),
  );
  const codexSignedIn = discovered.openai?.codexSignedIn ?? false;
  const cursorModels = discovered.cursor?.cursorModels ?? [];
  const antigravityModels = discovered.antigravity ?? [];
  const grokModels = discovered.grok ?? [];
  const zenKey = discovered.zen;
  const genericModels = collectGenericModels(discovered as Record<string, unknown>);
  const explicitlyAvailable = new Map<string, boolean>([
    ['openai', codexSignedIn],
    ['zen', Boolean(zenKey)],
    ['cursor', cursorModels.length > 0],
    ['antigravity', antigravityModels.length > 0],
    ['grok', grokModels.length > 0],
  ]);
  const availableProviderIds = PROVIDER_FACTS.filter(({ id }) =>
    launchProviderAvailable(
      id,
      registry,
      discovered as Record<string, unknown>,
      explicitlyAvailable,
      genericModels,
    ),
  ).map(({ id }) => id);
  return {
    codexSignedIn,
    openaiReview: discovered.openai?.openaiReview ?? false,
    cursorModels,
    zenKey,
    antigravityModels,
    grokModels,
    genericModels,
    deepseekKey: credentials.get('DEEPSEEK_API_KEY'),
    piKeys: {
      ...(credentials.get('DEEPSEEK_API_KEY') === undefined
        ? {}
        : { deepseek: credentials.get('DEEPSEEK_API_KEY') }),
      ...(credentials.get('ZAI_API_KEY') === undefined
        ? {}
        : { zai: credentials.get('ZAI_API_KEY') }),
      ...(credentials.get('ZAI_CODING_CN_API_KEY') === undefined
        ? {}
        : { 'zai-coding-cn': credentials.get('ZAI_CODING_CN_API_KEY') }),
      ...(credentials.get('STRATA_API_KEY') === undefined
        ? {}
        : { strata: credentials.get('STRATA_API_KEY') }),
    },
    strataBaseUrl: env.MULTI_STRATA_BASE_URL,
    availableProviderIds,
  };
}

/**
 * Claude Code requires a non-empty subagent prompt. Workers get no behavioral rules here;
 * provider profiles and Claude's native subagent prompt govern them.
 */
const WORKER_PROMPT = 'Complete the delegated task.';

/**
 * A native harness worker's tools. The Claude tools bound what the harness may
 * do natively; `mcp__multi-core` admits the display rows the gateway writes into
 * the worker's own transcript (Claude Code runs a subagent's tool_use only for a
 * tool its definition lists). The permission mappers drop that entry: it grants
 * no native capability, and the mod refuses any row the gateway did not issue.
 */
const CLAUDE_WORKER_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'];
const HARNESS_WORKER_TOOLS = [...CLAUDE_WORKER_TOOLS, DISPLAY_TOOL_SERVER];

/** One `--agents` entry: an external worker using Claude Code's native tools. */
interface AgentDefinition {
  description: string;
  prompt: string;
  model: string;
  tools: string[];
  effort?: Effort;
}

/** One `/model` entry the launched session offers. */
interface ModelOption {
  behavesAs?: string;
  model: string;
  label: string;
  description: string;
}

interface LaunchSettings {
  modelPicker: { options: ModelOption[] };
  permissions?: Record<string, unknown>;
  [key: string]: unknown;
}

interface LauncherMainHooks {
  command?: (command: string | undefined) => Promise<boolean>;
  versionProbe?: () => Promise<void>;
  pluginInventory?: (cwd: string, args: readonly string[]) => Promise<PluginPermissionInventory>;
  anthropicAuth?: () => Promise<boolean>;
  discovery?: typeof discoverLaunchProviders;
  afterProbes?: () => boolean;
}

interface LauncherMainOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  args?: string[];
  hooks?: LauncherMainHooks;
}

async function runLauncherCommand(
  command: string | undefined,
  hooks: LauncherMainHooks | undefined,
): Promise<boolean> {
  if (hooks?.command) {
    return hooks.command(command);
  }
  await handleCommand(command);
  return false;
}

async function runLauncherProbes(options: {
  args: readonly string[];
  credentials: ReadonlyMap<string, string>;
  env: NodeJS.ProcessEnv;
  hooks: LauncherMainHooks | undefined;
  platform: NodeJS.Platform;
  selectedProviders: readonly string[] | undefined;
}) {
  const { args, credentials, env, hooks, platform, selectedProviders } = options;
  await (hooks?.versionProbe ?? assertFunctionHooksSupported)();
  const [pluginInventory, anthropic, discovered] = await Promise.all([
    (hooks?.pluginInventory ?? pluginInventoryOrEmpty)(process.cwd(), args),
    (hooks?.anthropicAuth ?? anthropicSignedIn)(),
    (hooks?.discovery ?? discoverLaunchProviders)(createLaunchRegistry, selectedProviders, {
      env,
      platform,
      credentials,
    }),
  ]);
  return { pluginInventory, anthropic, discovered };
}

function shouldStopAfterProbes(hooks: LauncherMainHooks | undefined): boolean {
  return hooks?.afterProbes?.() ?? false;
}

async function handleEarlyLauncherCommand(
  args: string[],
  hooks: LauncherMainHooks | undefined,
): Promise<boolean> {
  if (await runLauncherCommand(args[0], hooks)) {
    return true;
  }
  if (args[0] === '--cursor-models') {
    const { cursorModels, cursorSignedIn } = await discoverCursor(discoveryContext('cursor'), true);
    printCursorModels(cursorModels, cursorSignedIn);
    return true;
  }
  return false;
}

function normalizeLauncherArgs(args: string[]): void {
  if (args[0] === '--') {
    args.shift();
  }
  validateSessionLaunch(args);
}

export async function main(options: LauncherMainOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const args = options.args ?? process.argv.slice(2);
  const hooks = options.hooks;
  const selectedProviders: readonly string[] | undefined = providerSelection(
    env.MULTI_ENABLED_PROVIDERS,
  );
  const credentialRegistry = createLaunchRegistry();
  const credentialDescriptors = credentialRegistry
    .list()
    .filter(({ id }) => selectedProviders === undefined || selectedProviders.includes(id));
  const credentials = takeProviderCredentials(env, credentialDescriptors, { platform });
  if (await handleEarlyLauncherCommand(args, hooks)) {
    return;
  }
  normalizeLauncherArgs(args);
  warnIfProxyUnused();
  const pluginRoot = await findPluginRoot(fileURLToPath(import.meta.url));
  const fullCatalog = env.MULTI_MODELS !== undefined;
  const authFile = path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  const { pluginInventory, anthropic, discovered } = await runLauncherProbes({
    args,
    credentials,
    env,
    hooks,
    platform,
    selectedProviders,
  });
  if (shouldStopAfterProbes(hooks)) {
    return;
  }
  const {
    codexSignedIn,
    openaiReview,
    cursorModels,
    zenKey,
    antigravityModels,
    grokModels,
    genericModels,
    piKeys,
    strataBaseUrl,
    availableProviderIds,
  } = discovered;
  const cursorPicker = selectedCursorOptions(cursorModels, fullCatalog);
  const token = randomBytes(32).toString('hex');
  const defaultModels = fullCatalog
    ? pickerSettings(
        codexSignedIn,
        selectedCursorOptions(cursorModels, false),
        Boolean(zenKey),
        antigravityModels,
        grokModels,
        false,
        availableProviderIds,
        genericModels,
      ).modelPicker.options.map((option) => option.model)
    : [];
  const settings = pickerSettings(
    codexSignedIn,
    cursorPicker,
    Boolean(zenKey),
    antigravityModels,
    grokModels,
    fullCatalog,
    availableProviderIds,
    genericModels,
  );
  await mergeSettings(args, settings);
  // Agent view and background sessions are off for this session only, through the
  // session's own settings: nested Claude runs do not read them, unlike an environment
  // variable. The background supervisor does not carry --agents or this session's gateway
  // environment, and outlives the child whose exit releases settingsDir and the gateway,
  // so a session handed to it would lose its workers and its gateway. Ordinary background
  // subagent tasks stay available inside this session.
  settings.disableAgentView = true;
  filterPicker(settings, process.env.MULTI_MODELS, defaultModels);
  const callerSettings = structuredClone(settings);
  const { cursor, antigravity, grok } = nativeHarnesses(
    cursorModels,
    antigravityModels,
    grokModels,
    args,
    callerSettings,
  );
  const usageReaders = providerUsageReaders(authFile, zenKey, { cursor, antigravity, grok });
  const workers = workerCatalog(settings.modelPicker.options, grokModels);
  const workerRegistry = createBuiltinRegistry({ authFile, zenKey, piKeys, strataBaseUrl });
  const agents = workerDefinitions(workers, workerRegistry);
  const modBridge = new ModBridge();
  const settingsDir = await mkdtemp(path.join(os.tmpdir(), 'multi-native-settings-'));
  const callerSettingsFile = path.join(settingsDir, 'caller-settings.json');
  await writeFile(callerSettingsFile, JSON.stringify(callerSettings), { mode: 0o600 });
  const permissionModes = new PermissionModes(
    (cwd) =>
      loadWorkerPermissions(
        cwd,
        agents,
        [...args, '--settings', callerSettingsFile],
        pluginInventory,
      ),
    nativeSettingsCheck({ cursor, antigravity, grok }, args, callerSettings),
    { workers },
  );
  await permissionModes.precompute(process.cwd());
  const reviewers = {
    openai: openaiReview ? await createOpenAIReviewer(authFile, process.cwd()) : undefined,
  };
  const runtime = launcherRuntime(
    authFile,
    zenKey,
    usageReaders,
    { cursor, antigravity, grok },
    reviewers.openai,
    genericModels,
    createLaunchRegistry,
    undefined,
    piKeys,
    strataBaseUrl,
  );
  const receipts = new ReceiptLedger({
    file: process.env.MULTI_RECEIPTS_FILE
      ? path.resolve(process.env.MULTI_RECEIPTS_FILE)
      : undefined,
    onError: (error) => {
      process.stderr.write(`[native] receipt not written: ${String(error)}\n`);
    },
  });
  const server = createNativeGateway({
    receipts,
    billedUsage: cursor?.billedUsageForSession.bind(cursor),
    token,
    enabledProviders,
    modBridge,
    runtime,
    permissionModes,
    // A launch inside another Multi session forwards to the user's own upstream, not the outer gateway.
    anthropicBaseUrl: withoutGateway(process.env).ANTHROPIC_BASE_URL || undefined,
    blockAnthropic: !anthropic,
    onEvent: traceEvent,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Gateway did not bind a local port.');
  }
  const settingsFile = path.join(settingsDir, 'settings.json');
  const { modelArgument } = await initialSelection(args, settings, anthropic);
  if (modelArgument) {
    applyModelArgument(args, modelArgument);
  }
  await writeFile(settingsFile, JSON.stringify(settings), { mode: 0o600 });
  const definitions = JSON.stringify(agents);
  const baseEnvironment = gatewayEnvironment(address.port, token, anthropic, workerRegistry);
  const claudePath = resolveExecutable('claude', {
    configuredPath: claudeExecutable,
    env: baseEnvironment,
  });
  const childEnvironment = await withNestedClaudeShim(baseEnvironment, settingsDir, claudePath);
  const childArguments = launcherArguments(
    args,
    settingsFile,
    definitions,
    pluginInventory,
    pluginRoot,
  );
  const childInvocation = executableInvocation(
    claudePath,
    childArguments,
    process.platform,
    childEnvironment,
  );
  try {
    checkLauncherArgumentLimit(agents, childInvocation, claudePath, process.platform);
  } catch (error) {
    server.close();
    await runtime.close();
    receipts.finishAll();
    await receipts.drain();
    await rm(settingsDir, { recursive: true, force: true });
    throw error;
  }
  const modStart = awaitModSessionStart();
  const child = spawn(childInvocation.command, childInvocation.args, {
    stdio: 'inherit',
    env: childEnvironment,
    detached: process.platform !== 'win32',
    ...childInvocation.options,
  });
  const shutdown = async () => {
    server.closeAllConnections();
    server.close();
    await runtime.close();
    receipts.finishAll();
    await receipts.drain();
    await rm(settingsDir, { recursive: true, force: true });
  };
  // Attached before anything is awaited: a Claude that cannot start, or that exits at
  // once (--version, an argument error), must end the launcher with its own exit code
  // rather than after the mod's acknowledgement times out.
  const exited = new Promise<number>((resolve) => {
    child.once('exit', (code) => resolve(code ?? 1));
  });
  child.once('error', (error) => {
    modStart.cancel();
    console.error(error.message);
    void shutdown().finally(() => process.exit(1));
  });
  await awaitStartOrExit(modStart, exited, child, shutdown);
  void exited.then((code) => shutdown().finally(() => process.exit(code)));
  registerShutdownSignals(child, process.platform);
}

function registerShutdownSignals(
  child: { kill: (signal: NodeJS.Signals) => boolean },
  platform: NodeJS.Platform,
): void {
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  if (platform === 'win32') {
    // Windows console control events do not provide POSIX process groups. Claude's
    // child owns Ctrl+C handling; forward termination explicitly to its process tree.
    process.on('SIGINT', () => {});
    return;
  }
  // Unix foreground terminals deliver SIGINT to both processes; Claude owns its
  // interrupt UI, so the gateway deliberately remains alive.
  process.on('SIGINT', () => {});
}

/**
 * Claude's plugin cache may be a symlink to a checkout. Node resolves the entry
 * module to its real path, so compare real paths rather than the argv spelling.
 */
function isEntryModule(argument: string | undefined): boolean {
  if (!argument) {
    return false;
  }
  const entry = fileURLToPath(import.meta.url);
  const resolved = path.resolve(argument);
  if (resolved === entry) {
    return true;
  }
  try {
    return realpathSync(resolved) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isEntryModule(process.argv[1])) {
  void main().catch((error) => {
    console.error(`Native gateway: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

function validateSessionLaunch(args: string[]) {
  if (
    args.some((arg) => arg === '--bg' || arg === '--background') ||
    ['attach', 'respawn'].includes(args[0] ?? '')
  ) {
    // The background supervisor does not carry the gateway environment or --agents.
    throw new Error(
      'Multi sessions must stay attached to their launcher. Exit and use --resume <session-id> to continue with a fresh gateway; whole-session background handoff is unsupported.',
    );
  }
  if (args.some((arg) => arg === '--agents' || arg.startsWith('--agents='))) {
    throw new Error('This launcher supplies --agents; use agent files for additional agents.');
  }
}

/** Native harness runs answer to the caller's settings; other providers do not. */
function nativeSettingsCheck(
  harnesses: { cursor?: unknown; antigravity?: unknown; grok?: unknown },
  args: string[],
  callerSettings: LaunchSettings,
) {
  const native = Boolean(harnesses.cursor || harnesses.antigravity || harnesses.grok);
  return async (cwd: string) => {
    if (!native) {
      return {};
    }
    try {
      return await checkHarnessSettings(cwd, args, callerSettings, sharedAdmission(harnesses));
    } catch (error) {
      return { nativePermissionError: String(error) };
    }
  };
}

function nativeHarnesses(
  cursorModels: CursorModelOption[],
  antigravityModels: AntigravityModel[],
  grokModels: GrokModel[],
  args: string[],
  callerSettings: LaunchSettings,
) {
  const cursor = cursorModels.length
    ? new CursorWorkspaces(
        (cwd) =>
          new CursorHarness(cursorModels, {
            cwd,
            checkPermissions: () => checkHarnessSettings(cwd, args, callerSettings),
          }),
      )
    : undefined;
  const antigravity = antigravityModels.length
    ? new AntigravityHarness(antigravityModels, {
        checkPermissions: async (cwd, context) => {
          await checkAntigravityHooks();
          const restrictions = await checkHarnessSettings(cwd, args, callerSettings, {
            validate: antigravityPermissionPolicy,
          });
          return antigravityPermissionPolicy(mergePermissions(context, restrictions));
        },
      })
    : undefined;
  const grok = grokModels.length
    ? new GrokHarness(grokModels, {
        checkPermissions: async (cwd, context) => {
          const restrictions = await checkHarnessSettings(cwd, args, callerSettings, {
            validate: grokPermissionPolicy,
          });
          return grokPermissionPolicy(mergePermissions(context, restrictions));
        },
      })
    : undefined;
  return { cursor, antigravity, grok };
}

function providerUsageReaders(
  authFile: string,
  zenKey: string | undefined,
  harnesses: ReturnType<typeof nativeHarnesses>,
): Partial<Record<'openai' | 'cursor' | 'zen' | 'antigravity' | 'grok', ProviderUsageReader>> {
  const { cursor, antigravity, grok } = harnesses;
  return {
    openai: openAIUsageReader(authFile),
    cursor: cursor ? cursorUsageReader(cursor) : undefined,
    zen: zenKey ? zenUsageReader(zenKey) : undefined,
    antigravity: antigravity ? antigravityUsageReader() : undefined,
    grok: grok ? grokUsageReader() : undefined,
  };
}

export function launcherRuntime(
  authFile: string,
  zenKey: string | undefined,
  usageReaders: ReturnType<typeof providerUsageReaders>,
  harnesses: ReturnType<typeof nativeHarnesses>,
  reviewer: Awaited<ReturnType<typeof createOpenAIReviewer>> | undefined,
  genericModels: Readonly<Record<string, readonly ModelDescriptor[]>> = {},
  registryFactory: LaunchRegistryFactory = createLaunchRegistry,
  deepseekKey?: string,
  piKeys?: BuiltinProviderCredentials['piKeys'],
  strataBaseUrl?: string,
): ProviderRuntime {
  const registry = registryFactory({
    authFile,
    zenKey,
    deepseekKey,
    ...(piKeys === undefined ? {} : { piKeys }),
    ...(strataBaseUrl === undefined ? {} : { strataBaseUrl }),
  });
  const active: ActiveProvider[] = [];
  const add = (id: string, provider: Omit<ActiveProvider, 'descriptor'>) => {
    const descriptor = registry.get(id);
    if (descriptor) {
      active.push({ descriptor, ...provider });
    }
  };
  if (usageReaders.openai) {
    add('openai', { models: [], ...(reviewer ? { reviewer } : {}), usage: usageReaders.openai });
  }
  if (zenKey) {
    add('zen', { models: [], ...(usageReaders.zen ? { usage: usageReaders.zen } : {}) });
  }
  for (const id of ['cursor', 'antigravity', 'grok'] as const) {
    const harness = harnesses[id];
    if (harness) {
      add(id, {
        models: [],
        harness,
        ...(usageReaders[id] ? { usage: usageReaders[id] } : {}),
      });
    }
  }
  active.push(...genericRuntimeProviders(registry, genericModels));
  return new ProviderRuntime(active, { registry });
}

function genericRuntimeProviders(
  registry: ProviderRegistry,
  modelsByProvider: Readonly<Record<string, readonly ModelDescriptor[]>>,
): ActiveProvider[] {
  const dedicatedIds = ['openai', 'zen', 'cursor', 'antigravity', 'grok'];
  const active: ActiveProvider[] = [];
  for (const [id, models] of Object.entries(modelsByProvider)) {
    if (models.length === 0 || dedicatedIds.includes(id)) {
      continue;
    }
    const descriptor = registry.get(id);
    if (!descriptor) {
      throw new Error(`Missing provider descriptor for discovered provider: ${id}`);
    }
    active.push({
      descriptor,
      models,
      ...(descriptor.usage ? { usage: descriptor.usage } : {}),
    });
  }
  return active;
}

export function genericActiveProviders(
  providers: readonly ProviderDescriptor[],
  modelsByProvider: Readonly<Record<string, readonly ModelDescriptor[]>>,
): ActiveProvider[] {
  return providers.flatMap((descriptor) => {
    const models = modelsByProvider[descriptor.id] ?? [];
    return models.length > 0 ? [{ descriptor, models }] : [];
  });
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function failedAuthProbeOutput(error: unknown): string {
  const details = recordValue(error);
  const code = details?.code;
  const stdout = details?.stdout;
  if (code === 1 && typeof stdout === 'string') {
    return stdout;
  }
  throw new Error('Claude auth status probe failed; cannot determine login state');
}

function parseAuthProbeOutput(stdout: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Claude auth status probe returned invalid JSON');
  }
  const details = recordValue(parsed);
  if (!details || typeof details.loggedIn !== 'boolean') {
    throw new Error('Claude auth status probe returned no boolean loggedIn field');
  }
  return details.loggedIn;
}

async function assertFunctionHooksSupported(): Promise<void> {
  let stdout: string;
  let executable = 'claude';
  try {
    executable = resolveExecutable('claude', {
      platform: process.platform,
      env: process.env,
      configuredPath: claudeExecutable,
    });
    const invocation = executableInvocation(
      executable,
      ['--version'],
      process.platform,
      process.env,
    );
    ({ stdout } = await promisify(execFile)(invocation.command, invocation.args, {
      timeout: 10000,
      maxBuffer: 65536,
      ...invocation.options,
    }));
  } catch (error) {
    const details = recordValue(error);
    const code = typeof details?.code === 'string' ? ` (${details.code})` : '';
    const firstLine = String(error).split('\n', 1)[0];
    throw new Error(
      `Claude Code 2.1.272 or newer with function hooks is required; unable to read ${executable} --version${code}: ${firstLine}.`,
      { cause: error },
    );
  }
  const match = stdout.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match || !atLeastVersion(match.slice(1).map(Number), [2, 1, 272])) {
    throw new Error('Claude Code 2.1.272 or newer with function hooks is required.');
  }
}

function claudeCommand(args: readonly string[]) {
  const environment = process.env;
  return executableInvocation(
    resolveExecutable('claude', {
      platform: process.platform,
      env: environment,
      configuredPath: claudeExecutable,
    }),
    args,
    process.platform,
    environment,
  );
}

function atLeastVersion(actual: number[], required: number[]): boolean {
  for (let index = 0; index < required.length; index++) {
    const received = actual[index] ?? 0;
    const minimum = required[index] ?? 0;
    if (received !== minimum) {
      return received > minimum;
    }
  }
  return true;
}

/**
 * Claude Code has to start, load the plugin worker and run session.start before
 * the mod can acknowledge. A cold start on Windows takes well over five seconds
 * (large binary, antivirus scan), so the wait is generous and overridable.
 */
const modSessionStartTimeoutMs = Number(process.env.MULTI_MOD_START_TIMEOUT_MS ?? 30000);

/**
 * Wait for the mod's acknowledgement, or for a Claude that exits first: that ends the
 * launch with Claude's own exit code. A timeout is the launcher's error.
 */
async function awaitStartOrExit(
  modStart: { ready: Promise<void>; cancel: () => void },
  exited: Promise<number>,
  child: { kill: () => boolean },
  shutdown: () => Promise<void>,
) {
  try {
    const earlyExit = await Promise.race([modStart.ready.then(() => undefined), exited]);
    if (earlyExit !== undefined) {
      modStart.cancel();
      await shutdown();
      process.exit(earlyExit);
    }
  } catch (error) {
    child.kill();
    await shutdown();
    throw error;
  }
}

function awaitModSessionStart(): { ready: Promise<void>; cancel: () => void } {
  let cancel = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      process.off('multi-mod-session-start', acknowledged);
      reject(
        new Error(
          'Claude Code 2.1.272 or newer with loaded function hooks is required; the Multi mod did not acknowledge session.start.',
        ),
      );
    }, modSessionStartTimeoutMs);
    const acknowledged = () => {
      clearTimeout(timer);
      resolve();
    };
    cancel = () => {
      clearTimeout(timer);
      process.off('multi-mod-session-start', acknowledged);
    };
    process.once('multi-mod-session-start', acknowledged);
  });
  // A cancelled wait never settles; a timed-out one is handled by whoever awaits it.
  ready.catch(() => {});
  return { ready, cancel };
}

async function anthropicSignedIn(): Promise<boolean> {
  // Ask Claude, including its OS credential store and configured helpers. Never read its tokens.
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return true;
  }
  let stdout: string;
  try {
    const invocation = claudeCommand(['auth', 'status', '--json']);
    ({ stdout } = await promisify(execFile)(invocation.command, invocation.args, {
      timeout: 10000,
      maxBuffer: 65536,
      ...invocation.options,
    }));
  } catch (error) {
    stdout = failedAuthProbeOutput(error);
  }
  return parseAuthProbeOutput(stdout);
}

/** One admission result is shared by every native provider, so it has to be judged by the
 * validator that rejects the least: a rule Antigravity or Grok supports natively must not be
 * refused here because Cursor cannot express it. Antigravity and Grok map every Claude tool
 * name Cursor cannot, so either one judges the shared result when present; Cursor re-validates
 * with its own policy on its own dispatch, where the rejection belongs and where it can name
 * the file. */
export function sharedAdmission(harnesses: {
  cursor?: unknown;
  antigravity?: unknown;
  grok?: unknown;
}): HarnessSettingsOptions {
  if (harnesses.antigravity) {
    return { validate: antigravityPermissionPolicy, cursorToolRules: false };
  }
  if (harnesses.grok) {
    return { validate: grokPermissionPolicy, cursorToolRules: false };
  }
  return { validate: cursorPermissionPolicy, cursorToolRules: true };
}

/** The five provider workers resolve their models from the session's picker rows. */
export function workerCatalog(
  pickerModels: readonly { model: string }[],
  grokModels: readonly GrokModel[] = [],
): WorkerCatalog {
  return buildWorkerCatalog(pickerModels, {
    openai: { defaultId: () => OPENAI_DEFAULT_WORKER_MODEL, effort: OPENAI_WORKER_EFFORT },
    zen: { defaultId: () => ZEN_DEFAULT_WORKER_MODEL, effort: ZEN_WORKER_EFFORT },
    cursor: { defaultId: () => CURSOR_DEFAULT_WORKER_MODEL },
    antigravity: { defaultId: antigravityDefaultWorkerModel },
    grok: { defaultId: () => grokDefaultWorkerModel(grokModels) },
  });
}

/**
 * One Agent type per signed-in provider. The definition's model is the provider's
 * default; an Agent call's `model` selects another, resolved by the mod at spawn.
 */
export function workerDefinitions(
  catalog: WorkerCatalog,
  registry: ProviderRegistry = createBuiltinRegistry(),
): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {};
  for (const worker of Object.values(catalog)) {
    const fact = PROVIDER_FACTS.find(({ id }) => id === worker.provider);
    if (!fact) {
      throw new Error(`Unknown worker provider ${worker.provider}`);
    }
    const descriptor = registry.get(worker.provider);
    const runs = descriptor?.runs ?? (fact.kind === 'direct' ? "Claude Code's tools" : undefined);
    if (!runs) {
      throw new Error(`Harness provider ${worker.provider} is missing a runs description`);
    }
    const model = worker.models.find((entry) => entry.id === worker.defaultId)?.model;
    if (!model) {
      continue;
    }
    agents[worker.type] = {
      description: workerDescription(worker, runs),
      prompt: WORKER_PROMPT,
      model,
      tools: fact.kind === 'direct' ? CLAUDE_WORKER_TOOLS : HARNESS_WORKER_TOOLS,
      ...(worker.effort ? { effort: worker.effort as Effort } : {}),
    };
  }
  return agents;
}

interface LauncherInvocation {
  command: string;
  args: readonly string[];
  viaComSpec?: boolean;
}

export function checkLauncherArgumentLimit(
  agents: Record<string, AgentDefinition>,
  invocation: LauncherInvocation,
  executable: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') {
    return;
  }
  const viaComSpec = invocation.viaComSpec ?? /(?:^|[\\/])cmd\.exe$/i.test(invocation.command);
  const limit = viaComSpec ? 8000 : 32000;
  const commandLine = [invocation.command, ...invocation.args].join(' ');
  if (commandLine.length <= limit) {
    return;
  }
  const providers = new Map<string, number>();
  for (const [name, agent] of Object.entries(agents)) {
    const provider = decodeModelRoute(agent.model)?.providerId ?? 'unknown';
    providers.set(
      provider,
      (providers.get(provider) ?? 0) + Buffer.byteLength(JSON.stringify({ [name]: agent })),
    );
  }
  const largest = [...providers.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([provider, bytes]) => `${provider} (${bytes} B)`)
    .join(', ');
  const shim = viaComSpec ? ' cmd.exe shim' : '';
  throw new Error(
    `Native worker registration needs ${commandLine.length.toLocaleString('en-US')} characters for ${executable}, above the Windows${shim} limit of ${limit.toLocaleString('en-US')}. Largest providers: ${largest || 'none'}. Disable providers or extra models to reduce the launcher arguments.`,
  );
}

async function mergeSettings(args: string[], settings: LaunchSettings) {
  // Keep one --settings argument, preserving explicit caller settings and our picker.
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--settings' && !args[i].startsWith('--settings=')) {
      continue;
    }
    const inline = args[i].startsWith('--settings=');
    const value = inline ? args[i].slice(11) : args[i + 1];
    if (!value) {
      throw new Error('--settings requires a JSON object or file');
    }
    const extra = await readSettings(value);
    const picker = settings.modelPicker;
    Object.assign(settings, extra);
    settings.modelPicker = {
      ...picker,
      ...extra.modelPicker,
      options: [...picker.options, ...(extra.modelPicker?.options ?? [])],
    };
    args.splice(i, inline ? 1 : 2);
    i--;
  }
}

async function initialSelection(args: string[], settings: LaunchSettings, anthropic: boolean) {
  const savedModel = await savedSelection(args);
  const requested =
    explicitModel(args) ??
    process.env.ANTHROPIC_MODEL ??
    (typeof settings.model === 'string' ? settings.model : savedModel);
  // With no Claude login, start on an available external model instead of Sonnet.
  const options = settings.modelPicker.options;
  const initialModel = retagSelection(requested, options);
  const defaultModel =
    process.env.MULTI_MODELS === undefined
      ? options.find((option) => option.model === 'multi/openai/gpt-6-luna')
      : undefined;
  const fallback = anthropic ? undefined : (defaultModel ?? options[0])?.model;
  const selectedModel = initialModel ?? fallback;
  // Claude is told the model when it would otherwise choose one itself, and when retagging
  // changed the spelling: the selection Claude restores on its own carries no context tag.
  const retagged = initialModel !== requested;
  const passToClaude = selectedModel !== undefined && (initialModel === undefined || retagged);
  return { selectedModel, modelArgument: passToClaude ? selectedModel : undefined };
}

/** The last `--model` the caller spelled, in either form. */
function explicitModel(args: readonly string[]): string | undefined {
  let model: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model') {
      model = args[i + 1];
    } else if (args[i].startsWith('--model=')) {
      model = args[i].slice(8);
    }
  }
  return model;
}

/** Move a selection onto whichever spelling the picker offers: tagged, or plain once the
 * context tag is switched off. A selection that survives the opt-out keeps its own row. */
function retagSelection(
  model: string | undefined,
  options: readonly ModelOption[],
): string | undefined {
  if (model === undefined || options.some((option) => option.model === model)) {
    return model;
  }
  const native = nativeSpelling(model) ?? model;
  const rows = new Set(options.map((option) => option.model));
  const tagged = `${native}[1m]`;
  if (rows.has(tagged)) {
    return tagged;
  }
  if (rows.has(native)) {
    return native;
  }
  // An advertised effort variant is collapsed into one synthesized picker row, so a model
  // selected by its own variant ID matches no row. It is still a real Antigravity model and
  // takes the same window, so decide from the provider rather than from the picker.
  const prefix = 'multi/antigravity/';
  return native.startsWith(prefix) ? oneMillionContext(native, native.slice(prefix.length)) : model;
}

/** Replace the caller's own `--model`, so a retagged selection cannot be passed twice.
 * This walks the arguments exactly as `explicitModel` does, so both agree on which
 * occurrence is authoritative; rewriting an earlier one would leave the child on the
 * spelling the retag was meant to replace. */
function applyModelArgument(args: string[], model: string) {
  let index = -1;
  let inline = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model') {
      index = i;
      inline = false;
    } else if (args[i].startsWith('--model=')) {
      index = i;
      inline = true;
    }
  }
  if (index === -1) {
    args.push('--model', model);
  } else if (inline) {
    args[index] = `--model=${model}`;
  } else {
    args[index + 1] = model;
  }
}

function filterPicker(
  settings: LaunchSettings,
  selection: string | undefined,
  defaultModels: readonly string[] = [],
) {
  if (selection === undefined) {
    return;
  }
  if (selection === 'all') {
    return;
  }
  const additive = selection.startsWith('+');
  const models = [
    ...new Set(
      (additive ? `${defaultModels.join(',')},${selection.slice(1)}` : selection)
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  ];
  const available = new Map(settings.modelPicker.options.map((option) => [option.model, option]));
  const chosen = new Set<ModelOption>();
  for (const model of models) {
    // A tagged row stays selectable by its plain provider ID and the reverse: a selection
    // saved while the tag was on must still resolve once MULTI_DISABLE_1M_CONTEXT turns it off.
    const native = nativeSpelling(model) ?? model;
    const option = available.get(model) ?? available.get(`${native}[1m]`) ?? available.get(native);
    if (!option) {
      throw new Error(
        `MULTI_MODELS: model is not available from a connected provider in this launcher's picker: ${model}. Check the full ID with --cursor-models or --zen-models, then add it with /multi-core:setup --models <id>.`,
      );
    }
    chosen.add(option);
  }
  settings.modelPicker.options = [...chosen];
}

async function handleCommand(command?: string) {
  if (command === '--antigravity-setup') {
    await installAntigravityHook();
    console.log('Antigravity native permission hook installed. Native login remains owned by agy.');
    process.exit(0);
  }
  if (command === '--antigravity-models') {
    console.log(JSON.stringify(await discoverAntigravityModels(), null, 2));
    process.exit(0);
  }
  if (command === '--grok-models') {
    console.log(JSON.stringify(await discoverGrokModels(), null, 2));
    process.exit(0);
  }
  if (command === '--zen-models') {
    console.log(JSON.stringify(ZEN_MODELS, null, 2));
    process.exit(0);
  }
  if (command === '--help') {
    console.log(
      'Usage: node plugins/multi-core/src/launcher.ts [--cursor-login | --cursor-models | --zen-models | --antigravity-models | --antigravity-setup] [-- <claude arguments>]\nLaunch Claude with external models and native coding workers.\n--cursor-login: official Cursor SDK browser sign-in\n--cursor-models: list account model choices\n--zen-models: list supported Zen models and capabilities\nMULTI_ANTIGRAVITY=1: enable native Antigravity models and workers\n--antigravity-setup: install the scoped native permission hook\n--antigravity-models: inspect the official Antigravity CLI catalog (native login required)\n--grok-models: list the Grok Build catalog (native login required)\nMULTI_GROK_MODELS: comma-separated Grok model IDs to show, leaving other providers unchanged\nOPENCODE_API_KEY: Zen key (or use OpenCode /connect)\nMULTI_ZEN_MODELS: comma-separated Zen model IDs to show, leaving other providers unchanged\nMULTI_MODELS: comma-separated full model IDs to show in /model (unset: defaults; empty: hide external rows)\nMULTI_CURSOR_EXTRA_MODELS: comma-separated Cursor model IDs to add to Auto, Grok 4.7, and Composer 2.5 in /model',
    );
    process.exit(0);
  }
  if (command === '--cursor-login') {
    const { Cursor } = await import('@cursor/sdk');
    await Cursor.auth.login({
      apiKeyName: 'cc-multi-cli',
      onLoginUrl: (url) => console.log(`Cursor login: ${url}`),
    });
    console.log('Cursor SDK login saved. Launch the gateway normally to use it.');
    process.exit(0);
  }
}

async function readSettings(value: string) {
  const extra = JSON.parse(
    value.trimStart().startsWith('{') ? value : await readFile(value, 'utf8'),
  );
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
    throw new Error('Invalid --settings object');
  }
  return extra;
}

async function savedSelection(args: string[]) {
  let savedModel: string | undefined;
  const sourcesIndex = args.lastIndexOf('--setting-sources');
  const sources = (
    args.findLast((arg) => arg.startsWith('--setting-sources='))?.slice(18) ??
    (sourcesIndex >= 0 ? args[sourcesIndex + 1] : 'user,project,local')
  ).split(',');
  for (const [source, filename] of [
    [
      'user',
      path.join(
        process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
        'settings.json',
      ),
    ],
    ['project', path.join(process.cwd(), '.claude', 'settings.json')],
    ['local', path.join(process.cwd(), '.claude', 'settings.local.json')],
  ] as const) {
    if (!sources.includes(source)) {
      continue;
    }
    try {
      const value = JSON.parse(await readFile(filename, 'utf8'));
      if (typeof value.model === 'string') {
        savedModel = value.model;
      }
    } catch {
      /* Claude handles missing or invalid native settings itself. */
    }
  }
  return savedModel;
}

function printCursorModels(cursorModels: CursorModelOption[], cursorSignedIn: boolean) {
  if (!cursorSignedIn) {
    throw new Error('Run with --cursor-login first.');
  }
  console.log(
    JSON.stringify(
      cursorModels.map(({ model, label, selection }) => ({ model, label, selection })),
      null,
      2,
    ),
  );
}

function selectedCursorOptions(cursorModels: CursorModelOption[], fullCatalog: boolean) {
  if (fullCatalog) {
    return cursorModels;
  }
  return cursorPickerOptions(
    cursorModels,
    cursorModels.length ? process.env.MULTI_CURSOR_EXTRA_MODELS : undefined,
  );
}

/** Client compatibility only, not provider equivalence. Both profiles default to 200K
 * in Claude 2.1.267; newer xhigh profiles imply native 1M and are deliberately not used.
 * Provider validation remains authoritative for every requested effort value. */
function pickerProfile(adjustableEffort: boolean): string {
  return adjustableEffort ? 'claude-sonnet-4-6' : 'claude-haiku-4-5';
}

/**
 * Antigravity families whose native input window is about a million tokens. Gemini 3.x
 * Flash and Pro take 1,048,576. Every other advertised model keeps the conservative
 * default, because its window is smaller or unestablished: GPT-OSS 120B takes 131,072,
 * and the Claude models served here carry no 1M entitlement. The native catalog reports
 * no capacity metadata, so this list is the only place that claim is made.
 */
const ANTIGRAVITY_1M_FAMILIES = /^gemini(?:-|$)/;

/**
 * Claude reads a row's context window from a `[1m]` tag on the model ID before it consults
 * the `behavesAs` profile, and it matches `behavesAs` on the untagged spelling. Tagging a
 * row therefore states the provider's real window without adopting a Claude profile that
 * also advertises effort levels the provider does not have. The harness strips the tag
 * before it resolves the native model. `MULTI_DISABLE_1M_CONTEXT` opts out.
 */
function oneMillionContext(model: string, id: string): string {
  const family = id.replace(/-(low|medium|high)$/, '');
  if (optedOut(process.env.MULTI_DISABLE_1M_CONTEXT) || !ANTIGRAVITY_1M_FAMILIES.test(family)) {
    return model;
  }
  return `${model}[1m]`;
}

/** An opt-out set to an explicit negative reads as off, not as "the variable is present". */
function optedOut(value: string | undefined): boolean {
  return value !== undefined && !['', '0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

const PICKER_PROVIDER_ORDER: readonly ProviderId[] = [
  'openai',
  'cursor',
  'antigravity',
  'grok',
  'zen',
];

export function pickerSettings(
  codexSignedIn: boolean,
  cursorPicker: CursorModelOption[],
  zen: boolean,
  antigravityModels: AntigravityModel[],
  grokModels: GrokModel[],
  fullCatalog = false,
  availableProviderIds: readonly string[] = [],
  genericModels: Readonly<Record<string, readonly ModelDescriptor[]>> = {},
): LaunchSettings {
  let zenOptions = zenPickerOptions('');
  if (zen) {
    zenOptions = fullCatalog ? zenModelOptions() : zenPickerOptions(process.env.MULTI_ZEN_MODELS);
  }
  const available = new Set<ProviderId>();
  if (codexSignedIn) {
    available.add('openai');
  }
  if (cursorPicker.length) {
    available.add('cursor');
  }
  if (antigravityModels.length) {
    available.add('antigravity');
  }
  if (grokModels.length) {
    available.add('grok');
  }
  if (zen) {
    available.add('zen');
  }
  const builders: Partial<Record<ProviderId, () => ModelOption[]>> = {
    openai: () =>
      Object.values(MODELS).map((model) => ({
        model: `multi/openai/${model}`,
        label: model,
        description: 'OpenAI subscription · native Claude Code harness',
        behavesAs: pickerProfile(true),
      })),
    cursor: () =>
      cursorPicker.map(({ model, label, description, catalog }) => ({
        model,
        label,
        description,
        behavesAs: pickerProfile(
          catalog.parameters?.some(({ id }) => ['effort', 'reasoning_effort'].includes(id)) ??
            false,
        ),
      })),
    antigravity: () =>
      antigravityPickerOptions(antigravityModels).map(({ model, label, id }) => ({
        model: oneMillionContext(model, id),
        label,
        behavesAs: pickerProfile(true),
        description: 'Native Antigravity CLI',
      })),
    grok: () =>
      grokPickerOptions(grokModels, process.env.MULTI_GROK_MODELS).map(({ model, label }) => ({
        model,
        label: `Grok - ${label}`,
        behavesAs: pickerProfile(true),
        description: 'Grok subscription; native Grok Build CLI',
      })),
    zen: () =>
      zenOptions.map(({ model, label, efforts }) => ({
        model,
        label: `Zen · ${label}`,
        behavesAs: pickerProfile(Boolean(efforts?.length)),
        description: `Zen API billing · Claude tools${efforts ? '' : ' · native reasoning; /effort not applicable'}`,
      })),
  };
  const dedicatedProviders = new Set(['openai', 'cursor', 'antigravity', 'grok', 'zen']);
  for (const fact of PROVIDER_FACTS) {
    if (dedicatedProviders.has(fact.id)) {
      continue;
    }
    builders[fact.id] = () => {
      const models = genericModels[fact.id] ?? [];
      if (models.length === 0) {
        throw new Error(`Picker provider ${fact.id} has no row builder`);
      }
      return models.map((model) => ({
        model: encodeModelRoute(model.identity.providerId, model.identity.modelId),
        label: `${fact.label} · ${model.label}`,
        description:
          model.description ??
          `${fact.label} · ${fact.kind === 'direct' ? 'Claude tools' : 'native harness'}`,
        behavesAs: pickerProfile(Boolean(model.reasoning?.efforts?.length)),
      }));
    };
  }
  for (const provider of availableProviderIds) {
    available.add(provider as ProviderId);
  }
  const options = pickerRowsForProviders([...available], builders);
  return { modelPicker: { options } };
}

export function pickerRowsForProviders(
  providerIds: readonly string[],
  builders: Partial<Record<ProviderId, () => ModelOption[]>>,
): ModelOption[] {
  const available = new Set(providerIds);
  for (const provider of available) {
    if (!PROVIDER_FACTS.some((fact) => fact.id === provider)) {
      throw new Error(`Unknown picker provider ${provider}`);
    }
    if (!builders[provider as ProviderId]) {
      throw new Error(`Picker provider ${provider} has no row builder`);
    }
  }
  const ordered = [
    ...PICKER_PROVIDER_ORDER,
    ...PROVIDER_FACTS.map(({ id }) => id).filter(
      (provider) => !PICKER_PROVIDER_ORDER.includes(provider),
    ),
  ];
  return ordered.flatMap((provider) =>
    available.has(provider) ? (builders[provider]?.() ?? []) : [],
  );
}

/**
 * CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC also blocks the plugin worker's loopback call
 * to this gateway, which the Mods control plane requires (an end-to-end check on
 * Claude Code 2.1.283 showed the broad flag blocks the function-hook fetch while the
 * narrow flags do not). Keep the user's intent (no updater, telemetry, error reports or
 * feedback command) with the narrower flags instead of silently running without the mod.
 *
 * This is not about GrowthBook. The broad flag and DISABLE_TELEMETRY both turn it off,
 * and on Claude Code 2.1.287 the Mods rollout flag `tengu_plugin_hooks_modules` defaults
 * to on without it, so the replacement flags leave the mod loading.
 */
function translateTrafficPolicy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === undefined) {
    return env;
  }
  const { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: _flag, ...rest } = env;
  process.stderr.write(
    'Multi: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC would block the local gateway; using DISABLE_AUTOUPDATER, DISABLE_TELEMETRY, DISABLE_ERROR_REPORTING, DISABLE_BUG_COMMAND and DISABLE_FEEDBACK_COMMAND instead.\n',
  );
  return {
    ...rest,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_BUG_COMMAND: '1',
    DISABLE_FEEDBACK_COMMAND: '1',
  };
}

export function gatewayEnvironment(
  port: number,
  token: string,
  anthropic: boolean,
  registry: ProviderRegistry = createBuiltinRegistry(),
): NodeJS.ProcessEnv {
  // A launch inside another Multi session starts from the user's own environment.
  const origin = withoutGateway(process.env);
  const env = translateTrafficPolicy({ ...origin });
  for (const credential of new Set(
    registry.list().flatMap(({ credentialEnv }) => credentialEnv ?? []),
  )) {
    delete env[credential];
  }
  return {
    ...env,
    // What nested Claude runs get back in place of the gateway (see nested-env.ts).
    ...rememberOriginalEnvironment(origin),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    // A custom base URL makes Claude Code skip on-demand tool loading unless it is told
    // otherwise, and a gateway base URL is always custom. Claude's own default against
    // Anthropic is to defer tools always, which is what 'true' says; the user's own
    // setting is kept. 'auto' would instead load every tool once a 1M window makes them
    // under 10%.
    ENABLE_TOOL_SEARCH: origin.ENABLE_TOOL_SEARCH ?? 'true',
    MULTI_GATEWAY_TOKEN: token,
    // Claude Code 2.1.287 and newer has Mods on by default; 2.1.272 to 2.1.286 need this.
    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    MULTI_MOD_GATEWAY_URL: `http://127.0.0.1:${port}`,
    ...(!anthropic ? { ANTHROPIC_AUTH_TOKEN: token } : {}),
    ANTHROPIC_CUSTOM_HEADERS: [origin.ANTHROPIC_CUSTOM_HEADERS, `x-multi-gateway-token: ${token}`]
      .filter(Boolean)
      .join('\n'),
  };
}

/**
 * A `claude` run by Claude's own tools (Bash `claude -p`, scripts) inherits the session's
 * gateway environment and would route through a gateway that is not its own. Put a
 * `claude` on the session's PATH that runs the real executable without it.
 */
async function withNestedClaudeShim(
  env: NodeJS.ProcessEnv,
  settingsDir: string,
  claude: string,
): Promise<NodeJS.ProcessEnv> {
  const directory = path.join(settingsDir, 'bin');
  const shim = nestedClaudeShim({
    node: process.execPath,
    script: fileURLToPath(new URL('./install/nested-claude.ts', import.meta.url)),
    claude,
  });
  await mkdir(directory, { recursive: true });
  for (const file of shim.files) {
    await writeFile(path.join(directory, file.file), file.content, { mode: 0o755 });
  }
  return withPathPrefix(env, directory);
}

/** A proxy the user has configured is honored only if Node was started to use it. */
function warnIfProxyUnused() {
  if (needsEnvProxy(process.env)) {
    process.stderr.write(
      'Multi: HTTP_PROXY/HTTPS_PROXY is set but Node ignores it for the gateway; start the launcher with NODE_USE_ENV_PROXY=1 (the installed command does).\n',
    );
  }
}

/** A plugin inventory that cannot be read means no plugin workers, not no session. */
async function pluginInventoryOrEmpty(cwd: string, args: readonly string[]) {
  try {
    return await pluginPermissions(cwd, args);
  } catch (error) {
    process.stderr.write(
      `Multi: could not list Claude plugins (${error instanceof Error ? error.message.split('\n', 1)[0] : String(error)}); plugin-provided workers are unavailable.\n`,
    );
    return { permissions: {}, multiCoreEnabled: false } satisfies PluginPermissionInventory;
  }
}

function traceEvent(event: GatewayEvent) {
  if (process.env.MULTI_NATIVE_TRACE === '1') {
    process.stderr.write(`[native] ${JSON.stringify(event)}\n`);
  }
}

async function findPluginRoot(file: string): Promise<string> {
  for (let directory = path.dirname(path.resolve(file)); ; directory = path.dirname(directory)) {
    try {
      await stat(path.join(directory, '.claude-plugin', 'plugin.json'));
      return directory;
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) {
        throw new Error(`Could not find the Multi plugin root above ${file}`);
      }
    }
  }
}

function hasPluginDirectory(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--plugin-dir' || arg.startsWith('--plugin-dir='));
}

export function launcherArguments(
  args: readonly string[],
  settingsFile: string,
  definitions: string,
  inventory: PluginPermissionInventory,
  pluginRoot: string,
): string[] {
  const pluginDirectory =
    !hasPluginDirectory(args) && (!inventory.multiCoreEnabled || hasEmptySettingSources(args))
      ? ['--plugin-dir', pluginRoot]
      : [];
  return ['--settings', settingsFile, '--agents', definitions, ...args, ...pluginDirectory];
}

function hasEmptySettingSources(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--setting-sources' && args[index + 1] === '') {
      return true;
    }
    if (arg === '--setting-sources=') {
      return true;
    }
  }
  return false;
}
