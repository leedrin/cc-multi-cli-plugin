export async function resolve(specifier, context, nextResolve) {
  const isBackendImport =
    specifier === './backend.ts' &&
    (context.parentURL?.includes('/multi-pi/src/provider.ts') ||
      context.parentURL?.includes('/multi-pi/src/gateway-request.ts'));
  const isPiAiImport =
    specifier === '@earendil-works/pi-ai' || specifier.startsWith('@earendil-works/pi-ai/');
  if (isBackendImport || isPiAiImport) {
    throw new Error(`Unexpected Pi runtime import: ${specifier}`);
  }
  return nextResolve(specifier, context);
}
