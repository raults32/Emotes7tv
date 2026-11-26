/**
 * Cooperative main-thread yielding helper following `break-up-long-tasks`
 * so large folder conversions (hundreds of PNGs or multi-frame GIF LZW encoding)
 * never freeze UI input or progress bar rendering.
 */
export async function yieldToMain() {
  if (
    typeof window !== "undefined" &&
    "scheduler" in window &&
    typeof window.scheduler?.yield === "function"
  ) {
    await window.scheduler.yield();
  } else {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function createYieldBudget(budgetMs = 50) {
  let deadline = performance.now() + budgetMs;
  return async function maybeYield() {
    if (performance.now() >= deadline) {
      await yieldToMain();
      deadline = performance.now() + budgetMs;
    }
  };
}
