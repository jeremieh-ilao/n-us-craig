import fastify, { FastifyInstance } from 'fastify';
import { spawn } from 'child_process';
import Recording from '../recorder/recording';
import RecorderModule from '../recorder';
import { DEFAULT_REWARDS } from './rewards';
import { checkInternalSecret } from './auth';
import { sendWebhook } from './webhook';
import path from 'path';
import fs from 'fs';

const sessionToRecording = new Map<string, string>();

let server: FastifyInstance | null = null;

// 他の COOK_* env と一貫して上書き可能にする。default は production の image 内パス。
// テスト時にローカル mock script を差し替えるためにも env override 経路が必要。
const COOK_SCRIPT_PATH = process.env.COOK_SCRIPT_PATH || '/app/cook.sh';

// recordingId を spawn args / path.join に渡す前に必ず validate する。
// 防御目的:
//   - 空文字 → `cleanupRecordingArtifacts` の startsWith マッチで `${id}.ogg.log.` が `.ogg.log.`
//     になり、ディレクトリ内の他セッションの log ローテーション分まで巻き込んで削除されるのを防ぐ
//   - `../foo` 等の path traversal → `path.join` で normalize されて親ディレクトリ参照に化ける
//   - `--help` 等のフラグ風文字列 → cook.sh の引数パース脆弱性に依存しないよう shape を制限
// craig 内部の recording.id は短い英数 (現状 [A-Za-z0-9]{12}) だが HMAC API 経由で間接的に
// 渡るため defense in depth として正規表現で厳格化する。
const RECORDING_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
function assertValidRecordingId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !RECORDING_ID_PATTERN.test(id)) {
    // ログに混ぜても安全な形で再現可能な error message を作る。
    const safe = typeof id === 'string' ? id.slice(0, 64).replace(/[^\x20-\x7e]/g, '?') : typeof id;
    throw new Error(`Invalid recordingId (must match ${RECORDING_ID_PATTERN}): "${safe}"`);
  }
}
// 'oggflac' は FLAC を Ogg コンテナに入れた形式 (OggS magic を持つ)。
// 'flac' を使うと裸 FLAC (fLaC magic) が生成されるが、下の magic 検証が
// OggS 固定で reject + 削除してしまう (n-us-craig の以前のバグ)。
// その上 .cook.ogg 拡張子と中身 raw FLAC の食い違いで MIME type 不整合も起きるため、
// 既定値を oggflac にして「拡張子・magic・MIME 全部 Ogg」で揃える。
// 他の Ogg コンテナ形式 (opus, vorbis) も OggS で検証を通過する。
const COOK_FORMAT = process.env.COOK_FORMAT || 'oggflac';
const COOK_CONTAINER = process.env.COOK_CONTAINER || 'mix';

// COOK_TIMEOUT_MS は NaN / 0 / 負値を検出して default (10 min) に倒す。
// parseInt('', 10) = NaN, parseInt('abc', 10) = NaN になり、そのまま
// setTimeout(fn, NaN) すると即時実行で cook が起動した瞬間 SIGKILL される。
const COOK_TIMEOUT_MS_DEFAULT = 600000; // 10 min
function parseTimeoutMs(raw: string | undefined): number {
  if (!raw) return COOK_TIMEOUT_MS_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : COOK_TIMEOUT_MS_DEFAULT;
}
const COOK_TIMEOUT_MS = parseTimeoutMs(process.env.COOK_TIMEOUT_MS);

// stderr バッファ上限。cook が 10 分動作中に大量 stderr を出すと OOM につながる。
// エラー解析には末尾の方が情報量が多いので、末尾を残す形で truncate する。
const STDERR_MAX_BYTES = 65536; // 64KB
// reject の error message に貼り付ける stderr 末尾の長さ。
// 旧実装は 200 / 500 と箇所ごとに不揃いだったため定数化。bot 側 sanitizeCookErrorForDiscord で
// 500 char slice する設計と整合するよう 500 に統一。
const STDERR_TAIL_FOR_ERROR = 500;

