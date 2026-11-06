const PI_ROOT = '/@earendil-works/pi-ai/';

export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL ?? '';
  if (parent.includes(PI_ROOT) && ['node:fs', 'node:fs/promises', 'node:os'].includes(specifier)) {
    process.stderr.write(`PI_STRATA_FORBIDDEN_BUILTIN: ${specifier}\n`);
    throw new Error(`Strata Pi import touched forbidden builtin ${specifier}`);
  }
  const resolved = await nextResolve(specifier, context);
  const url = resolved.url;
  const providerFile = new URL(url).pathname.match(/\/pi-ai\/dist\/providers\/(.+)$/)?.[1];
  if (providerFile !== undefined) {
    throw new Error(`Strata loaded forbidden Pi provider module: ${providerFile}`);
  }
  return resolved;
}
