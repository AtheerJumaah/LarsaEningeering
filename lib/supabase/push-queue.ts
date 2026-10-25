/* Serialize writes per shared store and let an immediate-save caller wait
   through edits that arrived while an earlier write was in flight. */
export function createPushQueue<Key>(
  pushOnce: (key: Key) => Promise<void>,
  isDirty: (key: Key) => boolean,
): (key: Key) => Promise<void> {
  const inFlight = new Map<Key, Promise<void>>();

  function push(key: Key): Promise<void> {
    const active = inFlight.get(key);
    if (active) return active;
    /* Own the whole drain, including newer edits, with one promise. A dirty
       predicate or an unresolvable conflict must never recurse forever through
       resolved promises: that prevents the browser from painting or handling
       input. Yield between passes and report an unconfirmed save after a
       bounded attempt; the local edit remains intact for the next retry. */
    const task = Promise.resolve().then(async () => {
      for (let pass = 0; pass < 5; pass++) {
        await pushOnce(key);
        if (!isDirty(key)) return;
        if (pass < 4) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      throw new Error("The latest changes are still saved on this device but have not been confirmed by the server.");
    }).finally(() => {
      if (inFlight.get(key) === task) inFlight.delete(key);
    });
    inFlight.set(key, task);
    return task;
  }

  return push;
}