// 並列 cook 制限。同時に複数セッションが終了すると複数 cook プロセスが
// 同時 spawn されメモリ + CPU + ディスクを枯渇させる。簡易 semaphore で制限する。
const MAX_CONCURRENT_COOKS = (() => {
  const n = parseInt(process.env.MAX_CONCURRENT_COOKS || '2', 10);
  return Number.isFinite(n) && n > 0 ? n : 2;
})();
let activeCooks = 0;
const cookWaitQueue: (() => void)[] = [];

function acquireCookSlot(): Promise<void> {
  if (activeCooks < MAX_CONCURRENT_COOKS) {
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

function releaseCookSlot(): void {
  activeCooks--;
  const next = cookWaitQueue.shift();
  if (next) next();
}

// raw fragments + cook output の削除対象 (cook + webhook 完了後の cleanup 用)。
// `.ogg.log.N` (ローテーション分) も対象に含めるため、ディレクトリスキャンで補完する。
const RAW_FRAGMENT_SUFFIXES = [
  '.ogg.data',
  '.ogg.header1',
  '.ogg.header2',
  '.ogg.users',
  '.ogg.info',
  '.ogg.log',
];

function cleanupRecordingArtifacts(
  recordingPath: string,
  recordingId: string,
  // 旧 interface は warn も受けていたが body 内で未使用だった (dead interface 部分)。info のみに絞る。
  logger: { info: (msg: string) => void }
): void {
  // path.join / startsWith マッチ前の defense in depth。呼び出し元 (processCookAndWebhook) は
  // /stop endpoint 経由でしか到達せず recording.id は craig 内部生成だが、ここまで来る経路に
  // 想定外の入力が混ざっても安全に exit させる。
  assertValidRecordingId(recordingId);
  const targets = new Set<string>([
    path.join(recordingPath, `${recordingId}.cook.ogg`),
    ...RAW_FRAGMENT_SUFFIXES.map((s) => path.join(recordingPath, `${recordingId}${s}`))
  ]);
  // `.ogg.log.1`, `.ogg.log.2`, ... のローテーション分
  try {
    for (const entry of fs.readdirSync(recordingPath)) {
      if (entry.startsWith(`${recordingId}.ogg.log.`)) {
        targets.add(path.join(recordingPath, entry));
      }
    }
  } catch {
    // recordingPath が存在しない等のレアケース。次の unlink 試行でどうせ失敗するので無視。
  }
  let removed = 0;
  // Set の iteration は tsconfig target に依存するため、Array.from 経由で確実に。
  for (const t of Array.from(targets)) {
    try {
      fs.unlinkSync(t);
      removed++;
    } catch {
      // 元々存在しない or 既に削除済 → 無視
    }
  }
  logger.info(`Cleaned up ${removed} artifacts for recording ${recordingId}`);
}

/**
 * cook.sh を起動し、録音 fragments を単一 .ogg にまとめて
 * `<recordingPath>/<id>.cook.ogg` として保存する。
 */
async function runCook(
  recordingId: string,
  recorder: RecorderModule<any>
): Promise<{ outputPath: string; size: number }> {
  // 入口で recordingId を validate。spawn args / path.join 双方で defense in depth。
  assertValidRecordingId(recordingId);

  const outputPath = path.join(recorder.recordingPath, `${recordingId}.cook.ogg`);

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const outStream = fs.createWriteStream(outputPath);

    // エラーパス共通の cleanup: 出力 stream を閉じ、部分書き込みファイルを削除する。
    // 旧実装は spawn error 時に outStream を閉じず FD leak していた。
    const cleanupPartialOutput = () => {
      try { outStream.destroy(); } catch {}
      try { fs.unlinkSync(outputPath); } catch {}
    };

    // outStream の error handler を spawn 前に登録する。createWriteStream の `open` syscall
    // 失敗 (ENOENT 等) は process.nextTick で error event を発火するため、登録が後の方が
    // race window がほぼゼロでも理論上は逃す可能性がある。defense in depth で先に置く。
    outStream.on('error', (err) => {
      clearTimeout(killTimer);
      // proc 未起動の場合 kill は no-op、後で起動した場合は kill して停止させる。
      try { proc?.kill?.('SIGKILL'); } catch {}
      try { fs.unlinkSync(outputPath); } catch {}
      settle(() => reject(new Error(`cook output stream failed: ${err.message}`)));
    });

    const proc = spawn(COOK_SCRIPT_PATH, [recordingId, COOK_FORMAT, COOK_CONTAINER], {
      cwd: '/app',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
      }
    });

    // `stdio: ['ignore', 'pipe', 'pipe']` で spawn しているため stdout / stderr は必ず non-null。
    // ここで明示 assert することで、将来 stdio の指定を間違えて 'ignore' に変えた等の
    // 設定ミスが silent に「空ファイル生成成功」になるのを防ぐ (旧実装の `?.` は誤動作を隠した)。
    if (!proc.stdout || !proc.stderr) {
      cleanupPartialOutput();
      return settle(() => reject(new Error('cook spawn: proc.stdout/stderr unexpectedly null (stdio misconfigured)')));
    }

    let stderr = '';
    proc.stdout.pipe(outStream);
    proc.stderr.on('data', (chunk: Buffer | string) => {
      // 末尾を残す形で 64KB cap (cook が 10 分以上 stderr 出力した場合の OOM 防止)
      const piece = chunk.toString();
      if (stderr.length + piece.length > STDERR_MAX_BYTES) {
        stderr = (stderr + piece).slice(-STDERR_MAX_BYTES);
      } else {
        stderr += piece;
      }
    });

    const killTimer = setTimeout(() => {
      proc.kill('SIGKILL');
      cleanupPartialOutput();
      settle(() =>
        reject(new Error(`cook timeout after ${COOK_TIMEOUT_MS}ms: ${stderr.slice(-STDERR_TAIL_FOR_ERROR)}`))
      );
    }, COOK_TIMEOUT_MS);

    proc.on('error', (err) => {
      clearTimeout(killTimer);
      // FIX: spawn 失敗時に出力 stream を閉じ、部分書き込みファイルを削除する。
      cleanupPartialOutput();
      settle(() => reject(new Error(`cook spawn failed: ${err.message}`)));
    });

    proc.on('close', (code) => {
      clearTimeout(killTimer);
      outStream.end(() => {
        if (code !== 0) {
          // exit 0 でなくても /tmp 残骸を残さないようファイル削除
          try { fs.unlinkSync(outputPath); } catch {}
          return settle(() =>
            reject(new Error(`cook exited ${code}: ${stderr.slice(-STDERR_TAIL_FOR_ERROR)}`))
          );
        }

        let stats: fs.Stats;
        try {
          stats = fs.statSync(outputPath);
        } catch (e: any) {
          return settle(() => reject(new Error(`cook output stat failed: ${e.message}`)));
        }

        if (stats.size === 0) {
          try { fs.unlinkSync(outputPath); } catch {}
          return settle(() =>
            reject(new Error(`cook produced empty output: ${stderr.slice(-STDERR_TAIL_FOR_ERROR)}`))
          );
        }

        // Ogg magic byte (OggS = 4F 67 67 53) を検証する。
        // 目的は 2 つ:
        //   1. 空録音時に cook.sh が flac の usage を stdout に流す等の garbage を弾く
        //   2. cook が無音圧縮の結果 0-byte 同然の出力を返した場合に検知
        // 注意: COOK_FORMAT は oggflac / opus / vorbis 等の Ogg コンテナ系のみを許容する
        //       前提。COOK_FORMAT=flac (裸 FLAC) は magic が fLaC なので reject される。
        // TODO: 将来 COOK_FORMAT=mp3 等の非 Ogg 形式に拡張する場合は format → magic 対応表
        //       (e.g. { oggflac: ['OggS'], flac: ['fLaC'], mp3: ['ID3', '\\xff\\xfb'] }) を導入する。
        //       現状は H-α 対応で `audio/ogg` 固定運用が docs に明記済のため未着手。
        let fd: number | null = null;
        try {
          const buf = Buffer.alloc(4);
          // FIX: readSync が throw した場合に closeSync を確実に呼ぶ。
          // 旧実装は openSync の後に readSync が throw すると closeSync に到達せず FD leak していた。
          fd = fs.openSync(outputPath, 'r');
          fs.readSync(fd, buf, 0, 4, 0);
          const magic = buf.toString('ascii');
          if (magic !== 'OggS') {
            try { fs.unlinkSync(outputPath); } catch {}
            return settle(() =>
              reject(
                new Error(
                  `cook output is not a valid Ogg file (magic="${magic.replace(/[^\x20-\x7e]/g, '?')}", size=${stats.size}): ${stderr.slice(-STDERR_TAIL_FOR_ERROR)}`
                )
              )
            );
          }
        } catch (e: any) {
          return settle(() => reject(new Error(`cook output magic check failed: ${e.message}`)));
        } finally {
          if (fd !== null) {
            try { fs.closeSync(fd); } catch {}
          }
        }

        settle(() => resolve({ outputPath, size: stats.size }));
      });
    });
  });
}

