export interface MediaSweeperOptions {
  /** Cadence of the background pass. Zero or less disables the timer. */
  intervalMs: number;
  sweep: () => Promise<void>;
  logger?: { error(message: string): void };
}

export interface MediaSweeper {
  stop(): void;
}

/**
 * Runs the bounded media sweep on a timer, so an idle server still expires
 * interrupted uploads and retention rows instead of waiting for the next media
 * request. A pass that is still running is never overlapped by the next tick,
 * and a failed pass is logged and retried on the following tick.
 *
 * `intervalMs <= 0` disables the timer; media requests keep triggering an
 * opportunistic pass, which is what the tests and live scripts use.
 */
export function startMediaSweeper(options: MediaSweeperOptions): MediaSweeper | null {
  if (options.intervalMs <= 0) return null;
  const log = options.logger ?? console;
  let running = false;

  const timer = setInterval(() => {
    if (running) return;
    running = true;
    // Deferred so a synchronous throw is handled like a rejected pass instead
    // of escaping the timer callback and leaving `running` stuck at true.
    void Promise.resolve()
      .then(() => options.sweep())
      .catch(() => log.error("[media] MEDIA_SWEEP_FAILED"))
      .finally(() => {
        running = false;
      });
  }, options.intervalMs);
  // Never keep the process alive only for cleanup.
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
