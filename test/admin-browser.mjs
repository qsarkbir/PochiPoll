// 任意のローカル UI 検証。PLAYWRIGHT_MODULE に別途用意した playwright のパスを指定する。
// 管理キーは実行ごとに生成し、URL・本文・スクリーンショットをログへ出さない。
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createApp } from '../dist/server.js';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const key = randomBytes(32).toString('base64url');
const server = createApp({ adminKey: key, waitMs: 100 });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const api = async (path, data, token = key) => {
    const response = await fetch(origin + path, { method: data ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, Origin: origin, 'Content-Type': 'application/json' },
      body: data && JSON.stringify(data) });
    assert.equal(response.status, 200);
    return response.json();
  };
  await page.goto(origin + '/admin#' + key);
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.locator('#add').click();
  await page.locator('#question-text').fill('ブラウザ検証のお題');
  await page.locator('#question-type').selectOption('discussion');
  await page.getByRole('button', { name: '質問を保存', exact: true }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '受付を開始', exact: true }).click();
  await page.getByRole('button', { name: '受付を緊急停止', exact: true }).waitFor();
  let state = await api('/api/admin/state');
  const topic = state.discussions[0];
  const posted = await api('/api/public/comments', { sessionId: state.sessionId,
    questionId: topic.questionId, discussionRevision: topic.discussionRevision,
    voterToken: randomBytes(32).toString('base64url'), clientSubmissionId: 'browser-test',
    body: '<img src=x onerror=alert(1)>\n検証用コメント' }, state.participantCode);
  await page.getByRole('button', { name: '承認して公開', exact: true }).click();
  await page.getByRole('button', { name: '公開中 (1)', exact: true }).click();
  await page.locator('.discussion-body').waitFor();
  assert.equal(await page.locator('#admin-comments img').count(), 0);
  await page.getByRole('button', { name: '非公開', exact: true }).click();
  await page.getByRole('button', { name: '非公開 (1)', exact: true }).click();
  await page.getByRole('button', { name: '再公開', exact: true }).click();
  await page.getByRole('button', { name: '公開中 (1)', exact: true }).click();
  await page.getByRole('button', { name: '受付を緊急停止', exact: true }).click();
  await page.getByRole('button', { name: '受付を開始', exact: true }).waitFor();
  assert.equal((await api('/api/admin/state')).discussions[0].isOpen, false);
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '削除', exact: true }).click();
  assert.equal((await api('/api/admin/comments?questionId=' + topic.questionId)).comments.length, 1);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '削除', exact: true }).click();
  await page.getByRole('button', { name: '公開中 (0)', exact: true }).waitFor();
  assert.equal((await api('/api/admin/comments?questionId=' + topic.questionId)).comments.length, 0);
  assert.equal((await api('/api/public/comments?questionId=' + topic.questionId, undefined, state.participantCode)).comments.length, 0);
  await page.getByRole('button', { name: '編集', exact: true }).click();
  await page.locator('#moderation-mode').selectOption('instant');
  await page.locator('#post-limit').selectOption('1');
  await page.getByRole('button', { name: '質問を保存', exact: true }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await page.locator('#add').click();
  await page.locator('#question-text').fill('選択式の検証');
  await page.locator('#option-fields input').nth(0).fill('A');
  await page.locator('#option-fields input').nth(1).fill('B');
  await page.getByRole('button', { name: '質問を保存', exact: true }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await page.getByText('設定・管理', { exact: true }).click();
  await page.getByRole('button', { name: '↑ 上へ', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.question-row strong')?.textContent === '選択式の検証');
  const backup = await page.evaluate(() => JSON.parse(localStorage.getItem('fakeslido:deck')));
  assert.deepEqual(backup.questions.map(item => item.type), ['single', 'discussion']);
  assert.deepEqual(backup.questions[1].settings, { moderationMode: 'instant', maxPostsPerToken: 1 });
  assert.equal(JSON.stringify(backup).includes(posted.commentId), false);
  assert.equal(JSON.stringify(backup).includes('検証用コメント'), false);
  await page.reload();
  await page.locator('#workspace').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.question-row').count(), 2);
  assert.equal(backup.format, 'fakeslido-deck');
  const downloadFrom = async locator => {
    const started = page.waitForEvent('download');
    await locator.click();
    return started;
  };
  const sample = await page.request.get(origin + '/pochipoll-sample-deck.json');
  assert.equal(sample.ok(), true);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#import').setInputFiles({
    name: 'pochipoll-sample-deck.json', mimeType: 'application/json', buffer: await sample.body()
  });
  await page.waitForFunction(() => document.querySelectorAll('.question-row').length === 4);
  const notice = page.locator('.dismissible-notice');
  const dismissNotice = page.getByRole('button', { name: '通知を閉じる', exact: true });
  await notice.getByText('質問集を読み込みました。', { exact: true }).waitFor();
  const banner = await notice.boundingBox();
  const close = await dismissNotice.boundingBox();
  assert.ok(close.x > banner.x + banner.width / 2);
  assert.ok(close.y < banner.y + banner.height / 2);
  const toolbarTop = () => page.locator('.session-toolbar').evaluate(toolbar => toolbar.getBoundingClientRect().top + window.scrollY);
  const toolbarBefore = await toolbarTop();
  await dismissNotice.click();
  await notice.waitFor({ state: 'hidden' });
  assert.ok((await toolbarTop()) < toolbarBefore);

  const questions = await downloadFrom(page.locator('#deck-download'));
  assert.equal(questions.suggestedFilename(), 'pochipoll-deck.json');
  assert.deepEqual(JSON.parse(await readFile(await questions.path(), 'utf8')),
    await sample.json());

  for (const format of ['json', 'csv']) {
    const results = await downloadFrom(page.locator('#' + format + '-download'));
    assert.equal(results.suggestedFilename(), 'pochipoll-results.' + format);
    if (format === 'json') {
      assert.equal(JSON.parse(await readFile(await results.path(), 'utf8')).format, 'pochipoll-results');
    }
  }

  page.once('dialog', dialog => dialog.accept());
  await page.locator('#import').setInputFiles({
    name: 'fakeslido-deck.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup))
  });
  await page.waitForFunction(() => document.querySelectorAll('.question-row').length === 2);
  assert.equal((await api('/api/admin/state')).discussions[0].text, 'ブラウザ検証のお題');
  await notice.getByText('質問集を読み込みました。', { exact: true }).waitFor();
  await dismissNotice.press('Enter');
  await notice.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#copy-link').evaluate(control => document.activeElement === control), true);

  const choiceRow = page.locator('.question-row').filter({ hasText: '選択式の検証' });
  const topicRow = page.locator('.question-row').filter({ hasText: 'ブラウザ検証のお題' });
  const advance = page.getByRole('button', { name: '次へ', exact: true });
  const topicInPresentation = topicRow.getByText('発表中', { exact: true });
  const openForPresentation = page.getByRole('button', { name: '受付を開始して発表', exact: true });
  const closeReception = page.getByRole('button', { name: '受付を終了', exact: true });
  await choiceRow.click();
  await openForPresentation.click();
  await closeReception.waitFor();

  // ポーリングを待たせ、操作の応答を受け取る前に運営者が元の質問を選び直す。
  const pausedPoll = Promise.withResolvers();
  const resumePoll = Promise.withResolvers();
  await page.route('**/api/admin/state?revision=*', async route => {
    pausedPoll.resolve();
    await resumePoll.promise;
    await route.continue();
  });
  await pausedPoll.promise;
  await page.route('**/api/admin/control', async route => {
    const response = await route.fetch();
    await topicRow.click();
    await choiceRow.click();
    await route.fulfill({ response });
  }, { times: 1 });
  await advance.click();
  await topicInPresentation.waitFor();
  assert.equal(await choiceRow.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#detail h2').textContent(), '選択式の検証');
  resumePoll.resolve();

  await openForPresentation.click();
  await closeReception.waitFor();
  // ポーリングが進行を先に反映するように操作の応答を待たせる。
  await page.route('**/api/admin/control', async route => {
    const response = await route.fetch();
    await topicInPresentation.waitFor();
    await route.fulfill({ response });
  }, { times: 1 });
  await advance.click();
  await page.locator('#detail').getByRole('heading', { name: 'ブラウザ検証のお題', exact: true }).waitFor();
  await page.locator('#admin-comments').getByRole('button', { name: '承認待ち (0)', exact: true }).waitFor();
  assert.equal(await choiceRow.getAttribute('aria-pressed'), 'false');
  assert.equal(await topicRow.getAttribute('aria-pressed'), 'true');
  assert.equal(await advance.isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log('PASS: お題作成・審査・公開範囲の変更・削除・受付停止・設定編集・質問集の並べ替えと読込・書き出し・通知・進行中の手動選択・次のお題の選択');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