/**
 * /stop の同期処理から切り出した「cook 実行 → webhook 送信 → artifact cleanup」フロー。
 *
 * - cook 実行は concurrent 制限 (MAX_CONCURRENT_COOKS) で待機させる
 * - cook が成功でも失敗でも webhook は送る (cookError があれば bot 側で
 *   status="cook_failed" として記録する想定)
 * - webhook が成功した場合のみ raw fragments + .cook.ogg を削除する
 *   (失敗時は手動 recovery 用に残す)
 *
 * 例外は全て catch + log し、呼び出し側 (/stop) では fire-and-forget で使う。
 */
async function processCookAndWebhook(
  recording: Recording,
  sessionId: string,
  webhookUrl: string,
  webhookSecret: string,
  recorder: RecorderModule<any>
): Promise<void> {
  // in-flight cook の可視化 (M-craig-1):
  // - 並列 cook 数を log で見える化することで semaphore 飽和や cook stall を運用で検知しやすくする
  // - shutdown 戦略は別途 (TODO): SIGTERM 受信時に残存 promise を `Promise.allSettled` で待つ
  //   グレースフルストップは現状未実装。production 投入前に必要なら追加する
  const waitStart = Date.now();
  recorder.logger.info(
    `Cook slot wait: active=${activeCooks}/${MAX_CONCURRENT_COOKS}, queue=${cookWaitQueue.length}, sessionId=${sessionId}`
  );
  await acquireCookSlot();
  const waitedMs = Date.now() - waitStart;
  recorder.logger.info(
    `Cook slot acquired: active=${activeCooks}/${MAX_CONCURRENT_COOKS}, waited=${waitedMs}ms, sessionId=${sessionId}`
  );

  let cookFileSize = 0;
  let cookError: string | undefined;

  try {
    recorder.logger.info(
      `Cook starting for recording ${recording.id} (format=${COOK_FORMAT}, container=${COOK_CONTAINER})`
    );
    const t0 = Date.now();
    const cookResult = await runCook(recording.id, recorder);
    cookFileSize = cookResult.size;
    recorder.logger.info(
      `Cook complete for ${recording.id}: ${cookFileSize} bytes in ${Date.now() - t0}ms`
    );
  } catch (err: any) {
    cookError = err?.message || String(err);
    recorder.logger.error(`Cook failed for ${recording.id}: ${cookError}`);
  } finally {
    releaseCookSlot();
  }

  // bot 側 response の status を見て cleanup 判断する。
  //   - 'ok'            : bot 側 upload 完了 → cleanup OK
  //   - 'upload_failed' : bot 側で fetch / Firebase upload 失敗 → .cook.ogg を保持
  //                        (bot 側 retry queue / 手動 recovery の元データとして残す)
  //   - 'cook_failed'   : 呼び出し側は cookError != null なので下の `!cookError` でも弾かれる
  //   - undefined       : webhook URL 未設定 / 例外で response 取得失敗 → 保守的に保持
  let webhookResponseStatus: string | undefined;
  if (webhookUrl) {
    try {
      const response = await sendWebhook(webhookUrl, webhookSecret, {
        sessionId,
        recordingId: recording.id,
        endedAt: new Date().toISOString(),
        durationMs: recording.startedAt ? Date.now() - recording.startedAt.getTime() : 0,
        fileSize: cookFileSize,
        cookError
      });
      webhookResponseStatus = response?.status;
    } catch (err: any) {
      // sendWebhook 内部で 3 回 retry してから throw する仕様。
      recorder.logger.error(
        `Webhook failed for session ${sessionId} (after retries): ${err?.message || err}`
      );
    }
  } else {
    // webhook 未設定 (dev 環境想定) は upload 経路無いので artifact を残しておく
    recorder.logger.warn?.(`No webhook URL configured; skipping notify for ${sessionId}`);
  }

  // artifact cleanup の発動条件:
  //   - bot 側 response が status='ok' (= fetch + Firebase upload 完了確認済)
  //   - かつ cook 自体も成功 (!cookError)
  //
  // 上記以外は raw fragments + .cook.ogg を保持し recovery 余地を残す:
  //   - cook 失敗 → 手動再 cook の余地
  //   - bot 側 upload_failed → bot 側 retry queue / 手動再 fetch の余地
  //   - webhook network 不達 → bot 側回復後の再送余地
  //
  // 注意: bot 側 webhook handler は fetch → upload → Firestore 書き込みを同期 await した
  // 後に 200 を返す設計なので、cleanup が bot fetch より先行する race は構造的に発生しない。
  if (webhookResponseStatus === 'ok' && !cookError) {
    cleanupRecordingArtifacts(recorder.recordingPath, recording.id, recorder.logger);
  }
}

