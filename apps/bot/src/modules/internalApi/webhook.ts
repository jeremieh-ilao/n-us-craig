import axios from 'axios';
import * as Sentry from '@sentry/node';

/**
 * bot 側 /internal/webhook/recording-ready の response body 型。
 *
 * - `"ok"`: fetch + Firebase upload + Firestore 書き込み全て成功。
 *   craig 側は raw fragments + .cook.ogg を cleanup してよい。
 * - `"cook_failed"`: cookError を受けて bot 側で upload を skip した
 *   (cook 失敗時に bot に伝わってきた状態。bot 側は session を cook_failed と記録)。
 *   呼び出し側は cookError 有無で既に分岐しているため、cleanup 判断には影響しない。
 * - `"upload_failed"`: bot 側で fetch / Firebase upload が失敗。
 *   .cook.ogg は **craig 側で保持** し、bot 側 retry queue or 手動 recovery で再 upload する設計。
 *   この値が返ったときは cleanup を発火させてはならない。
 */
export interface RecordingReadyResponse {
  status: 'ok' | 'cook_failed' | 'upload_failed';
  // upload_failed 時の補助情報 (任意)
  error?: string;
}

export async function sendWebhook(
  url: string,
  secret: string,
  data: {
    sessionId: string;
    recordingId: string;
    endedAt: string;
    durationMs: number;
    fileSize: number;
    // cook 後処理が失敗した場合のエラーメッセージ (任意)。
    // bot 側 webhook handler はこれが set されていたら upload を skip し
    // session を "cook_failed" 状態として記録する想定。
    cookError?: string;
  }
): Promise<RecordingReadyResponse | undefined> {
  let attempts = 0;
  const maxAttempts = 3;
  // n-us-bot 側の webhook handler は fetchRecordingFile + Firebase Storage upload を
  // 同期的に await する。録音時間が長く .cook.ogg が大きいと upload に数十秒かかる
  // ケースがあり、旧 timeout=10s では bot 応答前に craig 側で retry が走って
  // 二重 status update を起こすリスクがあった。60s に拡張する。
  const timeout = 60000;

  while (attempts < maxAttempts) {
    try {
      const response = await axios.post<RecordingReadyResponse>(url, data, {
        headers: {
          'X-Internal-Secret': secret
        },
        timeout
      });
      // bot 側からの status を呼び出し元に返す。呼び出し元 (processCookAndWebhook) は
      // status === 'ok' でのみ raw fragments + .cook.ogg cleanup を発火させる。
      // upload_failed のときは .cook.ogg を保持し recovery 余地を残す。
      return response.data;
    } catch (error) {
      attempts++;
      if (attempts >= maxAttempts) {
        Sentry.captureException(error, {
          extra: {
            sessionId: data.sessionId,
            recordingId: data.recordingId,
            webhookUrl: url
          }
        });
        throw error;
      }
      // Exponential backoff
      await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempts) * 1000));
    }
  }
}
