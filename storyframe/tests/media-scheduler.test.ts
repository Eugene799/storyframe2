import { afterEach, describe, expect, it, vi } from "vitest";
import { startMediaSweeper } from "../server/media-scheduler";

const silent = { error: () => undefined };

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduled media sweep", () => {
  it("runs one pass per interval and stops cleanly", async () => {
    vi.useFakeTimers();
    let passes = 0;
    const sweeper = startMediaSweeper({
      intervalMs: 1000,
      sweep: async () => {
        passes += 1;
      },
      logger: silent,
    });
    expect(sweeper).not.toBeNull();

    await vi.advanceTimersByTimeAsync(999);
    expect(passes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(passes).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(passes).toBe(3);

    sweeper?.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(passes).toBe(3);
  });

  it("does not overlap a pass that is still running", async () => {
    vi.useFakeTimers();
    const resolvers: (() => void)[] = [];
    let passes = 0;
    const sweeper = startMediaSweeper({
      intervalMs: 100,
      sweep: () => {
        passes += 1;
        return new Promise<void>((resolve) => resolvers.push(resolve));
      },
      logger: silent,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(passes).toBe(1);
    // Several ticks pass while the first pass is still working.
    await vi.advanceTimersByTimeAsync(500);
    expect(passes).toBe(1);

    resolvers.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(passes).toBe(2);

    sweeper?.stop();
    for (const resolve of resolvers) resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(passes).toBe(2);
  });

  it("logs a failed pass and keeps scheduling", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    let passes = 0;
    const sweeper = startMediaSweeper({
      intervalMs: 100,
      sweep: async () => {
        passes += 1;
        if (passes === 1) throw new Error("store down");
      },
      logger: { error: (message) => errors.push(message) },
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(errors).toEqual(["[media] MEDIA_SWEEP_FAILED"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(passes).toBe(2);

    sweeper?.stop();
  });

  it("treats a synchronous throw as a failed pass", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    let passes = 0;
    const sweeper = startMediaSweeper({
      intervalMs: 100,
      sweep: () => {
        passes += 1;
        if (passes === 1) throw new Error("synchronous failure");
        return Promise.resolve();
      },
      logger: { error: (message) => errors.push(message) },
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(errors).toEqual(["[media] MEDIA_SWEEP_FAILED"]);
    // The guard was released, so the next tick still runs.
    await vi.advanceTimersByTimeAsync(100);
    expect(passes).toBe(2);

    sweeper?.stop();
  });

  it("is disabled when the interval is zero", () => {
    expect(startMediaSweeper({ intervalMs: 0, sweep: async () => undefined, logger: silent })).toBeNull();
  });
});
