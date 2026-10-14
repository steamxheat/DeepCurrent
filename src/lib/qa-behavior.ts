export function createQaBehavior(seed: number) {
  let state = seed >>> 0;
  return (user: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const random = state / 4294967296;
    const persona = user % 4;
    const pool = persona === 0 ? [1, 2, 3, 9, 10, 13, 14] : persona === 1 ? [0, 4, 5, 8, 15] : persona === 2 ? [2, 3, 7, 12, 13, 14] : [0, 6, 7, 11, 15];
    return { step: pool[Math.floor(random * pool.length)], choice: state,
      pauseMs: random > .9 ? 90_000 + state % 150_000 : 3_000 + state % 27_000 };
  };
}
