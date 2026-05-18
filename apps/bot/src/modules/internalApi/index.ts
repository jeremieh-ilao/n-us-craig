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

const COOK_SCRIPT_PATH = '/app/cook.sh';
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
  logger: { info: (msg: string) => void; warn?: (msg: string) => void }
): void {
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

    const proc = spawn(COOK_SCRIPT_PATH, [recordingId, COOK_FORMAT, COOK_CONTAINER], {
      cwd: '/app',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
      }
    });

    let stderr = '';
    proc.stdout?.pipe(outStream);
    proc.stderr?.on('data', (chunk: Buffer | string) => {
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
      settle(() => reject(new Error(`cook timeout after ${COOK_TIMEOUT_MS}ms: ${stderr.slice(-200)}`)));
    }, COOK_TIMEOUT_MS);

    proc.on('error', (err) => {
      clearTimeout(killTimer);
      // FIX: spawn 失敗時に出力 stream を閉じ、部分書き込みファイルを削除する。
      cleanupPartialOutput();
      settle(() => reject(new Error(`cook spawn failed: ${err.message}`)));
    });

    outStream.on('error', (err) => {
      clearTimeout(killTimer);
      proc.kill('SIGKILL');
      // FIX: 出力 stream エラー時にも部分書き込みファイルを削除する。
      try { fs.unlinkSync(outputPath); } catch {}
      settle(() => reject(new Error(`cook output stream failed: ${err.message}`)));
    });

    proc.on('close', (code) => {
      clearTimeout(killTimer);
      outStream.end(() => {
        if (code !== 0) {
          // exit 0 でなくても /tmp 残骸を残さないようファイル削除
          try { fs.unlinkSync(outputPath); } catch {}
          return settle(() => reject(new Error(`cook exited ${code}: ${stderr.slice(-500)}`)));
        }

        let stats: fs.Stats;
        try {
          stats = fs.statSync(outputPath);
        } catch (e: any) {
          return settle(() => reject(new Error(`cook output stat failed: ${e.message}`)));
        }

        if (stats.size === 0) {
          try { fs.unlinkSync(outputPath); } catch {}
          return settle(() => reject(new Error(`cook produced empty output: ${stderr.slice(-200)}`)));
        }

        // Ogg magic byte (OggS = 4F 67 67 53) を検証する。
        // 目的は 2 つ:
        //   1. 空録音時に cook.sh が flac の usage を stdout に流す等の garbage を弾く
        //   2. cook が無音圧縮の結果 0-byte 同然の出力を返した場合に検知
        // 注意: COOK_FORMAT は oggflac / opus / vorbis 等の Ogg コンテナ系のみを許容する
        //       前提。COOK_FORMAT=flac (裸 FLAC) は magic が fLaC なので reject される。
        //       reviewer 指摘の通り、format ごとに magic を分岐する設計も将来検討。
        try {
          const buf = Buffer.alloc(4);
          const fd = fs.openSync(outputPath, 'r');
          fs.readSync(fd, buf, 0, 4, 0);
          fs.closeSync(fd);
          const magic = buf.toString('ascii');
          if (magic !== 'OggS') {
            try { fs.unlinkSync(outputPath); } catch {}
            return settle(() =>
              reject(
                new Error(
                  `cook output is not a valid Ogg file (magic="${magic.replace(/[^\x20-\x7e]/g, '?')}", size=${stats.size}): ${stderr.slice(-200)}`
                )
              )
            );
          }
        } catch (e: any) {
          return settle(() => reject(new Error(`cook output magic check failed: ${e.message}`)));
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
  await acquireCookSlot();

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
        const cookedPath = path.join(recorder.recordingPath, `${recordingId}.cook.ogg`);
        const rawPath = path.join(recorder.recordingPath, `${recordingId}.ogg`);

        // cooked が優先、なければ legacy raw を fallback
        let servePath: string | null = null;
        if (fs.existsSync(cookedPath)) {
          servePath = cookedPath;
        } else if (fs.existsSync(rawPath)) {
          servePath = rawPath;
        }

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
