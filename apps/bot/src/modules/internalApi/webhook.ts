import axios from 'axios';
import * as Sentry from '@sentry/node';

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
) {
  let attempts = 0;
  const maxAttempts = 3;
  const timeout = 10000;

  while (attempts < maxAttempts) {
    try {
      await axios.post(url, data, {
        headers: {
          'X-Internal-Secret': secret
        },
        timeout
      });
      return;
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
