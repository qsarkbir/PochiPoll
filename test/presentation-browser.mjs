// 任意の Chrome 統合検証。機密を含む URL と本文はログ・スクリーンショットへ保存しない。
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { createApp } from '../dist/server.js';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const adminKey = randomBytes(32).toString('base64url');
const server = createApp({ adminKey, discussionEnabled: true, waitMs: 100 });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let browser;
try {
  const api = async (path, data, token = adminKey, method = data ? 'POST' : 'GET') => {
    const response = await fetch(origin + path, { method,
      headers: { Authorization: 'Bearer ' + token, Origin: origin, 'Content-Type': 'application/json' },
      body: data && JSON.stringify(data) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const initial = await api('/api/admin/state');
  const state = await api('/api/admin/deck', { deckRevision: initial.deckRevision, questions: [
    { questionId: 'browser-topic', text: '次回のテーマを教えてください', type: 'discussion' },
    { questionId: 'browser-choice', text: '選択式の確認', type: 'single', options: ['A', 'B'], style: 'horizontal' }
  ] }, adminKey, 'PUT');
  await api('/api/admin/control', { action: 'open', questionId: 'browser-topic' });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const admin = await browser.newPage();
  const present = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const participant = await browser.newPage();
  const reader = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  for (const page of [admin, present, participant, reader]) page.on('pageerror', error => errors.push(error.message));
  await present.addInitScript(() => {
    window.animationDurations = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      window.animationDurations.push(options?.duration);
      return animate.call(this, frames, options);
    };
  });
  await admin.goto(origin + '/admin#' + adminKey);
  await present.goto(origin + '/present#' + state.presentationToken);
  await participant.goto(origin + '/#' + state.participantCode);
  for (const body of ['研究データの整理方法を知りたいです。', '<b>共同作業の進め方</b>を話したいです。'.repeat(10)]) {
    await participant.locator('#discussion-body').fill(body);
    await participant.getByRole('button', { name: '投稿する', exact: true }).click();
    await participant.waitForFunction(() => document.getElementById('discussion-body')?.value === '');
  }
  await admin.getByRole('button', { name: '承認待ち (2)', exact: true }).waitFor();
  assert.equal(await present.locator('.stage-comment').count(), 0);
  for (let i = 0; i < 2; i++) await admin.getByRole('button', { name: '承認して公開', exact: true }).first().click();
  await admin.getByRole('button', { name: '公開中 (2)', exact: true }).click();
  await present.waitForFunction(() => document.querySelectorAll('.stage-comment').length === 2);
  assert.equal(await present.locator('.stage-comment b').count(), 0);
  const comments = (await api('/api/admin/comments?questionId=browser-topic')).comments;
  const card = id => admin.locator('.discussion-comment').filter({ hasText: comments.find(c => c.commentId === id).body });
  const a = comments[0].commentId;
  const b = comments[1].commentId;
  await admin.getByText('設定・管理', { exact: true }).click();
  await admin.getByLabel('発表の並び順を固定', { exact: true }).check();
  await reader.goto(origin + '/#' + state.participantCode);
  const reaction = reader.locator('.discussion-comment').filter({ hasText: comments[1].body });
  await reaction.getByRole('button', { name: 'いいね', exact: true }).press('Enter');
  const liked = reaction.getByRole('button', { name: 'いいねを取り消す', exact: true });
  await liked.waitFor();
  assert.equal(await liked.getAttribute('aria-pressed'), 'true');
  assert.equal(await liked.evaluate(button => document.activeElement === button), true);
  await reader.locator('#discussion-body').fill('入力中の確認用コメント');
  await reader.locator('#discussion-body').focus();
  await present.waitForFunction(() => document.querySelector('.stage-comments')?.textContent.includes('1 いいね'));
  assert.deepEqual(await present.locator('.stage-comment').evaluateAll(nodes => nodes.map(n => n.dataset.commentId)), [a, b]);
  await admin.getByLabel('発表の並び順を固定', { exact: true }).uncheck();
  await present.waitForFunction(id => document.querySelector('.stage-comment')?.dataset.commentId === id, b);
  await card(a).getByRole('button', { name: '発表で拡大', exact: true }).click();
  await present.locator('.stage-comment-focus').waitFor();
  assert.equal(await present.locator('.stage-comment').count(), 1);
  const release = card(a).getByRole('button', { name: '拡大を解除', exact: true });
  assert.equal(await release.getAttribute('aria-pressed'), 'true');
  await release.click();
  await present.locator('.stage-comments').waitFor();
  assert.equal(await present.locator('.stage-comment').count(), 2);
  assert.equal(await card(a).getByRole('button', { name: '発表で拡大', exact: true }).getAttribute('aria-pressed'), 'false');
  await card(a).getByRole('button', { name: '発表で拡大', exact: true }).click();
  await present.locator('.stage-comment-focus').waitFor();
  await card(a).getByRole('button', { name: '非公開', exact: true }).click();
  await present.waitForFunction(id => !document.querySelector(`[data-comment-id="${id}"]`), a);
  await reader.locator('.discussion-comment').filter({ hasText: comments[0].body }).waitFor({ state: 'detached' });
  assert.equal(await reader.locator('#discussion-body').inputValue(), '入力中の確認用コメント');
  assert.equal(await reader.locator('#discussion-body').evaluate(field => document.activeElement === field), true);
  await admin.getByRole('button', { name: '非公開 (1)', exact: true }).click();
  await admin.getByRole('button', { name: '再公開', exact: true }).click();
  await admin.getByRole('button', { name: '公開中 (2)', exact: true }).click();
  await present.waitForFunction(() => document.querySelectorAll('.stage-comment').length === 2);
  await present.evaluate(() => { window.animationDurations = []; });
  await card(a).getByRole('button', { name: '紹介済みにする', exact: true }).click();
  await present.waitForFunction(id => !document.querySelector(`[data-comment-id="${id}"]`), a);
  assert.ok((await present.evaluate(() => window.animationDurations)).includes(250));
  assert.equal((await api('/api/public/comments?questionId=browser-topic', undefined, state.participantCode)).comments.length, 2);
  await admin.getByLabel('紹介済みを一覧から除く', { exact: true }).uncheck();
  await present.waitForFunction(() => document.querySelectorAll('.stage-comment').length === 2);
  await card(a).getByRole('button', { name: '紹介済みを解除', exact: true }).click();
  await admin.getByLabel('紹介済みを一覧から除く', { exact: true }).check();
  await present.emulateMedia({ reducedMotion: 'reduce' });
  await present.evaluate(() => { window.animationDurations = []; });
  await card(a).getByRole('button', { name: '紹介済みにする', exact: true }).click();
  await present.waitForFunction(id => !document.querySelector(`[data-comment-id="${id}"]`), a);
  assert.deepEqual(await present.evaluate(() => window.animationDurations), []);
  await card(a).getByRole('button', { name: '紹介済みを解除', exact: true }).click();
  await present.waitForFunction(() => document.querySelectorAll('.stage-comment').length === 2);
  // 取得が失敗したら本文を取り下げ、再接続後は最新の公開可否から描画する。
  await present.context().setOffline(true);
  await present.getByText('再接続しています', { exact: true }).waitFor();
  await card(a).getByRole('button', { name: '非公開', exact: true }).click();
  await present.context().setOffline(false);
  await present.locator('.stage-comment').waitFor();
  assert.deepEqual(await present.locator('.stage-comment').evaluateAll(nodes => nodes.map(n => n.dataset.commentId)), [b]);
  await card(b).getByRole('button', { name: '発表で拡大', exact: true }).click();
  await present.locator('.stage-comment-focus').waitFor();
  assert.equal(await present.locator('.stage-comment-focus .discussion-body').textContent(), comments[1].body);
  if (process.env.PRESENTATION_SCREENSHOT) await present.screenshot({ path: process.env.PRESENTATION_SCREENSHOT, fullPage: true });
  admin.once('dialog', dialog => dialog.accept());
  const downloadEvent = admin.waitForEvent('download');
  await admin.getByRole('button', { name: '公開コメント JSON', exact: true }).click();
  const download = await downloadEvent;
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const exported = JSON.parse(Buffer.concat(chunks));
  assert.equal(exported.format, 'pochipoll-comments');
  assert.deepEqual(exported.topics[0].comments.map(c => c.commentId), [b]);
  admin.once('dialog', dialog => dialog.accept());
  await card(b).getByRole('button', { name: '削除', exact: true }).click();
  await present.waitForFunction(() => document.querySelectorAll('.stage-comment').length === 0);
  assert.equal((await present.locator('#stage-main').textContent()).includes(comments[1].body), false);
  await admin.getByRole('button', { name: '次へ', exact: true }).click();
  await present.getByRole('heading', { name: '選択式の確認', exact: true }).waitFor();
  assert.equal(await present.locator('.stage-options li').count(), 2);
  assert.deepEqual(errors, []);
  console.log('PASS: 参加投稿→審査・いいね→一覧／注目→紹介済み／解除→順番固定→非公開／削除→JSON、250ms演出・動きの低減・通信復帰・選択式への進行');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
