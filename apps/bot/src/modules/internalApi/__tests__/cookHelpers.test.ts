/**
 * n-us 用 cook 統合の純粋関数 unit test。
 *
 * Discord client / Prisma / Recording / RecorderModule の副作用を避けるため、
 * 純粋関数は `cookHelpers.ts` に切り出してそれを test 対象にする。
 *
 * Semaphore (`acquireCookSlot` / `releaseCookSlot`) は内部状態が `index.ts`
 * module スコープに閉じており、test 経由で操作するには `index.ts` 全体を
 * import する必要があるが、`index.ts` は Recording / Discord 系の重い依存を
 * 持つため test 実行環境を整備するコストが高い。semaphore unit test は
 * 別 PR で test harness を整備してから対応する。
 *
 * Round 5 NR4-7 対応: 最初の craig 側 unit test の足場を作る。
 */
import { describe, it, expect } from 'vitest';
import {
  assertValidRecordingId,
  RECORDING_ID_PATTERN,
  parseTimeoutMs,
  maskId,
  COOK_TIMEOUT_MS_DEFAULT
} from '../cookHelpers';

describe('assertValidRecordingId', () => {
  it('英数 + アンダースコア + ハイフン 1〜64 文字を受理', () => {
    expect(() => assertValidRecordingId('abc')).not.toThrow();
    expect(() => assertValidRecordingId('mRrCzyVpf1Xu')).not.toThrow();
    expect(() => assertValidRecordingId('abc_123-def')).not.toThrow();
    expect(() => assertValidRecordingId('a'.repeat(64))).not.toThrow();
  });

  it('空文字を reject (cleanupRecordingArtifacts の startsWith 巻き込み防止)', () => {
    expect(() => assertValidRecordingId('')).toThrow(/Invalid recordingId/);
  });

  it('path traversal を reject', () => {
    expect(() => assertValidRecordingId('../foo')).toThrow(/Invalid recordingId/);
    expect(() => assertValidRecordingId('foo/bar')).toThrow(/Invalid recordingId/);
    expect(() => assertValidRecordingId('foo\\bar')).toThrow(/Invalid recordingId/);
  });

  it('空白文字を reject', () => {
    expect(() => assertValidRecordingId(' abc')).toThrow(/Invalid recordingId/);
    expect(() => assertValidRecordingId('abc ')).toThrow(/Invalid recordingId/);
    expect(() => assertValidRecordingId('abc def')).toThrow(/Invalid recordingId/);
  });

  it('65 文字以上を reject', () => {
    expect(() => assertValidRecordingId('a'.repeat(65))).toThrow(/Invalid recordingId/);
  });

  it('非文字列を reject', () => {
    expect(() => assertValidRecordingId(undefined)).toThrow(/Invalid recordingId/);
    expect(() => assertValidRecordingId(null)).toThrow(/Invalid recordingId/);
    expect(() => assertValidRecordingId(123)).toThrow(/Invalid recordingId/);
    expect(() => assertValidRecordingId({})).toThrow(/Invalid recordingId/);
  });

  it('error message に制御文字を含まない (log injection ガード)', () => {
    try {
      assertValidRecordingId('foo\nbar\x00baz');
    } catch (e: any) {
      // \n や \x00 は ? に置換されている
      expect(e.message).not.toContain('\n');
      expect(e.message).not.toContain('\x00');
      expect(e.message).toContain('?');
    }
  });

  it('RECORDING_ID_PATTERN を export している (定数の一元管理)', () => {
    expect(RECORDING_ID_PATTERN).toBeInstanceOf(RegExp);
    expect(RECORDING_ID_PATTERN.test('abc123')).toBe(true);
    expect(RECORDING_ID_PATTERN.test('../foo')).toBe(false);
  });
});

describe('parseTimeoutMs', () => {
  it('未定義 / 空文字は default に倒れる', () => {
    expect(parseTimeoutMs(undefined)).toBe(COOK_TIMEOUT_MS_DEFAULT);
    expect(parseTimeoutMs('')).toBe(COOK_TIMEOUT_MS_DEFAULT);
  });

  it('正の整数文字列はそのまま number 化される', () => {
    expect(parseTimeoutMs('1000')).toBe(1000);
    expect(parseTimeoutMs('300000')).toBe(300000);
    expect(parseTimeoutMs('1')).toBe(1);
  });

  it('NaN / 0 / 負値は default に倒れる', () => {
    expect(parseTimeoutMs('NaN')).toBe(COOK_TIMEOUT_MS_DEFAULT);
    expect(parseTimeoutMs('0')).toBe(COOK_TIMEOUT_MS_DEFAULT);
    expect(parseTimeoutMs('-100')).toBe(COOK_TIMEOUT_MS_DEFAULT);
  });

  it('typo は Number() でも NaN 化されて default に倒れる (NR4-8)', () => {
    // 旧 parseInt 実装だと '600000ms' → 600000 と partial parse されていた
    expect(parseTimeoutMs('600000ms')).toBe(COOK_TIMEOUT_MS_DEFAULT);
    expect(parseTimeoutMs('abc')).toBe(COOK_TIMEOUT_MS_DEFAULT);
    expect(parseTimeoutMs('1.5abc')).toBe(COOK_TIMEOUT_MS_DEFAULT);
  });

  it('小数点を含む正数は Number(raw) で float になり Number.isFinite で通る', () => {
    // setTimeout は ms 精度なので float でも実害は無いが仕様としては許容
    expect(parseTimeoutMs('1500.5')).toBe(1500.5);
  });

  it('COOK_TIMEOUT_MS_DEFAULT は 10 分 (600000ms)', () => {
    expect(COOK_TIMEOUT_MS_DEFAULT).toBe(600000);
  });
});

describe('maskId (NR4-4 sensitive log policy + NR5-5 短 ID 強化)', () => {
  it('8 文字以上は末尾 4 文字を残してマスク', () => {
    expect(maskId('mRrCzyVpf1Xu')).toBe('...f1Xu'); // 12 文字 (craig 実 ID)
    expect(maskId('abcdefghij')).toBe('...ghij'); // 10 文字
    expect(maskId('abcdefgh')).toBe('...efgh'); // 8 文字 (境界値)
  });

  it('NR5-5: 8 文字未満 (短 ID) は全マスクで mask 率を担保', () => {
    // 旧実装は 5 文字 'abcde' → '...bcde' (80% 平文) で mask の意味が薄かった。
    // 8 文字未満は全 mask に倒すことで mask 率を 100% にする。
    expect(maskId('a')).toBe('*');
    expect(maskId('ab')).toBe('**');
    expect(maskId('abcd')).toBe('****');
    expect(maskId('abcde')).toBe('*****'); // 5 文字 — NR5-5 で改善された境界
    expect(maskId('abcdefg')).toBe('*******'); // 7 文字 — まだ境界内
  });

  it('空文字 / 非文字列は <empty>', () => {
    expect(maskId('')).toBe('<empty>');
    expect(maskId(undefined as any)).toBe('<empty>');
    expect(maskId(null as any)).toBe('<empty>');
  });
});
