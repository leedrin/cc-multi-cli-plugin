import { isRecord } from '../../multi-core/src/gateway/record.ts';

export const PI_SIGNATURE_PREFIX = 'multipi:v1:';

export interface PiSignaturePayload {
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export type DecodedPiSignature =
  | { kind: 'foreign' }
  | { kind: 'owned'; payload: PiSignaturePayload };

export function encodePiSignature(routeId: string, payload: PiSignaturePayload): string {
  return `${PI_SIGNATURE_PREFIX}${encodeURIComponent(routeId)}:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

export function decodePiSignature(signature: string, routeId: string): DecodedPiSignature {
  if (!signature.startsWith(PI_SIGNATURE_PREFIX)) {
    return { kind: 'foreign' };
  }
  const encoded = signature.slice(PI_SIGNATURE_PREFIX.length);
  const separator = encoded.indexOf(':');
  if (separator < 0) {
    return { kind: 'foreign' };
  }
  let signedRoute: string;
  try {
    signedRoute = decodeURIComponent(encoded.slice(0, separator));
  } catch {
    return { kind: 'foreign' };
  }
  if (signedRoute !== routeId) {
    return { kind: 'foreign' };
  }
  try {
    const payloadString = encoded.slice(separator + 1);
    if (!payloadString || !/^[A-Za-z0-9_-]+$/.test(payloadString)) {
      throw new Error();
    }
    const parsed: unknown = JSON.parse(Buffer.from(payloadString, 'base64url').toString('utf8'));
    if (
      !isRecord(parsed) ||
      typeof parsed.thinking !== 'string' ||
      (parsed.thinkingSignature !== undefined && typeof parsed.thinkingSignature !== 'string') ||
      (parsed.redacted !== undefined && typeof parsed.redacted !== 'boolean')
    ) {
      throw new Error();
    }
    return {
      kind: 'owned',
      payload: {
        thinking: parsed.thinking,
        ...(parsed.thinkingSignature === undefined
          ? {}
          : { thinkingSignature: parsed.thinkingSignature }),
        ...(parsed.redacted === undefined ? {} : { redacted: parsed.redacted }),
      },
    };
  } catch {
    throw new Error('Invalid Pi thinking signature');
  }
}
