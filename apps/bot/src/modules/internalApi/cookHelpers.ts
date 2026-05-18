/**
 * n-us 用 cook 統合の純粋関数群。
 *
 * index.ts は Discord client / Prisma / Recording / RecorderModule を import するため、
 * unit test 用に副作用なしで import できるファイルに分離している。
 *
 * NR4-7 (Round 5): assertValidRecordingId / parseTimeoutMs / maskId のユニットテストを
 * craig 側でも書けるようにするための切り出し。
 */

/**
 * 録音 ID の format 制約:
 *   - 英数字 + アンダースコア + ハイフン
 *   - 1〜64 文字
 *
 * 用途:
 *   - spawn args / path.join / startsWith マッチング前の defense in depth
 *   - 空文字 (cleanupRecordingArtifacts の startsWith 巻き込み) / path traversal
 *     (`../foo`) / control char 混入を入口で reject
 *   - craig 内部の recording.id は短い英数 (現状 [A-Za-z0-9]{12}) なので互換あり
 */
export const RECORDING_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function assertValidRecordingId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !RECORDING_ID_PATTERN.test(id)) {
    // ログに混ぜても安全な形で再現可能な error message を作る。
    const safe = typeof id === 'string' ? id.slice(0, 64).replace(/[^\x20-\x7e]/g, '?') : typeof id;
    throw new Error(`Invalid recordingId (must match ${RECORDING_ID_PATTERN}): "${safe}"`);
  }
}

/**
 * COOK_TIMEOUT_MS / その他 env 由来の ms 値を安全にパースする。
 *
 * - NaN / 0 / 負値 → default に倒す
 * - 旧 parseInt は前方一致パースで `'600000abc'` を 600000 と partial parse していたが、
 *   Number(raw) なら typo は NaN 化されて default に倒れる (NR4-8 対応)
 * - `''` / undefined は default
 */
export const COOK_TIMEOUT_MS_DEFAULT = 600000; // 10 min

export function parseTimeoutMs(raw: string | undefined): number {
  if (!raw) return COOK_TIMEOUT_MS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : COOK_TIMEOUT_MS_DEFAULT;
}

/**
 * session/recording id を log に混ぜる際の masking。
 *
 * 末尾 4 文字を残し `...xyz9` 形式で出す。完全削除すると debug 不能、フル平文だと
 * log retention policy / GDPR 観点で扱いが煩雑になる ため間を取る (NR4-4)。
 * error log (Cook failed 等の異常系) はフル ID のままで debug 性を優先する。
 *
 * 注意: 既存 craig log と完全に揃ってはいない。craig 全体の log policy 整備は
 * 別 PR で実施する想定。
 */
export function maskId(id: string): string {
  if (typeof id !== 'string' || id.length === 0) return '<empty>';
  if (id.length <= 4) return '*'.repeat(id.length);
  return `...${id.slice(-4)}`;
}
