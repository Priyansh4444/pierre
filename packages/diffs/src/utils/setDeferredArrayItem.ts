export function setDeferredArrayItem<T>(
  array: T[],
  index: number,
  create: () => T
): void {
  let initialized = false;
  let cached: T;
  Object.defineProperty(array, index, {
    configurable: true,
    enumerable: true,
    get() {
      if (!initialized) {
        cached = create();
        initialized = true;
      }
      replaceWithValue(array, index, cached);
      return cached;
    },
    set(value: T) {
      if (replaceWithValue(array, index, value)) {
        return;
      }
      if (Object.isFrozen(array)) {
        throw new TypeError(
          `Cannot assign to read only array index '${index}'`
        );
      }
      cached = value;
      initialized = true;
    },
  });
}

// Swaps the lazy accessor for a plain value while the slot is still
// configurable. Returns false when it is not.
function replaceWithValue<T>(array: T[], index: number, value: T): boolean {
  if (Object.getOwnPropertyDescriptor(array, index)?.configurable !== true) {
    return false;
  }
  Object.defineProperty(array, index, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
  return true;
}
