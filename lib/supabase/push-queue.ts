/* Serialize writes per shared store and let an immediate-save caller wait
   through edits that arrived while an earlier write was in flight. */
export function createPushQueue<Key>(
  pushOnce: (key: Key) => Promise<void>,
  isDirty: (key: Key) => boolean,
): (key: Key) => Promise<void> {
  const inFlight = new Map<Key, Promise<void>>();

  async function push(key: Key): Promise<void> {
    const active = inFlight.get(key);
    if (active) {
      await active;
    } else {
      const task = pushOnce(key);
      inFlight.set(key, task);
      try {
        await task;
      } finally {
        if (inFlight.get(key) === task) inFlight.delete(key);
      }
    }
    if (isDirty(key)) return push(key);
  }

  return push;
}
