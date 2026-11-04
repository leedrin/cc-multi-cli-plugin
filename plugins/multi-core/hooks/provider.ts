/** These providers execute tools outside Claude Code and need policy translation. */
export { isHarnessModel, isHarnessProvider, providerOf } from '../src/gateway/provider-facts.ts';

/** Any Multi model: a harness, or a provider whose tool loop Claude Code runs. */
export function isMultiModel(model: string | undefined): boolean {
  return Boolean(model?.startsWith('multi/'));
}
