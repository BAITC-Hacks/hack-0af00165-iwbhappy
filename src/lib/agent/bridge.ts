/**
 * Мост между синхронным колбэком и асинхронным генератором.
 *
 * completeStream() отдаёт токены через onToken по мере их прихода,
 * а агентный цикл — это генератор: отдать что-то наружу он может
 * только через yield. Без такой очереди токены копятся в массиве
 * и уезжают в интерфейс одним куском уже после ответа модели,
 * то есть стриминга нет, хотя по коду кажется, что есть.
 */

export type Bridge<T> = {
  /** Токены по мере поступления; завершается, когда run() отработал. */
  tokens(): AsyncGenerator<string, void, unknown>;
  /** Итог run(); бросает ту же ошибку, что и он. */
  result(): Promise<T>;
};

export function bridgeTokens<T>(run: (onToken: (t: string) => void) => Promise<T>): Bridge<T> {
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let failure: unknown = null;
  let value: T | undefined;

  const ping = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  const task = run((t) => {
    queue.push(t);
    ping();
  })
    .then((v) => { value = v; })
    .catch((e) => { failure = e; })
    .finally(() => { finished = true; ping(); });

  return {
    async *tokens() {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (finished) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
          // Токен мог прийти между проверкой очереди и подпиской — тогда
          // ping() уже прозвенел вхолостую, и ждать больше нечего.
          if (queue.length || finished) {
            wake = null;
            resolve();
          }
        });
      }
    },
    async result() {
      await task;
      if (failure) throw failure;
      return value as T;
    },
  };
}
