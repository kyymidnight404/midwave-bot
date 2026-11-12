import { randomInt } from 'node:crypto';

/**
 * Default cryptographic RNG adapter.
 * Every game engine accepts an RNG object with { int(min, max), pick(arr), shuffle(arr) }
 * so tests can inject deterministic seeded RNGs.
 */
export const defaultRng = Object.freeze({
  /**
   * Returns a uniform random integer in [min, max] inclusive.
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  int(min, max) {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new RangeError(`Invalid random integer range [${min}, ${max}]`);
    }
    if (min === max) return min;
    return randomInt(min, max + 1);
  },

  /**
   * Picks a random element from a non-empty array.
   * @template T
   * @param {readonly T[]} items
   * @returns {T}
   */
  pick(items) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new RangeError('Cannot pick from an empty array');
    }
    return items[this.int(0, items.length - 1)];
  },

  /**
   * Returns a new shuffled copy of the array using Fisher-Yates.
   * @template T
   * @param {readonly T[]} items
   * @returns {T[]}
   */
  shuffle(items) {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  },
});

/**
 * Creates a deterministic LCG-based RNG for unit tests.
 * @param {number} [seed=123456789]
 */
export function createSeededRng(seed = 123456789) {
  let state = seed >>> 0;
  const nextFloat = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };

  return {
    int(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
        throw new RangeError(`Invalid random integer range [${min}, ${max}]`);
      }
      if (min === max) return min;
      return min + Math.floor(nextFloat() * (max - min + 1));
    },
    pick(items) {
      if (!Array.isArray(items) || items.length === 0) {
        throw new RangeError('Cannot pick from an empty array');
      }
      return items[this.int(0, items.length - 1)];
    },
    shuffle(items) {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = this.int(0, i);
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
  };
}
