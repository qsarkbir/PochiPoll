import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from '../dist/server.js';

const newKey = () => randomBytes(32).toString('base64url');
const first = { questionId: 'one', text: '好きな色は？', type: 'single', options: ['青', '緑'], style: 'horizontal' };
const second = { questionId: 'two', text: '好きな果物は？', type: 'multiple', options: ['梨', 'りんご', 'ぶどう'], style: 'vertical' };
const servers = new Set();

after(async () => {
  await Promise.all([...servers].map(server => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  })));
});

async function fixture(options = {}) {
  const key = newKey();
  const server = createApp({ adminKey: key, waitMs: 100, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.add(server);
  const origin = 'http://127.0.0.1:' + server.address().port;
  async function call(path, { token = key, method = 'GET', data, headers = {} } = {}) {
    const response = await new Promise((resolve, reject) => {
      const outgoing = request(origin + path, {
        method, headers: {
          ...(token && { Authorization: 'Bearer ' + token }),
          ...(data !== undefined && { 'Content-Type': 'application/json', Origin: origin }),
          ...headers
        }
      }, resolve);
      outgoing.on('error', reject);
      outgoing.end(data === undefined ? undefined : JSON.stringify(data));
    });
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const responseHeaders = new Headers(response.headers);
    return { status: response.statusCode, headers: responseHeaders, raw,
      body: responseHeaders.get('content-type')?.includes('application/json') ? JSON.parse(raw) : null };
  }
  const state = async () => (await call('/api/admin/state')).body;
  const deck = async (questions, config = {}) => call('/api/admin/deck', {
    method: 'PUT', data: { questions, deckRevision: (await state()).deckRevision, ...config }
  });
  const control = (action, questionId, confirm) => call('/api/admin/control', {
    method: 'POST', data: { action, questionId, confirm }
  });
  const erase = (sessionId, token = key) => call('/api/admin/control', {
    token, method: 'POST', data: { action: 'erase', confirm: true, sessionId }
  });
  const advance = ({ sessionId, deckRevision, presentation }, token = key) => call('/api/admin/control', {
    token, method: 'POST', data: { action: 'advance', sessionId, deckRevision, questionId: presentation.questionId }
  });
  const vote = (token, questionId, choices, voteRevision, voterToken = newKey()) => call('/api/public/vote', {
    token, method: 'POST', data: { questionId, voterToken, choices, voteRevision }
  });
  return { origin, key, state, deck, control, erase, advance, call, vote };
}

test('公開状態、受付状態、発表モードが独立し、未オープンの質問を返さない', async () => {
  const { call, deck, control, vote } = await fixture();
  const { body: created } = await deck([first, second]);
  const { participantCode: token, presentationToken } = created;
  const publicState = () => call('/api/public/state', { token });
  const result = () => call('/api/public/results?questionId=one', { token });
  const present = path => call('/api/present/state' + (path ?? ''), { token: presentationToken });
  assert.deepEqual((await publicState()).body.questions, []);
  assert.equal((await control('publish', 'one')).status, 400);
  await control('select', 'one');
  assert.equal((await present()).body.question, null);
  await control('open', 'one');
  const opened = (await publicState()).body;
  assert.deepEqual(opened.questions.map(q => q.questionId), ['one']);
  assert.equal((await call('/api/public/state?revision=' + opened.revision, { token })).status, 204);
  assert.equal((await result()).status, 404);

  const voter = newKey();
  const revision = opened.questions[0].voteRevision;
  assert.equal((await vote(token, 'one', [1], revision, voter)).status, 400);
  assert.equal((await vote(token, 'one', 1, revision, voter)).status, 200);
  assert.equal((await vote(token, 'one', 2, revision, voter)).status, 200);
  assert.deepEqual((await publicState()).body, opened);
  assert.equal((await present()).body.question.respondentCount, 1);
  assert.equal(Object.hasOwn((await present()).body.question, 'results'), false);

  const starting = await present();
  const pending = present('?revision=' + starting.body.revision);
  await control('show-results');
  assert.equal((await pending).body.mode, 'results');
  assert.equal((await result()).body.options[1].optionVotes, 1);
  assert.equal((await vote(token, 'one', 1, revision, voter)).status, 200);
  assert.equal((await result()).body.options[0].optionVotes, 1);

  await control('close', 'one');
  assert.equal((await vote(token, 'one', 2, revision, voter)).status, 409);
  await control('show-question');
  assert.equal((await result()).status, 200);
  assert.equal(Object.hasOwn((await present()).body.question, 'results'), false);
  await control('show-results');
  await control('unpublish', 'one');
  assert.equal((await present()).body.mode, 'question');
  assert.equal((await result()).status, 404);
});

test('受付開始で発表画面が、受付を開始した質問の表示に切り替わる', async () => {
  const { call, deck, control } = await fixture();
  const { body: { presentationToken: token } } = await deck([first, second]);
  const present = revision => call('/api/present/state' + (revision === undefined ? '' : '?revision=' + revision), { token });
  const { body: waiting } = await present();
  assert.equal(waiting.question, null);

  const pending = present(waiting.revision);
  await control('open', first.questionId);
  const { body: opened } = await pending;
  assert.equal(opened.question.questionId, first.questionId);
  assert.equal(opened.question.isOpen, true);
  assert.equal(opened.mode, 'question');
  assert.equal(opened.question.resultsPublished, false);

  await control('show-results');
  const switching = await control('open', second.questionId);
  assert.ok(switching.body.questions.every(question => question.isOpen));
  assert.equal(switching.body.questions[0].resultsPublished, true);
  const { body: switched } = await present();
  assert.equal(switched.question.questionId, second.questionId);
  assert.equal(switched.mode, 'question');
  assert.equal(switched.question.resultsPublished, false);
  assert.equal(Object.hasOwn(switched.question, 'results'), false);
});

test('次の質問への進行は一度だけ実行し、公開済み結果とほかの受付を維持する', async () => {
  const { call, deck, control, vote, advance, state } = await fixture();
  const third = { ...first, questionId: 'three' };
  const fourth = { ...first, questionId: 'four' };
  const { body: created } = await deck([first, second, third, fourth]);
  const { participantCode: token, presentationToken } = created;
  const present = (revision = '') => call('/api/present/state' + revision, { token: presentationToken });
  const publicState = () => call('/api/public/state', { token });
  await control('open', 'three');
  await control('open', 'one');
  assert.equal((await vote(token, 'one', 1, created.questions[0].voteRevision)).status, 200);
  const { body: before } = await control('show-results');
  assert.deepEqual((await publicState()).body.questions.map(question => question.questionId), ['one', 'three']);
  assert.equal((await advance(before, token)).status, 401);
  assert.equal((await advance({ ...before, sessionId: 'old-session' })).status, 409);
  assert.equal((await advance({ ...before, deckRevision: undefined })).status, 400);
  const { body: stageBefore } = await present();
  const waiting = present('?revision=' + stageBefore.revision);
  const attempts = await Promise.all([advance(before), advance(before)]);
  assert.deepEqual(attempts.map(result => result.status).sort(), [200, 409]);
  const { body: advanced } = attempts.find(result => result.status === 200);
  assert.equal(advanced.revision, before.revision + 1);
  assert.equal(advanced.deckRevision, before.deckRevision);
  assert.deepEqual(advanced.presentation, { questionId: 'two', mode: 'question' });
  assert.deepEqual(advanced.questions.map(q => [q.isOpen, q.everOpened, q.resultsPublished]),
    [[false, true, true], [true, true, false], [true, true, false], [false, false, false]]);
  const { body: displayed } = await waiting;
  assert.equal(displayed.revision, stageBefore.revision + 1);
  assert.equal(displayed.mode, 'question');
  assert.equal(displayed.question.questionId, 'two');
  assert.equal(displayed.question.isOpen, true);
  assert.deepEqual((await publicState()).body.questions.map(question => question.questionId), ['one', 'two', 'three']);
  assert.equal((await call('/api/public/results?questionId=one', { token })).body.respondentCount, 1);
  assert.equal((await vote(token, 'one', 2, created.questions[0].voteRevision)).status, 409);

  const { body: last } = await control('open', 'four');
  assert.equal((await advance(last)).status, 409);
  const after = await state();
  assert.deepEqual(after, { ...last, serverTime: after.serverTime });
});

test('並べ替え前の状態では進行できず、更新後の順番で次の質問を開く', async () => {
  const { deck, control, advance, state } = await fixture();
  const third = { ...first, questionId: 'three' };
  await deck([first, second, third]);
  const { body: before } = await control('open', 'one');
  const { body: reordered } = await deck([first, third, second]);
  const rejected = await advance(before);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, 'deck_changed');
  const after = await state();
  assert.deepEqual(after, { ...reordered, serverTime: after.serverTime });
  const { status, body: advanced } = await advance(reordered);
  assert.equal(status, 200);
  assert.equal(advanced.presentation.questionId, 'three');
  assert.deepEqual(advanced.questions.map(question => question.everOpened), [true, true, false]);
});

test('複数選択を集計し、CSVとJSONに集計値だけを書き出す', async () => {
  const { call, deck, control, vote } = await fixture();
  const { body: created } = await deck([{ ...first, text: '=SUM(1,2)' }, {
    ...second, options: ['梨', '  +りんご', 'ぶどう"']
  }]);
  const { participantCode: token } = created;
  await control('open', 'two');
  const revision = created.questions[1].voteRevision;
  const voter = newKey();
  assert.equal((await vote(token, 'two', [1, 1], revision)).status, 400);
  assert.equal((await vote(token, 'two', [1, 4], revision)).status, 400);
  assert.equal((await vote(token, 'two', [], revision)).status, 400);
  assert.equal((await vote(token, 'two', [2, 1], revision, voter)).status, 200);
  assert.equal((await vote(token, 'two', [1, 2], revision, voter)).status, 200);
  assert.equal((await vote(token, 'two', [1, 3], revision)).status, 200);

  const { body: data, raw, headers } = await call('/api/admin/export?format=json');
  assert.equal(headers.get('content-disposition'), 'attachment; filename="pochipoll-results.json"');
  assert.equal(data.format, 'pochipoll-results');
  assert.equal(data.version, 1);
  assert.equal(data.sessionId, created.sessionId);
  assert.equal(data.questions[0].respondentCount, 0);
  assert.equal(data.questions[0].options[0].percentage, 0);
  assert.equal(data.questions[0].questionText, '=SUM(1,2)');
  assert.equal(data.questions[1].totalSelections, 4);
  assert.equal(data.questions[1].respondentCount, 2);
  assert.deepEqual(data.questions[1].options.map(o => o.percentage), [100, 50, 50]);
  assert.doesNotMatch(raw.toString(), /127\.0\.0\.1|voterToken|pseudonym|voteTime/);
  assert.ok(!raw.toString().includes(voter));

  const csv = await call('/api/admin/export?format=csv');
  assert.equal(csv.headers.get('content-disposition'), 'attachment; filename="pochipoll-results.csv"');
  assert.equal(csv.raw.subarray(0, 3).toString('hex'), 'efbbbf');
  assert.match(csv.raw.toString(), /"'=SUM\(1,2\)"/);
  assert.match(csv.raw.toString(), /"'  \+りんご"/);
  assert.match(csv.raw.toString(), /"ぶどう""",1,2,4,50\.0/);
});

test('編集、並べ替え、復元、リセットで票世代を正しく扱う', async () => {
  const { call, deck, state, control, vote } = await fixture();
  const { body: before } = await deck([first, second]);
  const gen = before.questions[0].voteRevision;
  const revised = { ...first, text: '新しい質問' };
  await control('open', 'one');
  await control('open', 'two');
  await vote(before.participantCode, 'one', 1, gen);
  const reordered = await deck([second, { ...first, style: 'donut' }]);
  assert.equal(reordered.body.questions[1].voteRevision, gen);
  assert.equal(reordered.body.questions[1].results.respondentCount, 1);
  assert.equal((await deck([first], { deckRevision: before.deckRevision })).body.code, 'deck_changed');
  assert.equal((await deck([second, revised])).body.code, 'confirm_reset');
  assert.equal((await state()).questions[1].text, first.text);
  const afterEdit = await deck([second, revised], { confirmReset: true });
  assert.ok(afterEdit.body.questions[1].voteRevision > gen);
  assert.equal(afterEdit.body.questions[1].results.respondentCount, 0);
  assert.equal((await vote(before.participantCode, 'one', 2, gen)).status, 409);
  assert.equal((await control('reset-votes', 'one')).status, 400);
  const reset = await control('reset-votes', 'one', true);
  assert.ok(reset.body.questions[1].voteRevision > afterEdit.body.questions[1].voteRevision);
  assert.equal(reset.body.questions[0].voteRevision, afterEdit.body.questions[0].voteRevision);
  const restored = await deck([revised, second], { replace: true });
  assert.ok(restored.body.questions.every(q => !q.everOpened && !q.isOpen && !q.resultsPublished));
  assert.deepEqual((await call('/api/public/state', { token: before.participantCode })).body.questions, []);
});

test('全消去で旧参加・発表キーを失効し、待機中の発表画面にも反映する', async () => {
  const { call, deck, control, erase } = await fixture();
  const { body: before } = await deck([first]);
  const token = before.presentationToken;
  const current = await call('/api/present/state', { token });
  const waiting = call('/api/present/state?revision=' + current.body.revision, { token });
  assert.equal((await control('erase')).status, 400);
  assert.equal((await erase()).status, 400);
  assert.equal((await erase(1)).status, 400);
  assert.equal((await erase(before.sessionId, before.participantCode)).status, 401);
  const { status, body: after } = await erase(before.sessionId);
  assert.equal(status, 200);
  assert.notEqual(after.sessionId, before.sessionId);
  assert.notEqual(after.participantCode, before.participantCode);
  assert.deepEqual(after.questions, []);
  assert.equal((await waiting).status, 410);
  assert.equal((await call('/api/public/state', { token: before.participantCode })).status, 410);
  assert.equal((await call('/api/admin/state')).status, 200);
});

test('以前のセッションの確認では現在のセッションを消去できない', async () => {
  const { call, control, deck, erase, state, vote } = await fixture();
  const before = await state();
  const attempts = await Promise.all([erase(before.sessionId), erase(before.sessionId)]);
  assert.deepEqual(attempts.map(result => result.status).sort(), [200, 409]);
  const { body: current } = await deck([second]);
  await control('open', 'two');
  assert.equal((await vote(current.participantCode, 'two', [1, 2], current.questions[0].voteRevision)).status, 200);

  const exportPath = '/api/admin/export?format=json&sessionId=';
  assert.equal((await call(exportPath + before.sessionId)).status, 409);
  assert.equal((await erase(before.sessionId)).status, 409);
  const exported = await call(exportPath + current.sessionId);
  assert.equal(exported.status, 200);
  assert.equal(exported.body.sessionId, current.sessionId);
  assert.equal(exported.body.questions[0].respondentCount, 1);
  assert.equal(exported.body.questions[0].totalSelections, 2);
  assert.equal((await state()).sessionId, current.sessionId);
});

test('状態取得や投票では期限が延びず、期限到来で票と参加・発表キーを消去する', async () => {
  const { call, control, deck, state, vote } = await fixture({ idleMs: 350 });
  await deck([first]);
  await control('open', 'one');
  const before = await state();
  await sleep(85);
  assert.equal((await vote(before.participantCode, 'one', 1, before.questions[0].voteRevision)).status, 200);
  assert.equal((await call('/api/admin/preflight')).status, 200);
  const afterVote = await state();
  assert.equal(afterVote.sessionId, before.sessionId);
  assert.equal(afterVote.expiresAt, before.expiresAt);
  assert.ok(afterVote.serverTime > before.serverTime);
  assert.equal(afterVote.questions[0].results.respondentCount, 1);
  await sleep(Math.max(0, before.expiresAt - Date.now()) + 30);
  const after = await state();
  assert.notEqual(after.sessionId, before.sessionId);
  assert.ok(after.expiresAt > before.expiresAt);
  assert.deepEqual(after.questions, []);
  assert.equal((await call('/api/public/state', { token: before.participantCode })).status, 410);
  assert.equal((await call('/api/present/state', { token: before.presentationToken })).status, 410);
});

test('管理キーと現在のセッションでのみ期限を延長し、運営画面に通知する', async () => {
  const idleMs = 60_000;
  const { call, deck, erase, state } = await fixture({ idleMs, waitMs: 1000 });
  const { body: before } = await deck([first]);
  const publicState = () => call('/api/public/state', { token: before.participantCode });
  const presentState = () => call('/api/present/state', { token: before.presentationToken });
  const publicBefore = (await publicState()).body;
  const presentBefore = (await presentState()).body;
  for (const data of [publicBefore, presentBefore]) {
    assert.equal(Object.hasOwn(data, 'expiresAt'), false);
    assert.equal(Object.hasOwn(data, 'serverTime'), false);
  }
  const extend = (sessionId, token) => call('/api/admin/control', {
    token, method: 'POST', data: { action: 'extend-expiry', sessionId }
  });
  assert.equal((await extend(before.sessionId, before.participantCode)).status, 401);
  assert.equal((await extend()).status, 400);
  const waiting = call('/api/admin/state?revision=' + before.revision);
  await sleep(15);
  const { status, body: extended } = await extend(before.sessionId);
  assert.equal(status, 200);
  assert.equal(extended.sessionId, before.sessionId);
  assert.ok(extended.expiresAt > before.expiresAt);
  assert.ok(extended.expiresAt > extended.serverTime && extended.expiresAt - extended.serverTime <= idleMs);
  assert.deepEqual(extended.questions, before.questions);
  const notified = await waiting;
  assert.equal(notified.status, 200);
  assert.equal(notified.body.expiresAt, extended.expiresAt);
  assert.deepEqual((await publicState()).body, publicBefore);
  assert.deepEqual((await presentState()).body, presentBefore);

  const { body: fresh } = await erase(before.sessionId);
  assert.equal((await extend(before.sessionId)).status, 409);
  assert.equal((await state()).expiresAt, fresh.expiresAt);
});

test('集計の書き出しで更新した期限を運営画面に通知する', async () => {
  const { call, state } = await fixture({ waitMs: 1000 });
  const before = await state();
  const waiting = call('/api/admin/state?revision=' + before.revision);
  await sleep(15);
  assert.equal((await call('/api/admin/export?format=json')).status, 200);
  const result = await waiting;
  assert.equal(result.status, 200);
  assert.ok(result.body.expiresAt > before.expiresAt);
  assert.equal(result.body.sessionId, before.sessionId);
});

test('本番前チェックは運営認証で現在の接続情報を取得する', async () => {
  const { origin, call, state } = await fixture();
  const before = await state();
  const path = '/api/admin/preflight';
  for (const token of [null, before.participantCode, before.presentationToken]) {
    assert.equal((await call(path, { token })).status, 401);
  }
  const result = await call(path);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(result.body, {
    origin, transport: 'local', sessionId: before.sessionId,
    participantCode: before.participantCode, presentationToken: before.presentationToken
  });
  assert.equal((await call(path + '?test=true')).status, 400);
  assert.equal((await call(path, { method: 'POST' })).status, 405);
  assert.equal((await call('/api/present/state', { token: result.body.presentationToken })).body.sessionId,
    before.sessionId);
  const after = await state();
  assert.deepEqual(after, { ...before, serverTime: after.serverTime });
});

test('新しいプロセス相当のサーバーには旧セッションの票と鍵を渡さない', async () => {
  const before = await fixture();
  const { body: created } = await before.deck([first]);
  await before.control('open', 'one');
  await before.vote(created.participantCode, 'one', 1, created.questions[0].voteRevision);
  const after = await fixture();
  assert.notEqual((await after.state()).sessionId, created.sessionId);
  assert.deepEqual((await after.state()).questions, []);
  assert.equal((await after.call('/api/admin/state', { token: before.key })).status, 401);
  assert.equal((await after.call('/api/public/state', { token: created.participantCode })).status, 410);
});

test('権限、オリジン、型、本文サイズとレートを制限する', async () => {
  const { call, deck, control, vote } = await fixture({ voteLimit: 2 });
  assert.equal((await deck([{ ...first, options: [''] }])).status, 400);
  assert.equal((await deck([{ ...second, style: 'donut' }])).status, 400);
  const { body: before } = await deck([first]);
  const token = before.participantCode;
  assert.equal((await call('/api/admin/state', { token })).status, 401);
  assert.equal((await call('/api/admin/export?format=json', { token })).status, 401);
  const data = { action: 'open', questionId: 'one' };
  assert.equal((await call('/api/admin/control', { method: 'POST', data, headers: { Origin: 'https://example.test' } })).status, 403);
  assert.equal((await call('/api/admin/control', { method: 'POST', data, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await call('/api/public/vote', {
    token, method: 'POST', data: 'a'.repeat(16 * 1024)
  })).status, 413);
  assert.equal((await call('/api/admin/deck', {
    method: 'PUT', data: 'a'.repeat(256 * 1024)
  })).status, 413);

  await control('open', 'one');
  const revision = before.questions[0].voteRevision;
  const firstVote = await vote(token, 'one', 1, revision);
  assert.equal(firstVote.status, 200);
  assert.equal(firstVote.headers.get('cache-control'), 'no-store');
  assert.equal(firstVote.headers.get('set-cookie'), null);
  assert.equal((await vote(token, 'one', 1, revision)).status, 200);
  const limited = await vote(token, 'one', 1, revision);
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.has('retry-after'));
});

test('受理済みの同じ回答を再送しても重複せず、終了・更新・旧セッションでは受理しない', async () => {
  const { call, control, deck, erase, state } = await fixture();
  const { body: created } = await deck([second]);
  await control('open', 'two');
  const voteRevision = created.questions[0].voteRevision;
  const data = { questionId: 'two', voterToken: newKey(), voteRevision, choices: [1, 3] };
  const send = () => call('/api/public/vote', { token: created.participantCode, method: 'POST', data });
  const accepted = await send();
  assert.equal(accepted.status, 200);
  const beforeRetry = await state();
  const retry = await send();
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, { sessionId: created.sessionId, voteRevision });
  const afterRetry = await state();
  assert.equal(afterRetry.revision, beforeRetry.revision);
  assert.equal(afterRetry.questions[0].results.respondentCount, 1);
  assert.equal(afterRetry.questions[0].results.totalSelections, 2);

  await control('close', 'two');
  const closed = await send();
  assert.equal(closed.status, 409);
  assert.equal(closed.body.code, 'vote_closed');
  assert.equal((await state()).questions[0].results.respondentCount, 1);
  await control('open', 'two');
  await control('reset-votes', 'two', true);
  const changed = await send();
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'vote_changed');
  assert.equal((await state()).questions[0].results.respondentCount, 0);

  await erase(created.sessionId);
  assert.equal((await send()).status, 410);
});

