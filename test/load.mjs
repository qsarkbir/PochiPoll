import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createApp } from '../dist/server.js';

const count = 200;
const adminKey = randomBytes(32).toString('base64url');
const server = createApp({ adminKey });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;

async function api(path, { key = adminKey, method = 'GET', data, expected = 200 } = {}) {
  const started = performance.now();
  const response = await fetch(origin + path, {
    method, headers: {
      Authorization: 'Bearer ' + key,
      ...(data && { 'Content-Type': 'application/json', Origin: origin })
    },
    body: data && JSON.stringify(data),
    signal: AbortSignal.timeout(10_000)
  });
  assert.equal(response.status, expected, path);
  const body = expected === 204 ? null : await response.json();
  return { body, ms: performance.now() - started };
}

function summarize(label, samples) {
  const times = samples.map(sample => sample.ms).sort((a, b) => a - b);
  const p95 = times[Math.ceil(times.length * 0.95) - 1];
  console.log(label + ' ' + times.length + ' 件 · p95 ' + p95.toFixed(1)
    + ' ms · 最大 ' + times.at(-1).toFixed(1) + ' ms');
}

try {
  const { body: { deckRevision } } = await api('/api/admin/state');
  const questionId = 'load-test';
  const { body: { participantCode: key } } = await api('/api/admin/deck', {
    method: 'PUT', data: { deckRevision, questions: [{
      questionId, text: '負荷試験用の質問', type: 'single', options: ['A', 'B'], style: 'horizontal'
    }] }
  });
  const control = (action, id) => api('/api/admin/control', { method: 'POST', data: { action, questionId: id } });
  await control('open', questionId);
  await control('select', questionId);

  const initial = await Promise.all(Array.from({ length: count }, () => api('/api/public/state', { key })));
  const { revision, questions } = initial[0].body;
  const voteRevision = questions[0].voteRevision;
  summarize('参加者の初回取得', initial);
  const unchanged = await Promise.all(Array.from({ length: count }, () =>
    api('/api/public/state?revision=' + revision, { key, expected: 204 })));
  summarize('変更のないポーリング', unchanged);
  const votes = await Promise.all(Array.from({ length: count }, (_, index) => api('/api/public/vote', {
    key, method: 'POST', data: {
      questionId, voteRevision, choices: 1 + index % 2, voterToken: randomBytes(32).toString('base64url')
    }
  })));
  summarize('同時投票', votes);

  await control('show-results');
  const results = await Promise.all(Array.from({ length: count }, async () => {
    const state = await api('/api/public/state?revision=' + revision, { key });
    assert.equal(state.body.questions[0].resultsPublished, true);
    const result = await api('/api/public/results?questionId=' + questionId, { key });
    assert.equal(result.body.respondentCount, count);
    assert.deepEqual(result.body.options.map(option => option.optionVotes), [count / 2, count / 2]);
    return { ms: state.ms + result.ms };
  }));
  summarize('公開後の状態と結果の取得', results);

  const snapshot = (await api('/api/admin/state')).body;
  const question = snapshot.questions[0];
  const topicId = 'mixed-comments';
  const { body: mixed } = await api('/api/admin/deck', { method: 'PUT', data: {
    deckRevision: snapshot.deckRevision, questions: [
      { questionId, text: question.text, type: question.type, options: question.options, style: question.style },
      { questionId: topicId, type: 'discussion', text: '混在負荷検証のお題', settings: { moderationMode: 'instant' } }
    ]
  } });
  await control('open', topicId);
  const discussionRevision = mixed.discussions[0].discussionRevision;
  const tokens = Array.from({ length: count }, () => randomBytes(32).toString('base64url'));
  const submitted = await Promise.all(tokens.map(async (voterToken, index) => {
    const [vote, post] = await Promise.all([
      api('/api/public/vote', { key, method: 'POST', data: { questionId, voteRevision, choices: 1 + index % 2, voterToken } }),
      api('/api/public/comments', { key, method: 'POST', data: {
        sessionId: mixed.sessionId, questionId: topicId, discussionRevision, voterToken,
        clientSubmissionId: 'load-' + index, body: '負荷検証用コメント ' + index
      } })
    ]);
    return { ms: Math.max(vote.ms, post.ms), commentId: post.body.commentId };
  }));
  summarize('投票とコメントの同時送信（各200件）', submitted);
  const liked = await Promise.all(tokens.map((voterToken, index) => api('/api/public/likes', {
    key, method: 'POST', data: { sessionId: mixed.sessionId, questionId: topicId, discussionRevision,
      voterToken, commentId: submitted[(index + 1) % count].commentId, liked: true }
  })));
  summarize('コメントへの同時いいね', liked);
  const reads = await Promise.all(tokens.map(() => api('/api/public/comments?questionId=' + topicId, { key })));
  summarize('公開コメント200件の同時取得', reads);
  assert.equal(reads[0].body.comments.length, count);
  assert.ok(reads[0].body.comments.every(comment => comment.likes === 1));
  const present = (await api('/api/present/state', { key: mixed.presentationToken })).body;
  assert.equal(present.discussion.comments.length, count);
  for (const [index, action] of [[0, 'hide'], [1, 'delete']]) {
    await api('/api/admin/comments/control', { method: 'POST', data: {
      sessionId: mixed.sessionId, questionId: topicId, discussionRevision,
      commentId: submitted[index].commentId, expectedVisibility: 'published', action, confirm: true
    } });
  }
  const afterModeration = (await api('/api/present/state', { key: mixed.presentationToken })).body;
  assert.equal(afterModeration.discussion.comments.length, count - 2);
  const exported = (await api('/api/admin/export-comments?sessionId=' + mixed.sessionId)).body;
  assert.equal(exported.topics[0].comments.length, count - 2);
  const unchangedComments = await Promise.all(tokens.map(() => api('/api/public/comments?questionId=' + topicId
    + '&revision=' + reads[0].body.revision, { key })));
  assert.ok(unchangedComments.every(result => result.body.comments.length === count - 2));
  const revisionAfter = unchangedComments[0].body.revision;
  const unchangedReads = await Promise.all(tokens.map(() => api('/api/public/comments?questionId=' + topicId
    + '&revision=' + revisionAfter, { key, expected: 204 })));
  summarize('コメント変更なしの同時取得', unchangedReads);
} finally {
  server.close();
  server.closeAllConnections();
}
