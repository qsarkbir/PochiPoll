import { $, el, participantUrl, canShareParticipantUrl, isRecord, request, RequestError } from './common.js';
import type { PollConnection } from './common.js';
import { participantQr } from './qr.js';
import type { AdminState, PreflightStatus } from '../types.js';

const checks = ['server', 'admin', 'origin', 'join', 'qr', 'present'] as const;
type Check = typeof checks[number];
const labels = { pending: '未確認', checking: '確認中', ok: 'OK', error: 'エラー', skipped: '対象外' };
const originHelp = 'BASE_URL が現在の公開URLと一致し、プロキシが公開オリジンの Host を転送しているか確認してください。';

function report(check: Check, status: keyof typeof labels, detail?: string) {
  const marker = el('span', { text: labels[status], cls: 'preflight-status ' + status });
  $('preflight-' + check).replaceChildren(marker, ...(detail ? [el('span', { text: detail })] : []));
}

function reportRequestFailure(error: unknown) {
  if (error instanceof RequestError && error.status < 500) {
    report('server', 'ok', 'HTTP 応答がありました。');
    if (error.status === 421) report('origin', 'error', originHelp);
    else if (error.status === 401 || error.status === 403) {
      report('admin', 'error', '正しい運営用URLを開き直してください。');
    } else {
      report('admin', 'error', '本番前チェックの応答を確認できませんでした（HTTP ' + error.status + '）。');
    }
  } else {
    report('server', 'error', 'アプリに接続できません。サーバーの起動状態と、公開時はトンネルの接続を確認してください。');
  }
}

function checkParticipantUrl(status: PreflightStatus) {
  const local = status.transport === 'local';
  const published = status.transport === 'cloudflare' || status.transport === 'https-proxy';
  const originMatches = status.origin === location.origin
    && (local ? location.protocol === 'http:' : published && location.protocol === 'https:');
  if (!originMatches) {
    report('origin', 'error', originHelp);
    return;
  }
  if (published && !canShareParticipantUrl) {
    report('origin', 'error', 'BASE_URL に別端末からアクセスできる HTTPS の公開URLを指定してください。');
    return;
  }
  report('origin', 'ok', local ? 'ローカル設定が一致しています。' : 'HTTPS の公開オリジンが一致しています。');
  if (typeof status.participantCode !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(status.participantCode)) {
    report('join', 'error', '参加コードを確認できませんでした。');
    return;
  }
  const url = participantUrl(status.participantCode);
  report('join', 'ok', local ? 'この端末用の参加URLを生成できました。' : '参加URLを生成できました。');
  if (local) {
    report('qr', 'skipped', 'ローカル起動では共有用 QR コードを表示しません。');
    return;
  }
  try {
    participantQr(url);
    report('qr', 'ok', '発表画面と同じ方法で QR コードを生成できました。');
  } catch {
    report('qr', 'error', 'QR コードを生成できません。ページを再読み込みして再チェックしてください。');
  }
}

export function setupPreflight(key: string | null, getState: () => AdminState | undefined) {
  const dialog = $('preflight-dialog', HTMLDialogElement);
  const retry = $('preflight-retry', HTMLButtonElement);
  const warnings = $('preflight-warnings');
  let warningText = '';
  let connection: PollConnection | 'connecting' = 'connecting';
  let checkedSession: string | undefined;
  let checkVersion = 0;

  function update(nextConnection?: PollConnection) {
    if (nextConnection) connection = nextConnection;
    if (!dialog.open) return;
    const state = getState();
    if (state && checkedSession && checkedSession !== state.sessionId) {
      // 古いセッションで検証した URL や発表トークンを確認済みとして表示しない。
      checkedSession = undefined;
      checkVersion++;
      retry.disabled = false;
      report('join', 'pending', 'セッションが切り替わりました。再チェックしてください。');
      report('qr', 'pending');
      report('present', 'pending');
    }
    const items = [];
    if (connection === 'reconnecting') items.push('運営画面は再接続中です。通信の回復を確認してください。');
    if (connection === 'connecting') items.push('運営画面の状態を取得しています。');
    if (state && connection !== 'invalid') {
      const questions = [...state.questions, ...state.discussions];
      if (questions.length === 0) items.push('質問がありません。');
      const openCount = questions.filter(question => question.isOpen).length;
      if (openCount > 1) items.push(openCount + '問を受付中です。参加者に表示する質問を確認してください。');
      const selected = questions.find(question => question.questionId === state.presentation.questionId);
      if (!selected) items.push('発表する質問が選ばれていません。');
      else if (!selected.everOpened) items.push('発表対象の質問はまだ一度も開いていません。');
    }
    const nextWarnings = items.join('\n');
    if (nextWarnings !== warningText) {
      warningText = nextWarnings;
      warnings.replaceChildren(...items.map(text => el('li', { text })));
    }
    $('preflight-preparation').hidden = items.length === 0;
  }

  async function runCheck() {
    const version = ++checkVersion;
    const isCurrent = () => dialog.open && version === checkVersion;
    checkedSession = undefined;
    retry.disabled = true;
    for (const check of checks) report(check, 'pending');
    report('server', 'checking');
    report('admin', 'checking');
    let status: PreflightStatus;
    try {
      status = await request('/api/admin/preflight', key);
      if (!isRecord(status) || typeof status.sessionId !== 'string' || typeof status.presentationToken !== 'string') {
        throw new Error('本番前チェックの応答が不正です。');
      }
    } catch (error) {
      if (isCurrent()) {
        report('admin', 'pending');
        reportRequestFailure(error);
        retry.disabled = false;
      }
      return;
    }
    if (!isCurrent()) return;
    checkedSession = status.sessionId;
    report('server', 'ok', 'サーバーが応答しました。');
    report('admin', 'ok', '運営キーで認証できました。');
    checkParticipantUrl(status);
    report('present', 'checking');
    try {
      // 発表画面を開き続けているかは分からないため、発表用の資格情報で API の応答だけを検証する。
      const present = await request('/api/present/state', status.presentationToken);
      if (!isCurrent()) return;
      if (present.sessionId !== status.sessionId) {
        report('present', 'error', 'セッションが切り替わりました。再チェックしてください。');
      } else {
        report('present', 'ok', '発表画面用のデータを取得できました。');
      }
    } catch {
      if (isCurrent()) report('present', 'error', '発表用のデータを取得できません。通信状態を確認して再チェックしてください。');
    } finally {
      if (isCurrent()) retry.disabled = false;
    }
  }

  $('preflight').addEventListener('click', () => {
    dialog.showModal();
    update();
    void runCheck();
  });
  retry.addEventListener('click', () => void runCheck());
  $('preflight-close').addEventListener('click', () => dialog.close());
  return update;
}