test('JSON の型が違う入力を拒否し、質問集と票を変更しない', async () => {
  const { call, control, deck, state, vote } = await fixture();
  const before = await state();
  for (const data of [null, [], true, { questions: [{ ...first, options: ['青', 2] }], deckRevision: before.deckRevision }]) {
    assert.equal((await call('/api/admin/deck', { method: 'PUT', data })).status, 400);
  }
  assert.equal((await call('/api/admin/control', { method: 'POST', data: { action: 'erase', confirm: 'true' } })).status, 400);
  const after = await state();
  assert.deepEqual(after, { ...before, serverTime: after.serverTime });

  const { body: created } = await deck([first]);
  const token = created.participantCode;
  const revision = created.questions[0].voteRevision;
  await control('open', 'one');
  assert.equal((await vote(token, 'one', 1, String(revision))).status, 400);
  assert.equal((await vote(token, 'one', '1', revision)).status, 400);
  assert.equal((await vote(token, 'one', 1, revision, {})).status, 400);
  assert.equal((await state()).questions[0].results.respondentCount, 0);
  const accepted = await vote(token, 'one', 1, revision);
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body, { sessionId: created.sessionId, voteRevision: revision });
});

test('静的ファイルを固定リストから提供し、QRコードの版とハッシュを固定する', async () => {
  const { call } = await fixture();
  for (const [path, entry] of [['/', 'participate'], ['/admin', 'admin'], ['/present', 'present']]) {
    const page = await call(path);
    assert.equal(page.status, 200, path);
    assert.ok(page.raw.toString().includes(`type="module" src="/${entry}.js"`), path);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'.*frame-ancestors 'none'/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  }
  const javascript = [
    '/participate.js', '/participant-discussion.js', '/admin.js', '/admin-deck.js', '/present.js', '/present-discussion.js',
    '/common.js', '/charts.js', '/preflight.js', '/qr.js'
  ];
  const assets = [
    ...javascript.map(path => [path, 'text/javascript; charset=utf-8']),
    ['/styles.css', 'text/css; charset=utf-8'],
    ['/mark.svg', 'image/svg+xml']
  ];
  for (const [path, contentType] of assets) {
    const asset = await call(path);
    assert.equal(asset.status, 200, path);
    assert.equal(asset.headers.get('content-type'), contentType, path);
    assert.ok(asset.raw.length > 0, path);
  }
  assert.equal((await call('/server.js')).status, 404);
  assert.equal((await call('/vendor/..%2F..%2Fserver.js')).status, 404);
  const source = await readFile(new URL('../public/vendor/qrcode.js', import.meta.url));
  const qr = await call('/vendor/qrcode.js');
  assert.equal(qr.status, 200);
  assert.deepEqual(qr.raw, source);
  assert.equal(createHash('sha256').update(qr.raw).digest('hex'),
    '79ec86f82856005b1c887905cfccfcfbec3821ca61c7fd5a952faa5f778f791c');
});

test('同梱の質問集は通常起動で読み込める', async () => {
  const { call, deck } = await fixture();
  const sample = await call('/pochipoll-sample-deck.json', { token: null });
  assert.equal(sample.status, 200);
  assert.equal(sample.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(sample.body.format, 'pochipoll-deck');
  assert.equal(sample.body.version, 1);
  assert.deepEqual(new Set(sample.body.questions.map(question => question.type)), new Set(['single', 'multiple']));
  assert.deepEqual(new Set(sample.body.questions.map(question => question.style)),
    new Set(['horizontal', 'vertical', 'donut', 'stacked']));

  const loaded = await deck(sample.body.questions, { replace: true });
  assert.equal(loaded.status, 200);
  assert.deepEqual(loaded.body.questions.map(question => question.questionId),
    sample.body.questions.map(question => question.questionId));
  assert.ok(loaded.body.questions.every(question => !question.everOpened && !question.resultsPublished));
});

test('HTTPS公開モードでは公開オリジンと短期の接続元別制限を使う', async () => {
  const baseUrl = 'https://poll.example.test';
  const { call, key } = await fixture({ baseUrl, transport: 'cloudflare', voteLimit: 1 });
  const forwarded = { Host: 'poll.example.test', Origin: baseUrl };
  const admin = await call('/api/admin/state', { headers: forwarded });
  assert.equal(admin.status, 200);
  assert.equal(admin.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.equal((await call('/api/admin/state', { token: key })).status, 421);
  const preflight = await call('/api/admin/preflight', { headers: forwarded });
  assert.equal(preflight.status, 200);
  assert.equal(preflight.body.origin, baseUrl);
  assert.equal(preflight.body.transport, 'cloudflare');
  assert.equal((await call('/api/admin/preflight')).status, 421);

  const deck = await call('/api/admin/deck', {
    method: 'PUT', headers: forwarded, data: { questions: [first], deckRevision: admin.body.deckRevision }
  });
  assert.equal(deck.status, 200);
  const open = await call('/api/admin/control', {
    method: 'POST', headers: forwarded, data: { action: 'open', questionId: 'one' }
  });
  assert.equal(open.status, 200);
  const { participantCode: token, questions } = open.body;
  const send = ip => call('/api/public/vote', {
    token, method: 'POST', headers: { ...forwarded, ...(ip && { 'CF-Connecting-IP': ip }) },
    data: { questionId: 'one', choices: 1, voterToken: newKey(), voteRevision: questions[0].voteRevision }
  });
  assert.equal((await send()).status, 403);
  assert.equal((await send('192.0.2.1')).status, 200);
  assert.equal((await send('192.0.2.1')).status, 429);
  assert.equal((await send('192.0.2.2')).status, 200);
});

const manualTopic = { questionId: 'manual', text: '事前審査のお題', type: 'discussion' };
const instantTopic = { questionId: 'instant', text: '即時公開のお題', type: 'discussion',
  settings: { moderationMode: 'instant' } };

async function discussionFixture(options) {
  const app = await fixture({ discussionEnabled: true, ...options });
  const { call } = app;
  const adminComments = id => call('/api/admin/comments?questionId=' + id);
  const comments = (token, id, voterToken) => call('/api/public/comments?questionId=' + id, {
    token, headers: voterToken ? { 'X-PochiPoll-Voter': voterToken } : {}
  });
  const requestData = (snapshot, questionId, voterToken) => ({
    sessionId: snapshot.sessionId, questionId, voterToken,
    discussionRevision: snapshot.discussions.find(question => question.questionId === questionId).discussionRevision
  });
  const post = (snapshot, data, token = snapshot.participantCode) =>
    call('/api/public/comments', { token, method: 'POST', data });
  const like = (snapshot, data, token = snapshot.participantCode) =>
    call('/api/public/likes', { token, method: 'POST', data });
  return { ...app, adminComments, comments, requestData, post, like };
}

test('通常起動ではコメント API とコメント形式を使用できない', async () => {
  const { call, deck, state } = await fixture();
  const before = await state();
  assert.equal(Object.hasOwn(before, 'discussions'), false);
  assert.equal((await deck([manualTopic])).status, 400);
  assert.equal((await call('/api/public/comments?questionId=manual', { token: before.participantCode })).status, 404);
  assert.equal((await call('/api/public/comments', {
    token: before.participantCode, method: 'POST', data: {}
  })).status, 404);
  assert.equal((await call('/api/admin/comments?questionId=manual')).status, 404);
  assert.equal((await call('/api/admin/comments/control', { method: 'POST', data: {} })).status, 404);
  assert.equal((await call('/api/admin/discussions/control', { method: 'POST', data: {} })).status, 404);
  assert.equal((await call('/api/admin/export-comments?sessionId=' + before.sessionId)).status, 404);
  assert.equal((await call('/api/public/likes', { token: before.participantCode, method: 'POST', data: {} })).status, 404);
  assert.equal((await state()).deckRevision, before.deckRevision);
});

test('コメントの権限を分離し、審査待ちと未受付のお題を公開しない', async () => {
  const { call, deck, control, comments, adminComments, post, like, requestData, state, vote } = await discussionFixture();
  assert.equal((await deck([{ ...manualTopic, settings: { moderationMode: 'automatic' } }])).status, 400);
  assert.equal((await deck([{ ...manualTopic, settings: { maxPostsPerToken: 2 } }])).status, 400);
  const { status, body: initial } = await deck([first, manualTopic, instantTopic]);
  assert.equal(status, 200);
  assert.deepEqual(initial.questions.map(q => q.questionId), ['one']);
  assert.deepEqual(initial.discussions[0].settings, { moderationMode: 'manual', maxPostsPerToken: 3 });
  assert.equal(initial.discussions[0].questionOrder, 2);
  const { participantCode: token, presentationToken } = initial;
  const publicState = () => call('/api/public/state', { token });
  const presentState = () => call('/api/present/state', { token: presentationToken });
  assert.deepEqual((await publicState()).body.discussions, []);
  assert.deepEqual((await comments(token, 'manual')).body, (await comments(token, 'missing')).body);

  await control('open', 'manual');
  const publicTopics = (await publicState()).body.discussions;
  assert.deepEqual(publicTopics.map(q => q.questionId), ['manual']);
  assert.equal(publicTopics[0].questionOrder, 1);
  assert.equal(Object.hasOwn(publicTopics[0], 'settings'), false);
  const author = newKey();
  const content = { ...requestData(initial, 'manual', author), clientSubmissionId: 'first', body: '審査待ちのテスト本文' };
  assert.equal((await post(initial, content, presentationToken)).status, 401);
  const added = await post(initial, content);
  assert.equal(added.status, 200);
  const { commentId } = added.body;
  assert.deepEqual(added.body, { commentId, visibility: 'pending' });
  assert.equal((await call('/api/admin/comments?questionId=manual', { token })).status, 401);
  assert.equal((await call('/api/admin/comments?questionId=manual', { token: presentationToken })).status, 401);
  assert.equal((await comments(presentationToken, 'manual')).status, 401);
  assert.deepEqual((await comments(token, 'manual', author)).body.comments, []);
  assert.deepEqual((await adminComments('manual')).body.comments, [
    { commentId, body: content.body, visibility: 'pending', likes: 0, presented: false }
  ]);
  assert.equal((await state()).discussions[0].commentCount, 1);
  const exposed = JSON.stringify([(await publicState()).body, (await presentState()).body]);
  assert.ok(!exposed.includes(content.body));
  assert.ok(!exposed.includes('commentCount'));
  assert.ok(!exposed.includes(author));
  assert.equal((await like(initial, { ...requestData(initial, 'manual', newKey()), commentId, liked: true })).status, 404);
  assert.equal((await vote(token, 'manual', 1, 1)).status, 404);
  assert.equal((await call('/api/public/results?questionId=manual', { token })).status, 404);
});

test('投稿の冪等性と文字数・サイズ・セッションの検証を行う', async () => {
  const { origin, call, deck, control, post, adminComments, requestData } = await discussionFixture();
  const { body: snapshot } = await deck([manualTopic, instantTopic]);
  await control('open', 'manual');
  await control('open', 'instant');
  const voterToken = newKey();
  const base = { ...requestData(snapshot, 'manual', voterToken), clientSubmissionId: 'repeat' };
  const content = { ...base, body: '😀'.repeat(300) };
  const attempts = await Promise.all([post(snapshot, content), post(snapshot, content)]);
  assert.deepEqual(attempts.map(result => result.status), [200, 200]);
  assert.deepEqual(attempts[0].body, attempts[1].body);
  assert.equal((await post(snapshot, { ...base, body: '別の本文' })).status, 409);
  assert.equal((await post(snapshot, { ...base, voterToken: newKey(), body: '別の投稿者' })).status, 200);
  assert.equal((await post(snapshot, { ...content, ...requestData(snapshot, 'instant', voterToken) })).status, 200);

  for (const body of ['  \n ', '😀'.repeat(301), false]) {
    assert.equal((await post(snapshot, { ...base, clientSubmissionId: 'invalid', body })).status, 400);
  }
  assert.equal((await post(snapshot, { ...content, sessionId: 'old-session' })).status, 409);
  assert.equal((await post(snapshot, { ...content, discussionRevision: base.discussionRevision + 1 })).status, 409);
  assert.equal((await post(snapshot, { ...content, visibility: 'published' })).status, 400);
  assert.equal((await post(snapshot, { ...content, voterToken: 'invalid' })).status, 400);
  assert.equal((await post(snapshot, { ...content, body: 'a'.repeat(8192) })).status, 413);
  const malformed = await fetch(origin + '/api/public/comments', {
    method: 'POST', body: '{', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + snapshot.participantCode }
  });
  assert.equal(malformed.status, 400);
  assert.equal((await call('/api/public/comments', {
    token: snapshot.participantCode, method: 'POST', data: content, headers: { Origin: 'https://example.test' }
  })).status, 403);

  for (const id of ['second', 'third']) {
    assert.equal((await post(snapshot, { ...base, clientSubmissionId: id, body: id })).status, 200);
  }
  assert.equal((await post(snapshot, { ...base, clientSubmissionId: 'fourth', body: '上限を超える投稿' })).status, 409);
  assert.equal((await post(snapshot, content)).status, 200);
  assert.equal((await adminComments('manual')).body.comments.length, 4);
  assert.equal((await adminComments('manual')).body.comments[0].body, content.body);
});

test('公開済みコメントにだけいいねでき、同じ設定の再送は重複しない', async () => {
  const { deck, control, post, comments, like, requestData } = await discussionFixture();
  const { body: snapshot } = await deck([instantTopic, { ...instantTopic, questionId: 'other' }]);
  await control('open', 'instant');
  await control('open', 'other');
  const author = newKey();
  const reader = newKey();
  const base = requestData(snapshot, 'instant', author);
  const publicList = (token = reader) => comments(snapshot.participantCode, 'instant', token);
  const literal = '<b>テスト本文</b>';
  const { body: firstPost } = await post(snapshot, { ...base, clientSubmissionId: 'first', body: literal });
  const { body: secondPost } = await post(snapshot, { ...base, clientSubmissionId: 'second', body: '二番目' });
  const orderedIds = async () => (await publicList()).body.comments.map(comment => comment.commentId);
  assert.deepEqual(await orderedIds(), [firstPost.commentId, secondPost.commentId]);
  const reaction = { ...requestData(snapshot, 'instant', reader), commentId: secondPost.commentId, liked: true };
  assert.equal((await like(snapshot, { ...reaction, voterToken: author })).status, 403);
  assert.equal((await like(snapshot, { ...reaction, liked: 'true' })).status, 400);
  assert.equal((await like(snapshot, { ...reaction, ...requestData(snapshot, 'other', reader) })).status, 404);
  const attempts = await Promise.all([like(snapshot, reaction), like(snapshot, reaction)]);
  assert.ok(attempts.every(result => result.status === 200 && result.body.likes === 1));
  assert.deepEqual(await orderedIds(), [secondPost.commentId, firstPost.commentId]);
  const { body, headers } = await publicList();
  assert.equal(headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(body.comments[1], { commentId: firstPost.commentId, body: literal, likes: 0, presented: false,
    authoredByYou: false, likedByYou: false });
  assert.equal(body.comments[0].likedByYou, true);
  assert.equal((await publicList(author)).body.comments[0].authoredByYou, true);
  assert.equal((await like(snapshot, { ...reaction, liked: false })).body.likes, 0);
  assert.deepEqual(await orderedIds(), [firstPost.commentId, secondPost.commentId]);
  assert.equal((await like(snapshot, reaction)).body.likes, 1);
  await control('close', 'instant');
  assert.equal((await like(snapshot, { ...reaction, liked: false })).status, 409);
  assert.equal((await post(snapshot, { ...base, clientSubmissionId: 'closed', body: literal })).status, 409);
  assert.equal((await publicList()).body.comments[0].likes, 1);
});

test('コメント一覧は公開内容の変更がある場合にだけ再配信する', async () => {
  const { deck, control, post, comments, like, requestData } = await discussionFixture();
  const { body: snapshot } = await deck([manualTopic, instantTopic]);
  for (const topic of snapshot.discussions) await control('open', topic.questionId);
  const reader = newKey();
  const list = (id, revision) => comments(snapshot.participantCode, id + '&revision=' + revision, reader);
  const { body: pending } = await comments(snapshot.participantCode, 'manual', reader);
  const { body: empty } = await comments(snapshot.participantCode, 'instant', reader);
  assert.equal((await list('instant', empty.revision)).status, 204);
  assert.equal((await list('instant', 'invalid')).status, 400);
  await post(snapshot, { ...requestData(snapshot, 'manual', newKey()), clientSubmissionId: 'one', body: '審査待ち' });
  assert.equal((await list('manual', pending.revision)).status, 204);

  const { body: added } = await post(snapshot, { ...requestData(snapshot, 'instant', newKey()),
    clientSubmissionId: 'one', body: '新しいコメント' });
  const published = await list('instant', empty.revision);
  assert.equal(published.status, 200);
  assert.ok(published.body.revision > empty.revision);
  const reaction = { ...requestData(snapshot, 'instant', reader), commentId: added.commentId, liked: true };
  await like(snapshot, reaction);
  const liked = await list('instant', published.body.revision);
  assert.equal(liked.status, 200);
  assert.equal(liked.body.comments[0].likedByYou, true);
  await like(snapshot, reaction);
  assert.equal((await list('instant', liked.body.revision)).status, 204);
  await deck([manualTopic, { ...instantTopic, text: '編集後のお題' }]);
  const edited = await list('instant', liked.body.revision);
  assert.equal(edited.status, 200);
  assert.notEqual(edited.body.discussionRevision, liked.body.discussionRevision);
  assert.deepEqual(edited.body.comments, liked.body.comments);
});

test('審査設定の変更は新規投稿にだけ適用し、置換や全消去で旧データを破棄する', async () => {
  const { call, deck, control, erase, post, comments, adminComments, requestData } = await discussionFixture();
  const { body: initial } = await deck([manualTopic, first]);
  const { participantCode: token } = initial;
  await control('open', 'manual');
  const voterToken = newKey();
  const base = requestData(initial, 'manual', voterToken);
  const pendingPost = await post(initial, { ...base, body: '審査待ち', clientSubmissionId: 'pending' });
  assert.equal(pendingPost.body.visibility, 'pending');
  const converted = { ...manualTopic, settings: { moderationMode: 'instant' } };
  const { body: changed } = await deck([first, converted]);
  assert.equal(changed.discussions[0].discussionRevision, base.discussionRevision);
  assert.equal(changed.discussions[0].questionOrder, 2);
  assert.deepEqual((await comments(token, 'manual')).body.comments, []);
  const secondPost = await post(changed, { ...base, body: '即時公開', clientSubmissionId: 'published' });
  assert.equal(secondPost.body.visibility, 'published');
  await deck([first, manualTopic]);
  assert.deepEqual((await adminComments('manual')).body.comments.map(comment => comment.visibility), ['pending', 'published']);
  assert.deepEqual((await comments(token, 'manual')).body.comments.map(comment => comment.body), ['即時公開']);
  const pollExport = await call('/api/admin/export?format=json');
  assert.deepEqual(pollExport.body.questions.map(question => question.questionId), ['one']);
  assert.ok(!pollExport.raw.toString().includes('即時公開'));
  const csv = await call('/api/admin/export?format=csv');
  assert.ok(!csv.raw.toString().includes('審査待ち'));

  const { body: edited } = await deck([first, { ...manualTopic, text: '編集したお題' }]);
  assert.ok(edited.discussions[0].discussionRevision > base.discussionRevision);
  assert.equal((await post(edited, { ...base, body: '旧画面からの投稿', clientSubmissionId: 'stale' })).status, 409);
  assert.equal((await deck([first], { replace: true })).body.code, 'confirm_reset');
  const { body: replaced } = await deck([first, manualTopic], { replace: true, confirmReset: true });
  assert.equal(replaced.discussions[0].commentCount, 0);
  assert.equal(replaced.discussions[0].everOpened, false);
  assert.deepEqual((await adminComments('manual')).body.comments, []);
  await control('open', 'manual');
  assert.equal((await post(replaced, { ...requestData(replaced, 'manual', voterToken),
    body: '置換後の投稿', clientSubmissionId: 'new' })).status, 200);
  const { body: cleared } = await erase(initial.sessionId);
  assert.deepEqual(cleared.discussions, []);
  assert.equal((await comments(token, 'manual')).status, 410);
  assert.equal((await adminComments('manual')).status, 404);
});

test('自動消去でコメントと参加コードを破棄する', async () => {
  const { deck, control, post, comments, adminComments, state, requestData } = await discussionFixture({ idleMs: 400 });
  await deck([instantTopic]);
  const { body: opened } = await control('open', 'instant');
  assert.equal((await post(opened, { ...requestData(opened, 'instant', newKey()),
    clientSubmissionId: 'expires', body: '自動消去のテスト' })).status, 200);
  assert.equal((await state()).expiresAt, opened.expiresAt);
  await sleep(Math.max(0, opened.expiresAt - Date.now()) + 30);
  assert.equal((await adminComments('instant')).status, 404);
  assert.equal((await comments(opened.participantCode, 'instant')).status, 410);
});

test('投票・投稿・いいねの短期レート制限を分ける', async () => {
  const { deck, control, post, like, vote, requestData } = await discussionFixture({ voteLimit: 1 });
  const { body: snapshot } = await deck([first, instantTopic]);
  await control('open', 'one');
  await control('open', 'instant');
  const data = { ...requestData(snapshot, 'instant', newKey()), clientSubmissionId: 'one', body: 'レート確認' };
  const { body: created, status } = await post(snapshot, data);
  assert.equal(status, 200);
  const limitedPost = await post(snapshot, data);
  assert.equal(limitedPost.status, 429);
  assert.equal(limitedPost.headers.get('retry-after'), '3');
  const reaction = { ...requestData(snapshot, 'instant', newKey()), commentId: created.commentId, liked: true };
  assert.equal((await like(snapshot, reaction)).status, 200);
  assert.equal((await like(snapshot, reaction)).status, 429);
  assert.equal((await vote(snapshot.participantCode, 'one', 1, snapshot.questions[0].voteRevision)).status, 200);
});

test('一人・お題・セッションの投稿上限を適用する', async () => {
  const { deck, control, post, requestData } = await discussionFixture({ voteLimit: 2000 });
  const topics = Array.from({ length: 6 }, (_, index) => ({
    ...instantTopic, questionId: 'topic-' + index, settings: { maxPostsPerToken: 'unlimited' }
  }));
  const singleSlot = { ...manualTopic, settings: { maxPostsPerToken: 1 } };
  const { body: snapshot } = await deck([...topics, singleSlot]);
  const voterToken = newKey();
  const send = (questionId, index) => post(snapshot, { ...requestData(snapshot, questionId, voterToken),
    body: '上限テスト用の本文', clientSubmissionId: 'id-' + index });
  await control('open', 'manual');
  assert.equal((await send('manual', 0)).status, 200);
  assert.equal((await send('manual', 1)).status, 409);
  await deck(topics, { confirmReset: true });

  for (const topic of topics.slice(0, 5)) {
    await control('open', topic.questionId);
    const posted = await Promise.all(Array.from({ length: 200 }, (_, index) => send(topic.questionId, index)));
    assert.ok(posted.every(response => response.status === 200), topic.questionId);
  }
  assert.equal((await send(topics[0].questionId, 200)).status, 409);
  assert.equal((await send(topics[0].questionId, 0)).status, 200);
  await control('open', topics[5].questionId);
  assert.equal((await send(topics[5].questionId, 0)).status, 409);
});

test('運営の承認・非公開・再公開・削除は公開一覧を更新し、停止後も審査できる', async () => {
  const { call, deck, control, post, like, comments, adminComments, requestData, state } = await discussionFixture();
  const snapshot = (await deck([manualTopic])).body;
  await control('open', 'manual');
  const base = requestData(snapshot, 'manual', newKey());
  const receipt = (await post(snapshot, { ...base, clientSubmissionId: 'moderated', body: '<b>検証用本文</b>' })).body;
  const update = (action, expectedVisibility, extra = {}) => call('/api/admin/comments/control', {
    method: 'POST', data: { sessionId: base.sessionId, questionId: base.questionId,
      discussionRevision: base.discussionRevision, commentId: receipt.commentId, action, expectedVisibility, ...extra }
  });
  const initial = (await comments(snapshot.participantCode, 'manual')).body;
  assert.equal(initial.comments.length, 0);
  assert.equal((await update('publish', 'pending')).status, 200);
  const published = (await comments(snapshot.participantCode, 'manual')).body;
  assert.ok(published.revision > initial.revision);
  assert.equal(published.comments[0].body, '<b>検証用本文</b>');
  assert.equal((await like(snapshot, { ...base, voterToken: newKey(), commentId: receipt.commentId, liked: true })).status, 200);
  assert.equal((await adminComments('manual')).body.comments[0].likes, 1);
  await control('close', 'manual');
  assert.equal((await post(snapshot, { ...base, clientSubmissionId: 'after-close', body: '停止後' })).status, 409);
  assert.equal((await like(snapshot, { ...base, voterToken: newKey(), commentId: receipt.commentId, liked: true })).status, 409);
  assert.equal((await update('hide', 'published')).status, 200);
  const hidden = (await comments(snapshot.participantCode, 'manual')).body;
  assert.equal(hidden.comments.length, 0);
  assert.ok(hidden.revision > published.revision);
  assert.equal((await update('publish', 'pending')).status, 409);
  assert.equal((await update('publish', 'hidden')).status, 200);
  assert.equal((await comments(snapshot.participantCode, 'manual')).body.comments[0].likes, 1);
  assert.equal((await update('delete', 'published')).status, 400);
  assert.equal((await update('delete', 'published', { confirm: true })).status, 200);
  assert.equal((await comments(snapshot.participantCode, 'manual')).body.comments.length, 0);
  assert.equal((await adminComments('manual')).body.comments.length, 0);
  assert.equal((await state()).discussions[0].commentCount, 0);
  assert.equal((await update('publish', 'published')).status, 404);
  assert.equal((await call('/api/present/state', { token: snapshot.presentationToken })).raw.includes(Buffer.from('検証用本文')), false);
});

test('コメント管理は管理認証・同一オリジン・セッションとお題の一致・入力検証を要求する', async () => {
  const { call, deck, control, post, requestData, adminComments, erase } = await discussionFixture();
  const snapshot = (await deck([manualTopic, instantTopic])).body;
  await control('open', 'manual');
  const base = requestData(snapshot, 'manual', newKey());
  const receipt = (await post(snapshot, { ...base, clientSubmissionId: 'secure', body: '権限テスト用' })).body;
  const data = { sessionId: base.sessionId, questionId: 'manual', discussionRevision: base.discussionRevision,
    commentId: receipt.commentId, action: 'publish', expectedVisibility: 'pending' };
  const update = (patch = {}, options = {}) => call('/api/admin/comments/control', {
    method: 'POST', data: { ...data, ...patch }, ...options
  });
  for (const token of [snapshot.participantCode, snapshot.presentationToken, null]) {
    assert.equal((await update({}, { token })).status, 401);
  }
  assert.equal((await update({}, { headers: { Origin: 'https://invalid.example' } })).status, 403);
  for (const patch of [{ action: 'present' }, { expectedVisibility: 'private' }, { confirm: 'true' },
    { discussionRevision: '1' }, { commentId: '' }, { sessionId: null }, { extra: true }]) {
    assert.equal((await update(patch)).status, 400);
  }
  assert.equal((await update({ sessionId: 'stale' })).status, 409);
  assert.equal((await update({ discussionRevision: base.discussionRevision + 1 })).status, 409);
  assert.equal((await update({ questionId: 'instant', discussionRevision: snapshot.discussions[1].discussionRevision })).status, 404);
  assert.equal((await adminComments('manual')).body.comments[0].visibility, 'pending');
  await deck([{ ...manualTopic, text: '更新したお題' }, instantTopic]);
  assert.equal((await update()).status, 409);
  await erase(snapshot.sessionId);
  assert.equal((await update()).status, 409);
});

test('非公開の審査と削除では公開一覧のリビジョンを進めない', async () => {
  const { call, deck, control, post, requestData, comments } = await discussionFixture();
  const snapshot = (await deck([manualTopic])).body;
  await control('open', 'manual');
  const base = requestData(snapshot, 'manual', newKey());
  const receipt = (await post(snapshot, { ...base, clientSubmissionId: 'private', body: '審査用' })).body;
  const before = (await comments(snapshot.participantCode, 'manual')).body;
  for (const [action, expectedVisibility] of [['hide', 'pending'], ['delete', 'hidden']]) {
    assert.equal((await call('/api/admin/comments/control', { method: 'POST', data: {
      sessionId: base.sessionId, questionId: 'manual', discussionRevision: base.discussionRevision,
      commentId: receipt.commentId, action, expectedVisibility, confirm: true
    } })).status, 200);
    assert.equal((await call('/api/public/comments?questionId=manual&revision=' + before.revision,
      { token: snapshot.participantCode })).status, 204);
  }
});

test('混在する質問集の編集用データは順序と設定だけを保ち、コメントや結果を含まない', async () => {
  const { orderedItems, draft } = await import('../dist/public/admin-deck.js');
  const { deck, state } = await discussionFixture();
  await deck([manualTopic, first, instantTopic, second]);
  const snapshot = await state();
  const drafts = orderedItems(snapshot).map(draft);
  assert.deepEqual(drafts.map(item => item.questionId), ['manual', 'one', 'instant', 'two']);
  assert.deepEqual(drafts[0], { ...manualTopic, settings: { moderationMode: 'manual', maxPostsPerToken: 3 } });
  assert.deepEqual(drafts[1], first);
  assert.equal((await deck(drafts)).status, 200);
  assert.deepEqual(orderedItems(await state()).map(item => item.questionId), drafts.map(item => item.questionId));
});

async function presentationFixture() {
  const app = await discussionFixture();
  const snapshot = (await app.deck([first, manualTopic, instantTopic])).body;
  await app.control('open', 'manual');
  await app.control('open', 'instant');
  const context = (questionId = 'instant') => ({ sessionId: snapshot.sessionId, questionId,
    discussionRevision: snapshot.discussions.find(topic => topic.questionId === questionId).discussionRevision });
  const display = (data, options = {}) => app.call('/api/admin/discussions/control', {
    method: 'POST', data: { ...context(), ...data }, ...options
  });
  const present = (revision) => app.call('/api/present/state' + (revision === undefined ? '' : '?revision=' + revision),
    { token: snapshot.presentationToken });
  const add = async (questionId, id) => (await app.post(snapshot, { ...app.requestData(snapshot, questionId, newKey()),
    clientSubmissionId: id, body: '検証専用-' + id })).body.commentId;
  const moderate = (commentId, action, expectedVisibility = 'published', questionId = 'instant') =>
    app.call('/api/admin/comments/control', { method: 'POST', data: { ...context(questionId), commentId, action,
      expectedVisibility, confirm: true } });
  const exported = (options = {}) => app.call('/api/admin/export-comments?sessionId=' + snapshot.sessionId, options);
  return { ...app, snapshot, context, display, present, add, moderate, exported };
}

test('発表の一覧・注目・紹介済みは公開権限と分離し、非公開と削除を待機中の発表にも通知する', async () => {
  const { snapshot, display, present, add, moderate, comments, like, requestData } = await presentationFixture();
  await add('manual', 'pending-never-present');
  const firstId = await add('instant', 'first');
  const secondId = await add('instant', 'second');
  let shown = (await present()).body;
  assert.deepEqual(shown.discussion.comments.map(c => c.commentId), [firstId, secondId]);
  assert.deepEqual(Object.keys(shown.discussion.comments[0]).sort(), ['body', 'commentId', 'likes', 'presented']);
  assert.equal(JSON.stringify(shown).includes('pending-never-present'), false);
  assert.equal((await display({ action: 'focus', commentId: firstId })).status, 200);
  assert.equal((await present()).body.discussion.presentation.focusedCommentId, firstId);
  const before = (await comments(snapshot.participantCode, 'instant')).body.revision;
  for (let i = 0; i < 2; i++) assert.equal((await display({ action: 'set-presented', commentId: firstId, presented: true })).status, 200);
  shown = (await present()).body;
  assert.equal(shown.discussion.presentation.focusedCommentId, null);
  assert.equal(shown.discussion.comments.find(c => c.commentId === firstId).presented, true);
  const publicList = (await comments(snapshot.participantCode, 'instant')).body;
  assert.ok(publicList.revision > before);
  assert.equal(publicList.comments.length, 2);
  assert.equal((await like(snapshot, { ...requestData(snapshot, 'instant', newKey()), commentId: firstId, liked: true })).status, 200);
  assert.equal((await display({ action: 'set-presented', commentId: firstId, presented: false })).status, 200);
  assert.equal((await present()).body.discussion.comments.find(c => c.commentId === firstId).presented, false);
  await display({ action: 'focus', commentId: secondId });
  shown = (await present()).body;
  const waiting = present(shown.revision);
  await moderate(secondId, 'hide');
  const notified = await waiting;
  assert.equal(notified.status, 200);
  assert.equal(notified.body.discussion.presentation.focusedCommentId, null);
  assert.equal(JSON.stringify(notified.body).includes('検証専用-second'), false);
  assert.equal((await display({ action: 'focus', commentId: secondId })).status, 404);
  await display({ action: 'focus', commentId: firstId });
  await moderate(firstId, 'delete');
  const deleted = (await present()).body.discussion;
  assert.equal(deleted.presentation.focusedCommentId, null);
  assert.equal(deleted.comments.length, 0);
});

test('発表の並び順固定は参加者のいいね順に影響せず、固定中も非公開・削除を除く', async () => {
  const { snapshot, add, present, display, like, requestData, comments, moderate } = await presentationFixture();
  const a = await add('instant', 'ordered-a');
  const b = await add('instant', 'ordered-b');
  await display({ action: 'configure', hidePresented: false, freezeOrder: true });
  await like(snapshot, { ...requestData(snapshot, 'instant', newKey()), commentId: b, liked: true });
  assert.deepEqual((await present()).body.discussion.comments.map(c => c.commentId), [a, b]);
  assert.deepEqual((await comments(snapshot.participantCode, 'instant')).body.comments.map(c => c.commentId), [b, a]);
  const c = await add('instant', 'ordered-c');
  assert.deepEqual((await present()).body.discussion.comments.map(c => c.commentId), [a, b, c]);
  await moderate(a, 'hide');
  await moderate(b, 'delete');
  assert.deepEqual((await present()).body.discussion.comments.map(c => c.commentId), [c]);
  await moderate(a, 'publish', 'hidden');
  assert.deepEqual((await present()).body.discussion.comments.map(c => c.commentId), [c, a]);
  await display({ action: 'configure', hidePresented: true, freezeOrder: false });
  assert.deepEqual((await present()).body.discussion.comments.map(c => c.commentId), [a, c]);
});

test('コメント書き出しは公開済みだけを独立した形式に保存し、紹介済みも含める', async () => {
  const { snapshot, context, add, display, moderate, exported, call, erase, state } = await presentationFixture();
  const pending = await add('manual', 'export-pending');
  const published = await add('instant', 'export-public');
  const hidden = await add('instant', 'export-hidden');
  const deleted = await add('instant', 'export-deleted');
  await moderate(hidden, 'hide');
  await moderate(deleted, 'delete');
  await display({ action: 'set-presented', commentId: published, presented: true });
  const result = await exported();
  assert.equal(result.status, 200);
  assert.match(result.headers.get('content-disposition'), /pochipoll-comments\.json/);
  assert.equal(result.body.format, 'pochipoll-comments');
  assert.equal(result.body.version, 1);
  assert.equal(result.body.sessionId, snapshot.sessionId);
  assert.ok(Number.isFinite(Date.parse(result.body.exportedAt)));
  assert.deepEqual(result.body.topics.map(topic => topic.questionOrder), [2, 3]);
  assert.deepEqual(result.body.topics[0].comments, []);
  assert.deepEqual(result.body.topics[1].comments, [{ commentId: published, text: '検証専用-export-public', likes: 0, presented: true }]);
  assert.deepEqual(result.body.topics[1].settings, { moderationMode: 'instant', maxPostsPerToken: 3 });
  for (const text of [pending, hidden, deleted, 'author', 'submission', 'voterToken', 'likedByYou', '検証専用-export-hidden']) {
    assert.equal(JSON.stringify(result.body).includes(text), false);
  }
  assert.equal((await call('/api/admin/export?format=json')).body.format, 'pochipoll-results');
  for (const token of [snapshot.participantCode, snapshot.presentationToken, null]) assert.equal((await exported({ token })).status, 401);
  assert.equal((await call('/api/admin/export-comments')).status, 400);
  assert.equal((await call('/api/admin/export-comments?sessionId=stale')).status, 409);
  assert.equal((await call('/api/admin/export-comments?sessionId=' + context().sessionId + '&includeHidden=true')).status, 400);
  await erase(snapshot.sessionId);
  assert.equal((await exported()).status, 409);
  const next = await state();
  assert.deepEqual((await call('/api/admin/export-comments?sessionId=' + next.sessionId)).body.topics, []);
});

test('発表操作は認証・オリジン・世代と公開状態を検証し、不正な値では変更しない', async () => {
  const { snapshot, context, add, display, present, call, deck, erase } = await presentationFixture();
  const id = await add('instant', 'validation');
  const pending = await add('manual', 'not-published');
  for (const token of [snapshot.participantCode, snapshot.presentationToken, null]) {
    assert.equal((await display({ action: 'list' }, { token })).status, 401);
  }
  assert.equal((await display({ action: 'list' }, { headers: { Origin: 'https://invalid.example' } })).status, 403);
  for (const data of [{ action: 'unknown' }, { action: 'focus', commentId: '' },
    { action: 'set-presented', commentId: id, presented: 'true' }, { action: 'list', commentId: id },
    { action: 'focus', commentId: id, presented: true }, { action: 'configure', hidePresented: true, freezeOrder: 1 },
    { action: 'configure', hidePresented: true, freezeOrder: true, commentId: id }, { action: 'list', extra: true }]) {
    assert.equal((await display(data)).status, 400);
  }
  assert.equal((await display({ action: 'focus', commentId: pending, ...context('manual') })).status, 404);
  assert.equal((await display({ action: 'set-presented', commentId: pending, presented: true, ...context('manual') })).status, 404);
  assert.equal((await display({ action: 'list', sessionId: 'old' })).status, 409);
  assert.equal((await display({ action: 'list', discussionRevision: context().discussionRevision + 1 })).status, 409);
  assert.equal((await present()).body.discussion.presentation.focusedCommentId, null);
  await deck([first, manualTopic, { ...instantTopic, text: '更新後' }]);
  assert.equal((await display({ action: 'focus', commentId: id })).status, 409);
  await erase(snapshot.sessionId);
  assert.equal((await display({ action: 'list' })).status, 409);
  assert.equal((await call('/api/present/state', { token: snapshot.presentationToken })).status, 410);
});

test('審査待ちは発表のリビジョンを進めず、選択式への切替ではコメントを配信しない', async () => {
  const { add, present, control, display, context } = await presentationFixture();
  await display({ action: 'list', ...context('manual') });
  const before = (await present()).body;
  await add('manual', 'pending-revision');
  assert.equal((await present(before.revision)).status, 204);
  await control('open', 'one');
  const choice = (await present()).body;
  assert.equal(choice.question.questionId, 'one');
  assert.equal(Object.hasOwn(choice, 'discussion'), false);
});
