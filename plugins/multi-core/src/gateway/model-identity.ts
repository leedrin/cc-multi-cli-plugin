export interface ModelIdentity {
  providerId: string;
  modelId: string;
  routeId: string;
  preset?: string;
  oneMillionContext: boolean;
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ONE_MILLION_SUFFIX = /\[1m\]$/i;

export function encodeModelRoute(providerId: string, modelId: string): string {
  if (!isProviderId(providerId)) {
    throw new Error(`Invalid provider ID: ${providerId}`);
  }
  if (!modelId) {
    throw new Error('Model ID must not be empty.');
  }
  return `multi/${providerId}/${encodeURIComponent(modelId)}`;
}

export function decodeModelRoute(route: string): ModelIdentity | undefined {
  const oneMillionContext = ONE_MILLION_SUFFIX.test(route);
  const routeId = oneMillionContext ? route.slice(0, -'[1m]'.length) : route;
  const segments = routeId.split('/');
  const providerId = segments[1];
  const encodedModelId = segments[2];
  if (
    segments[0] !== 'multi' ||
    !providerId ||
    !isProviderId(providerId) ||
    providerId === 'core' ||
    !encodedModelId
  ) {
    return undefined;
  }

  let modelId: string;
  try {
    modelId = decodeURIComponent(encodedModelId);
  } catch {
    return undefined;
  }

  return {
    providerId,
    modelId,
    routeId,
    ...(segments.length > 3 ? { preset: segments.slice(3).join('/') } : {}),
    oneMillionContext,
  };
}

function isProviderId(providerId: string): boolean {
  return PROVIDER_ID.test(providerId) && providerId !== 'core';
}
