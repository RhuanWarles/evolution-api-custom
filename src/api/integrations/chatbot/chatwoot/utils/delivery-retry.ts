/**
 * Retry helpers for delivering WhatsApp messages to Chatwoot while it is temporarily unavailable
 * (restart, proxy without backend, network blip).
 */

export type ErrorClass = 'retry' | 'permanent';

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_NETWORK',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const RETRYABLE_STATUS = new Set([408, 425, 429]);

/** Chatwoot answers real errors with a JSON object; a proxy answers with plain text/HTML or nothing. */
function isChatwootJsonBody(body: unknown): boolean {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return true;
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Decides whether a Chatwoot delivery error is worth retrying.
 * - network errors, timeouts, 408/425/429 and 5xx: retry
 * - 404: retry only when the body is not Chatwoot's JSON (a proxy with no backend); a real
 *   "resource not found" from Chatwoot is permanent
 * - other 4xx and programming errors (TypeError, ReferenceError, ...): permanent
 */
export function classifyChatwootError(error: any): ErrorClass {
  if (!error) return 'permanent';

  const status: number | undefined = error.status ?? error.response?.status;

  if (typeof status === 'number') {
    if (status >= 500 || RETRYABLE_STATUS.has(status)) return 'retry';
    if (status === 404) {
      const body = error.body !== undefined ? error.body : error.response?.data;
      return isChatwootJsonBody(body) ? 'permanent' : 'retry';
    }
    return 'permanent';
  }

  const code: string | undefined = error.code ?? error.cause?.code;
  if (code && NETWORK_ERROR_CODES.has(code)) return 'retry';

  if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'retry';
  if (error.isAxiosError && !error.response) return 'retry';
  if (error.name === 'FetchError' || /fetch failed|socket hang up|timeout of \d+ms exceeded/i.test(error.message || ''))
    return 'retry';

  return 'permanent';
}

export type DeliveryOutcome = 'delivered' | 'retry' | 'give-up';

export type DeliveryJob = {
  label: string;
  /** Runs one delivery attempt. Must not throw for expected failures; return 'retry' or 'give-up'. */
  attempt: () => Promise<DeliveryOutcome>;
  /** Called when all attempts were used without success. */
  onExhausted: (attempts: number) => void | Promise<void>;
  /** Called once when the job leaves the queue, whatever the outcome. */
  onSettled?: () => void | Promise<void>;
  /** Skip the initial wait before the first attempt (the job has not been tried yet). */
  immediate?: boolean;
};

/** Backoff between attempts: 2s,5s,10s,20s then 30s x6 = 217s (~3.6 min) of total waiting. */
export const DEFAULT_RETRY_DELAYS_MS = [2000, 5000, 10000, 20000, 30000, 30000, 30000, 30000, 30000, 30000];

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Background retry queue keyed by conversation: jobs of the same key run strictly in order, one at a
 * time, while different keys run independently. Waiting happens here, never while holding a lock and
 * never inside the caller that received the WhatsApp message.
 */
export class OrderedRetryQueue {
  private readonly queues = new Map<string, DeliveryJob[]>();

  constructor(
    private readonly delaysMs: number[] = DEFAULT_RETRY_DELAYS_MS,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly onUnexpectedError: (error: unknown) => void = () => undefined,
  ) {}

  hasPending(key: string): boolean {
    return this.queues.has(key);
  }

  /** Resolves when the queue for this key is empty. Mostly useful for tests and graceful shutdown. */
  async idle(key: string): Promise<void> {
    while (this.queues.has(key)) await defaultSleep(1);
  }

  enqueue(key: string, job: DeliveryJob): void {
    const queue = this.queues.get(key);
    if (queue) {
      queue.push(job);
      return;
    }

    this.queues.set(key, [job]);
    void this.drain(key);
  }

  private async drain(key: string): Promise<void> {
    const queue = this.queues.get(key);

    while (queue && queue.length > 0) {
      const job = queue[0];
      try {
        await this.run(job);
      } catch (error) {
        this.onUnexpectedError(error);
      } finally {
        queue.shift();
        try {
          await job.onSettled?.();
        } catch (error) {
          this.onUnexpectedError(error);
        }
      }
    }

    this.queues.delete(key);
  }

  private async run(job: DeliveryJob): Promise<void> {
    const waits = job.immediate ? [0, ...this.delaysMs] : this.delaysMs;
    let attempts = 0;

    for (const wait of waits) {
      if (wait > 0) await this.sleep(wait);
      attempts += 1;

      let outcome: DeliveryOutcome;
      try {
        outcome = await job.attempt();
      } catch (error) {
        this.onUnexpectedError(error);
        outcome = 'give-up';
      }

      if (outcome !== 'retry') return;
    }

    await job.onExhausted(attempts);
  }
}
