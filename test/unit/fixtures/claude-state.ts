/** Host-only state operations for the offline usage-controller harness. */
type Atom<T> = { key: string; initial: T };
const engines = new WeakMap<object, Map<string, unknown>>();

export function atom<T>(identity: { plugin: string; key: string }, initial: T): Atom<T> {
  return { key: `${identity.plugin}:${identity.key}`, initial };
}

function values(engine: object): Map<string, unknown> {
  let held = engines.get(engine);
  if (!held) {
    held = new Map();
    engines.set(engine, held);
  }
  return held;
}

export async function read<T>(engine: object, spec: Atom<T>): Promise<T> {
  const held = values(engine);
  return structuredClone((held.has(spec.key) ? held.get(spec.key) : spec.initial) as T);
}

export async function update<T>(engine: object, spec: Atom<T>, change: (held: T) => T) {
  values(engine).set(spec.key, structuredClone(change(await read(engine, spec))));
}
