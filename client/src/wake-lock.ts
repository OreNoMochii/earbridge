// Keeps the screen on during a conversation: phones suspend web pages (and their
// microphone) once the screen locks.

export class ScreenWakeLock {
  private sentinel: WakeLockSentinel | undefined;
  private active = false;

  start(): void {
    if (this.active) return;
    this.active = true;
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    void this.acquire();
  }

  stop(): void {
    this.active = false;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.sentinel?.release().catch(() => {});
    this.sentinel = undefined;
  }

  // The browser releases the lock whenever the page is hidden.
  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') void this.acquire();
  };

  private async acquire(): Promise<void> {
    if (!('wakeLock' in navigator) || (this.sentinel && !this.sentinel.released)) return;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      if (this.active) this.sentinel = sentinel;
      else await sentinel.release();
    } catch {
      // Refused (e.g. battery saver). Everything still works while the screen stays on.
    }
  }
}
