export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  const providerFile = new URL(resolved.url).pathname.match(
    /\/@earendil-works\/pi-ai\/dist\/providers\/(.+)$/,
  )?.[1];
  if (providerFile === undefined) {
    return resolved;
  }
  if (!['zai.js', 'zai.models.js', 'data/zai.json'].includes(providerFile)) {
    throw new Error(`Unexpected Pi provider module: ${resolved.url}`);
  }
  if (providerFile === 'zai.js') {
    process.stderr.write('PI_PROVIDER_LOADS: providers/zai.js\n');
  }
  return resolved;
}
