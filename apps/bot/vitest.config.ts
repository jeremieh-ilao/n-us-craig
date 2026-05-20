import { defineConfig } from 'vitest/config';

// n-us 用に追加した internalApi cook 統合系の純粋関数 / semaphore ロジックの
// ユニットテストを走らせるための最小設定。Discord / Prisma / Redis 等の
// 重い依存は触らず、純粋ロジックのみを test する。
//
// CI 統合: 現状 n-us-craig 側に独立 CI は無く、n-us 親リポ側 CI でも craig
// submodule の test まではまだ自動実行していない。ローカル開発者向けに `yarn test`
// で走らせる前提。将来 CI 統合は別 PR で対応。
export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/__tests__/**/*.test.ts'],
    testTimeout: 10000,
    hookTimeout: 10000,
    pool: 'forks',
    // NR5-6: singleFork の理由を明示。
    // - `cookSemaphore.ts` は module-scope の mutable state (activeCooks / cookWaitQueue) を持つ
    //   ため、test ファイル間 / test 間で state leak しないように単一プロセスで直列実行する
    // - 各 test の beforeEach で `_resetCookSemaphore()` を呼んで内部 state を初期化することと併用
    // - 副作用ゼロの `cookHelpers.ts` test だけなら並列で問題ないが、混在運用のため安全側に倒している
    poolOptions: {
      forks: {
        singleFork: true
      }
    }
  }
});