export async function startInternalApi(recorder: RecorderModule<any>, config: any) {
  server = fastify({ logger: false });

  const secret = process.env[config.secretEnv] || '';
  if (!secret) {
    recorder.logger.error('Internal API secret is not set. Refusing to start.');
    return;
  }
  const webhookUrl = process.env[config.webhookUrlEnv] || '';

  server.get('/internal/health', async () => {
    return { status: 'ok' };
  });

  server.register(async (instance) => {
    instance.addHook('preHandler', async (request, reply) => {
      await checkInternalSecret(request, reply, secret);
    });

    instance.post<{
      Body: {
        sessionId: string;
        guildId: string;
        channelId: string;
        initiatorUserId: string;
      };
    }>('/internal/record/start', async (request, reply) => {
      const { sessionId, guildId, channelId, initiatorUserId } = request.body;

      if (!sessionId || !guildId || !channelId || !initiatorUserId) {
        return reply.status(400).send({ error: 'Missing required fields' });
      }

      if (recorder.recordings.has(guildId)) {
        return reply.status(409).send({ error: 'Recording already exists for this guild' });
      }

      const guild = recorder.client.bot.guilds.get(guildId);
      if (!guild) return reply.status(404).send({ error: 'Guild not found' });

      const channel = guild.channels.get(channelId) as any;
      if (!channel || ![2, 13].includes(channel.type)) {
        return reply.status(400).send({ error: 'Invalid channel type' });
      }

      const user = await recorder.client.bot.getRESTUser(initiatorUserId);
      if (!user) return reply.status(404).send({ error: 'User not found' });

      const recording = new Recording(recorder as any, channel, user, true);
      recorder.recordings.set(guildId, recording);
      sessionToRecording.set(sessionId, recording.id);

      try {
        await recording.start(DEFAULT_REWARDS, false);
        return {
          recordingId: recording.id,
          sessionId,
          startedAt: new Date().toISOString()
        };
      } catch (error) {
        recorder.recordings.delete(guildId);
        sessionToRecording.delete(sessionId);
        throw error;
      }
    });

    instance.post<{ Body: { sessionId: string } }>('/internal/record/stop', async (request, reply) => {
      const { sessionId } = request.body;
      if (!sessionId) return reply.status(400).send({ error: 'Missing sessionId' });

      const recordingId = sessionToRecording.get(sessionId);
      if (!recordingId) return reply.status(404).send({ error: 'Session not found' });

      const recording = Array.from(recorder.recordings.values()).find((r) => r.id === recordingId);
      if (!recording) return reply.status(404).send({ error: 'Recording not found' });

      await recording.stop(true, 'n-us-internal');
      sessionToRecording.delete(sessionId);

      // Cook + webhook + cleanup はバックグラウンドで実行し、/stop は即時 return する。
      // 旧実装は cook (最大 10 分) を await していたため fastify connection 占有 + bot 側
      // タイムアウト連鎖のリスクがあった。結果は webhook 経由で bot に伝わる
      // (cookError があれば session.recording.status="cook_failed"、無ければ upload 続行)。
      //
      // fire-and-forget だが processCookAndWebhook 内で全 error を catch + log するため
      // unhandledRejection で bot プロセス全体が落ちることはない。
      processCookAndWebhook(recording, sessionId, webhookUrl, secret, recorder).catch((err) => {
        recorder.logger.error(
          `Unexpected unhandled error in processCookAndWebhook for ${sessionId}: ${err?.message || err}`
        );
      });

      return {
        recordingId: recording.id,
        sessionId,
        endedAt: new Date().toISOString()
        // cook 結果は webhook で送られるため /stop response には含めない。
      };
    });

    instance.get<{ Params: { recordingId: string }; Querystring: { download?: string } }>(
      '/internal/record/:recordingId/file',
      async (request, reply) => {
        const { recordingId } = request.params;

        // 外部から URL 経由で渡る値なので path traversal / 空文字を validate する。
        // `path.join(recorder.recordingPath, '../foo.cook.ogg')` は親ディレクトリ参照に化けるリスク。
        try {
          assertValidRecordingId(recordingId);
        } catch {
          return reply.status(400).send({ error: 'Invalid recordingId format' });
        }

        // cooked が優先、なければ legacy raw を fallback (PR #211 以前の .ogg 単一形式との互換)
        const cookedPath = path.join(recorder.recordingPath, `${recordingId}.cook.ogg`);
        const rawPath = path.join(recorder.recordingPath, `${recordingId}.ogg`);
        const servePath = fs.existsSync(cookedPath)
          ? cookedPath
          : fs.existsSync(rawPath)
            ? rawPath
            : null;

        if (!servePath) {
          return reply.status(404).send({ error: 'File not found' });
        }

        if (request.query.download === '1') {
          reply.header('Content-Disposition', `attachment; filename="${recordingId}.ogg"`);
        }

        const stream = fs.createReadStream(servePath);
        // MIME は audio/ogg を使う (RFC 5334)。一部 player は application/ogg だと
        // video コンテンツと誤判定して再生失敗するため、Ogg コンテナの音声は
        // 明示的に audio/ogg を返す。cook の出力は oggflac / opus / vorbis 等の
        // Ogg コンテナ系のみを許容するため (magic 検証で OggS 固定)、固定値で問題ない。
        return reply.type('audio/ogg').send(stream);
      }
    );
  });

  try {
    await server.listen({ port: config.port, host: config.host });
    recorder.logger.info(`Internal API listening on ${config.host}:${config.port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

export async function stopInternalApi() {
  if (server) {
    await server.close();
    server = null;
  }
}
