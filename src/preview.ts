import { randomBytes } from 'node:crypto';
import { createApp } from './server.js';

// 運用中のセッションとは別に、ローカルで操作を試せるようにする。
function startPreview() {
  if (process.env.BASE_URL || process.env.TRANSPORT && process.env.TRANSPORT !== 'local') {
    throw new Error('コメント試用はローカル専用です。BASE_URL と TRANSPORT の公開設定を解除してください。');
  }
  const rawPort = process.env.PREVIEW_PORT ?? '3001';
  const port = Number(rawPort);
  if (!/^\d{1,5}$/.test(rawPort) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PREVIEW_PORT は0〜65535の整数で指定してください。0は空きポートを自動選択します。');
  }
  const configured = process.env.ADMIN_KEY !== undefined;
  let adminKey: string | undefined = process.env.ADMIN_KEY ?? randomBytes(32).toString('base64url');
  delete process.env.ADMIN_KEY;
  const server = createApp({ adminKey, transport: 'local' });
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') return;
    console.log('PochiPoll コメント機能のローカル受入試用（外部公開しないでください）');
    console.log('運営画面 http://127.0.0.1:' + address.port + '/admin' + (configured ? '' : '#' + adminKey));
    console.log('確認手順: docs/discussion-acceptance.md / 終了: Ctrl+C（試用データは消去されます）');
    // 起動時の表示を終えたら平文のキーへの参照を手放す。設定済みキーは出力しない。
    adminKey = undefined;
  });
  server.on('error', () => {
    console.error('試用の待受を開始できません。PREVIEW_PORT の重複を確認してください。');
    process.exitCode = 1;
    adminKey = undefined;
  });
}

try {
  startPreview();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'ローカル試用を開始できませんでした。');
  process.exitCode = 1;
}
