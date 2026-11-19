import { DOWNLOADER_ERROR_CODES, DownloaderError } from './errors.js';

/**
 * Concurrency-bounded FIFO download queue preventing concurrent yt-dlp/FFmpeg jobs
 * from exhausting CPU, memory, or disk while rejecting excessive queue bursts cleanly.
 */
export class DownloadQueue {
  /**
   * @param {{ maxConcurrent?: number, maxQueueSize?: number }} [options]
   */
  constructor({ maxConcurrent = 3, maxQueueSize = 10 } = {}) {
    this.maxConcurrent = Math.max(1, Number(maxConcurrent) || 3);
    this.maxQueueSize = Math.max(0, Number(maxQueueSize) || 0);
    this.activeCount = 0;
    this.waiting = [];
  }

  /**
   * @returns {number}
   */
  getActiveCount() {
    return this.activeCount;
  }

  /**
   * @returns {number}
   */
  getPendingCount() {
    return this.waiting.length;
  }

  /**
   * Updates runtime bounds dynamically (e.g. when per-call config overrides defaults).
   *
   * @param {{ maxConcurrent?: number, maxQueueSize?: number }} [options]
   */
  configure({ maxConcurrent, maxQueueSize } = {}) {
    if (typeof maxConcurrent === 'number' && maxConcurrent >= 1) {
      this.maxConcurrent = maxConcurrent;
    }
    if (typeof maxQueueSize === 'number' && maxQueueSize >= 0) {
      this.maxQueueSize = maxQueueSize;
    }
  }

  /**
   * Schedules an async task under the queue's concurrency limit.
   * Rejects immediately with `BUSY` if active slots are full and the waiting queue is at capacity.
   *
   * @template T
   * @param {() => Promise<T>} taskFn
   * @param {{ onQueued?: (position: number) => void | Promise<void> }} [options]
   * @returns {Promise<T>}
   */
  async enqueue(taskFn, options = {}) {
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount += 1;
      try {
        return await taskFn();
      } finally {
        this.activeCount = Math.max(0, this.activeCount - 1);
        this._drain();
      }
    }

    if (this.waiting.length >= this.maxQueueSize) {
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.BUSY,
        'Antrean unduhan sedang penuh. Silakan tunggu beberapa detik lalu coba lagi.',
      );
    }

    const position = this.waiting.length + 1;
    let resolveFn;
    let rejectFn;
    const queuedPromise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    this.waiting.push({ taskFn, resolve: resolveFn, reject: rejectFn });

    if (typeof options.onQueued === 'function') {
      Promise.resolve(options.onQueued(position)).catch(() => {});
    }

    return queuedPromise;
  }

  _drain() {
    while (this.activeCount < this.maxConcurrent && this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (!next) break;
      this.activeCount += 1;
      Promise.resolve()
        .then(() => next.taskFn())
        .then(
          (val) => next.resolve(val),
          (err) => next.reject(err),
        )
        .finally(() => {
          this.activeCount = Math.max(0, this.activeCount - 1);
          this._drain();
        });
    }
  }
}

export const defaultDownloadQueue = new DownloadQueue();
