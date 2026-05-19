/**
 * cook 並列実行制限の簡易 semaphore。
 *
 * index.ts から切り出した module スコープ state + 純粋ロジック (NR5-2 対応)。
 * `acquireCookSlot` は最大同時数 (`maxConcurrent`) を引数で受け取るため、env から
 * `MAX_CONCURRENT_COOKS` を読む副作用は caller (index.ts) 側に閉じる。
 *
 * セマンティクス:
 *   - `activeCooks < maxConcurrent`: 即時取得 (`activeCooks++`)
 *   - それ以外: queue に push、`releaseCookSlot` で順次起動 (FIFO)
 *
 * 注意: Node.js single-thread 前提。activeCooks / queue の race は構造的に存在しない。
 */

let activeCooks = 0;
const cookWaitQueue: (() => void)[] = [];

export function acquireCookSlot(maxConcurrent: number): Promise<void> {
  if (activeCooks < maxConcurrent) {
    activeCooks++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    cookWaitQueue.push(() => {
      activeCooks++;
      resolve();
    });
  });
}

export function releaseCookSlot(): void {
  activeCooks--;
  const next = cookWaitQueue.shift();
  if (next) next();
}

/** テスト用: semaphore の内部状態を観測 (本番フローからは呼ばない) */
export function _getCookSemaphoreState(): { active: number; queueLength: number } {
  return { active: activeCooks, queueLength: cookWaitQueue.length };
}

/** テスト用: 内部状態を強制リセット (test 間の state leak 防止) */
export function _resetCookSemaphore(): void {
  activeCooks = 0;
  cookWaitQueue.length = 0;
}
