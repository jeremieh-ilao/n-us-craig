/**
 * cookSemaphore.ts の unit test (NR5-2 対応)。
 *
 * Round 5 で「test harness 大規模」として別 PR 先送りしていたが、レビュアー指摘通り
 * semaphore は副作用ゼロの純粋ロジックで `cookSemaphore.ts` に切り出せば test 可能。
 *
 * 内部 state (`activeCooks` / `cookWaitQueue`) は module スコープに閉じているため、
 * 各 test の beforeEach で `_resetCookSemaphore()` を呼んで初期化する。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  acquireCookSlot,
  releaseCookSlot,
  _getCookSemaphoreState,
  _resetCookSemaphore
} from '../cookSemaphore';

describe('cookSemaphore', () => {
  beforeEach(() => {
    _resetCookSemaphore();
  });

  describe('acquireCookSlot', () => {
    it('maxConcurrent 未満なら即時取得 (active++)', async () => {
      expect(_getCookSemaphoreState()).toEqual({ active: 0, queueLength: 0 });

      await acquireCookSlot(2);
      expect(_getCookSemaphoreState()).toEqual({ active: 1, queueLength: 0 });

      await acquireCookSlot(2);
      expect(_getCookSemaphoreState()).toEqual({ active: 2, queueLength: 0 });
    });

    it('maxConcurrent 到達時は queue に push され同期的には resolve しない', async () => {
      await acquireCookSlot(2);
      await acquireCookSlot(2);
      expect(_getCookSemaphoreState().active).toBe(2);

      let resolved = false;
      const p = acquireCookSlot(2).then(() => {
        resolved = true;
      });

      // microtask を一回流しても resolve しない
      await Promise.resolve();
      await Promise.resolve();
      expect(resolved).toBe(false);
      expect(_getCookSemaphoreState()).toEqual({ active: 2, queueLength: 1 });

      // cleanup
      releaseCookSlot();
      await p;
    });

    it('maxConcurrent=1 で順次直列実行される', async () => {
      const order: string[] = [];

      await acquireCookSlot(1);
      order.push('1st-acquired');

      const p2 = acquireCookSlot(1).then(() => order.push('2nd-acquired'));
      const p3 = acquireCookSlot(1).then(() => order.push('3rd-acquired'));

      releaseCookSlot();
      await p2;
      releaseCookSlot();
      await p3;

      expect(order).toEqual(['1st-acquired', '2nd-acquired', '3rd-acquired']);
    });

    it('FIFO 順序 (Array.shift) で queue 解放', async () => {
      await acquireCookSlot(2);
      await acquireCookSlot(2);

      const order: string[] = [];
      const p1 = acquireCookSlot(2).then(() => order.push('first'));
      const p2 = acquireCookSlot(2).then(() => order.push('second'));
      const p3 = acquireCookSlot(2).then(() => order.push('third'));

      releaseCookSlot();
      await p1;
      expect(order).toEqual(['first']);

      releaseCookSlot();
      await p2;
      expect(order).toEqual(['first', 'second']);

      releaseCookSlot();
      await p3;
      expect(order).toEqual(['first', 'second', 'third']);
    });
  });

  describe('releaseCookSlot', () => {
    it('queue 空ならただ active-- するだけ', async () => {
      await acquireCookSlot(2);
      await acquireCookSlot(2);
      expect(_getCookSemaphoreState().active).toBe(2);

      releaseCookSlot();
      expect(_getCookSemaphoreState()).toEqual({ active: 1, queueLength: 0 });

      releaseCookSlot();
      expect(_getCookSemaphoreState()).toEqual({ active: 0, queueLength: 0 });
    });

    it('queue 待機中なら最古の待機者を起動', async () => {
      await acquireCookSlot(1);
      let firstResolved = false;
      const p1 = acquireCookSlot(1).then(() => {
        firstResolved = true;
      });
      expect(_getCookSemaphoreState()).toEqual({ active: 1, queueLength: 1 });

      releaseCookSlot();
      await p1;
      expect(firstResolved).toBe(true);
      // 待機者が起動して active が 1 のまま、queue は空になる
      expect(_getCookSemaphoreState()).toEqual({ active: 1, queueLength: 0 });

      releaseCookSlot();
      expect(_getCookSemaphoreState()).toEqual({ active: 0, queueLength: 0 });
    });
  });

  describe('動的に maxConcurrent を変更しても矛盾しない', () => {
    it('maxConcurrent=2 で取得 → maxConcurrent=3 で 3 つ目を即時取得', async () => {
      // production では env 由来の固定値だが、関数 signature 上は呼び出しごとに変更可能。
      // 取得済み slot は max の変動に追従しない (acquire 時のみ判定) ので、
      // 3 つ目の取得は新しい max=3 で判定される
      await acquireCookSlot(2);
      await acquireCookSlot(2);
      expect(_getCookSemaphoreState().active).toBe(2);

      await acquireCookSlot(3);
      expect(_getCookSemaphoreState().active).toBe(3);
      expect(_getCookSemaphoreState().queueLength).toBe(0);
    });
  });

  describe('_resetCookSemaphore (テスト用)', () => {
    it('内部 state を 0 にリセット', async () => {
      await acquireCookSlot(2);
      await acquireCookSlot(2);
      const p = acquireCookSlot(2);
      expect(_getCookSemaphoreState()).toEqual({ active: 2, queueLength: 1 });

      _resetCookSemaphore();
      expect(_getCookSemaphoreState()).toEqual({ active: 0, queueLength: 0 });

      // 注意: 待機中の Promise は orphan になる (reject されない)。
      // 本番フローではこの API は呼ばないため問題ないが、test では beforeEach で reset するだけ。
      void p;
    });
  });
});
