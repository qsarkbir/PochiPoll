# コメント API の開発メモ

通常の `npm start` でコメント API と質問集の `discussion` 形式を利用できます。独立したローカルセッションで操作を確認するには `npm run preview:discussion` を使えます。[手動受入手順](discussion-acceptance.md)

## お題の設定

`PUT /api/admin/deck` の `questions` に、選択式の質問と一緒に次の形式を指定できます。

```json
{
  "questionId": "discussion-1",
  "text": "次回扱ってほしいテーマは？",
  "type": "discussion",
  "settings": { "moderationMode": "manual", "maxPostsPerToken": 3 }
}
```

`settings` の既定値は事前審査と1トークンあたり3件です。即時公開には `instant` を指定します。投稿数制限は `1`、`3`、`"unlimited"` から選べます。審査方式の変更は以後の投稿に適用されます。お題本文を変更すると `discussionRevision` が進み、古い画面からの書き込みは HTTP 409 で拒否されます。通常の受付操作はお題にも利用できます。

運営・参加状態 API はコメントのお題を `discussions` に返します。対象のお題がなければ空の配列を返します。運営用の `questionOrder` は質問集内の位置です。参加側は一度でも開いた質問とお題の中での位置を返します。

## 投稿といいね

| API | 認証 | 入力 |
| --- | --- | --- |
| `GET /api/public/comments` | 参加コード | クエリに `questionId` と任意の `revision`。任意の `X-PochiPoll-Voter` ヘッダーで自分の投稿・いいねを判定 |
| `POST /api/public/comments` | 参加コード | JSON に `sessionId`、`questionId`、`discussionRevision`、`voterToken`、`clientSubmissionId`、`body` |
| `POST /api/public/likes` | 参加コード | JSON に `sessionId`、`questionId`、`discussionRevision`、`voterToken`、`commentId`、真偽値の `liked` |
| `GET /api/admin/comments` | 管理キー | クエリに `questionId` |
| `POST /api/admin/comments/control` | 管理キー | 下記の審査操作 |

投稿はプレーンテキストで300 Unicode コードポイントまでです。再送では同じ送信 ID と本文を使います。受付中に同じ投稿を再送すると、同じコメント ID が返ります。いいねは `liked: true` で設定し、`liked: false` で取り消します。同じ操作を再送しても件数は増減しません。

参加者一覧には公開済みのコメントだけが、いいね数の降順、同数なら投稿順で並びます。受付停止後も公開済みコメントを取得できます。投票・投稿・いいねの短期レート制限は操作ごとに適用し、コメントは1お題200件、1セッション1,000件まで保持します。いいねは1セッション10万件までです。

一覧の応答に含まれる `revision` を次回のクエリに指定すると、変更がない場合は HTTP 204 が返ります。この値は同じセッション・お題・参加者トークンで使います。審査待ちの投稿で公開コメント一覧の値が進むことはありません。

参加画面は選択中のお題の一覧を取得し、投稿に失敗してもページを開いている間は本文を保持します。再送は利用者が行い、同じ本文には同じ送信 ID を使います。投稿本文はブラウザの保存領域に書き込みません。

生の参加者トークンや内部の匿名識別子は応答に含めません。投票集計の CSV と JSON は選択式の結果を返します。API 検証は `npm test` で実行できます。

## P3-3 運営画面と審査操作

機能を有効にした開発用サーバーでは、運営画面の回答形式で「コメント」を選べます。事前審査／即時公開、投稿上限を設定し、選択式とお題を混在したまま編集・並べ替え・質問集 JSON 保存・ブラウザの控えの復元ができます。保存するのは設定だけで、投稿本文・いいね・公開状態は含みません。旧質問集の形式と `fakeslido:deck` の保存キーは維持します。

コメント一覧は「承認待ち／公開中／非公開」に切り替えます。承認待ちには「承認して公開」「非公開」、非公開には「再公開」、公開中には「非公開」を表示します。いずれも確認後の削除が可能です。本文はプレーンテキストとして表示し、HTMLやリンクへ変換しません。取得失敗時には一覧を取り下げ、2.5秒間隔で再取得します。

`POST /api/admin/comments/control` は以下を受け取り、更新後の運営状態を返します。

```json
{
  "sessionId": "現在のセッションID",
  "questionId": "discussion-1",
  "discussionRevision": 1,
  "commentId": "対象のコメントID",
  "action": "publish",
  "expectedVisibility": "pending"
}
```

- `action` は `publish`（承認／再公開）、`hide`（非公開）、`delete`（削除）。削除には `confirm: true` も必須です。
- `expectedVisibility` は運営者が一覧で確認した `pending`／`published`／`hidden`。別タブ等で状態が変わっていれば HTTP 409 を返します。古いセッション・お題リビジョンも HTTP 409、存在しないコメントは HTTP 404 です。競合した操作を自動再送しません。
- 管理認証と同一オリジンを要求し、未知のフィールドや不正な値は拒否します。参加コード・発表トークンでは操作できません。
- 非公開は本文といいねを運営用に保持し、再公開できます。削除は本文・投稿者仮名・送信IDのハッシュ・いいね集合を持つレコードそのものをメモリから除去し、いいね総数も減らします。削除済み ID は再公開できません。削除した分の投稿上限は空き、同じ本文を新たに投稿すること自体を恒久的に禁止する機能ではありません。
- 公開済み本文の非公開・削除、承認・再公開では公開コメント一覧のリビジョンを進めます。承認待ちや非公開だけの変更で公開リビジョンは進みません。
- 「受付を緊急停止」は確認ダイアログなしで選択中のお題の既存 `close` 操作を送ります。投稿といいねを止め、公開一覧の閲覧と運営の審査を続けられます。他のお題の受付は変更しません。

発表用コメント表示・紹介済み・注目表示・コメント結果 JSON は下記の P3-4 で追加しました。

## ローカル検証（P3-3）

Windows / Node.js 24.22.3 で `npm ci`、`npm run typecheck`、`npm run build`、`npm test`（31件）、`npm run test:load`（既存の200参加者の投票負荷試験）を実施しました。Windows の改行変換でも QR ライブラリの固定ハッシュを保つため、`.gitattributes` で対象ファイルの LF を固定しています。

任意のブラウザ自動検証は `test/admin-browser.mjs` です。別途用意した Playwright のモジュールディレクトリを環境変数 `PLAYWRIGHT_MODULE` に指定し、Chrome をインストールした環境でビルド後に `node test/admin-browser.mjs` を実行します。プロジェクトの npm 依存には追加していません。ローカルの一時サーバーと一時的な管理キー、ダミー本文を使用します。

Chrome の自動操作で、お題作成、承認、非公開、再公開、削除のキャンセル／確定、受付停止、設定変更、選択式との混在並べ替え、控えに投稿を含めないこと、再読み込み、HTML文字列の無害表示を確認しました。

**未確認:** 運営者による目視の手動受入、Cloudflare の公開経路、スマートフォン等の別端末、コメント混在の本番相当負荷。これらはローカルの自動検証とは別に実施してください。

## P3-4 発表表示と書き出し

`POST /api/admin/discussions/control` は管理認証・同一オリジンを要求します。全操作に `sessionId`、`questionId`、`discussionRevision` が必要です。古い世代は HTTP 409、未オープンのお題や非公開コメントの指定は HTTP 404 を返します。操作ごとに許さないフィールドも HTTP 400 で拒否します。

| action | 追加フィールド | 動作 |
| --- | --- | --- |
| `list` | なし | お題を発表対象にして一覧へ戻す |
| `focus` | `commentId` | 公開中の1件を注目表示し、そのお題を発表対象にする |
| `set-presented` | `commentId`, 真偽値 `presented` | 公開中のコメントの紹介済みを明示値で設定。再送でも二重反転しない |
| `configure` | 真偽値 `hidePresented`, 真偽値 `freezeOrder` | 紹介済みの一覧除外と発表順固定をお題単位で設定 |

紹介済みは公開状態とは独立です。参加者の公開一覧・いいね対象には残ります。注目中のコメントを紹介済みにしたときは一覧へ戻ります。非公開／削除では注目対象を解除し、順番固定用の ID からも除外します。設定変更・紹介済み操作では他のお題に発表対象を切り替えません。

`GET /api/present/state` は既存の選択式応答を維持し、お題を発表中の場合だけ `discussion` を追加します。このとき `question` は `null`、`mode` は `question` です。

- `discussion` は公開お題の項目に `presentation: { focusedCommentId, hidePresented, freezeOrder }` と `comments` を加えます。
- `comments` の項目は `commentId`, `body`, `likes`, `presented` のみです。サーバーで公開済みだけに絞り、未審査／非公開本文、仮名、生トークン、管理キーを返しません。
- 紹介済みも公開済みである限り配信し、ブラウザで `hidePresented` に従って一覧から除きます。これにより公開権限と表示設定を混同せず、紹介済みだけに約250msの退場演出を付けられます。非公開・削除の除外は演出で遅延させません。
- 固定中は現在の順番を保持し、新規公開は末尾へ追加します。解除するといいね数降順・同数は投稿順に戻ります。参加者の順序は常にいいね順です。
- 公開投稿・いいね・審査による公開範囲の変更・紹介済み・発表設定は発表状態のリビジョンと長期ポーリングに反映します。審査待ちの新規投稿は発表リビジョンを進めません。

`GET /api/admin/export-comments?sessionId=...` は管理者専用です。確認したセッション ID は必須で、別セッションなら HTTP 409 になります。`Content-Disposition` で `pochipoll-comments.json` を指定します。出力形式は次のとおりです。

```json
{
  "format": "pochipoll-comments",
  "version": 1,
  "sessionId": "example-session",
  "exportedAt": "2026-11-19T00:00:00.000Z",
  "topics": [{
    "questionId": "topic-1",
    "questionOrder": 2,
    "questionText": "検証用のお題",
    "settings": { "moderationMode": "manual", "maxPostsPerToken": 3 },
    "comments": [{ "commentId": "example-comment", "text": "検証用の本文", "likes": 1, "presented": true }]
  }]
}
```

`topics` は質問集順（選択式を含めた `questionOrder`）で、コメントは公開済みのみ・いいね順です。紹介済みも含みます。非公開等を追加するオプションはありません。匿名識別子・個別のいいね履歴は出力せず、削除済み本文は復元しません。運営画面では自由記述の取扱いを確認した後に保存し、全消去ダイアログからも同じ処理を利用できます。質問集の再利用用形式と投票集計の形式は変更していません。

### P3-4 の検証と未確認事項

Windows / Node.js 24.22.3 で型チェック・ビルド・36件の API／回帰テスト、既存負荷とコメント混在負荷を確認しました。200参加者の投票と投稿各200件の同時送信、200件のいいね、200コメントの同時取得、変更なし204応答、非公開／削除後の発表と書き出しを検証しています。これはループバックの結果で、公開経路での性能を保証するものではありません。

`test/presentation-browser.mjs` は Chrome で参加投稿→審査→一覧／注目→紹介済み／解除→非公開／削除→JSON保存→選択式への進行を検証します。HTML文字列の無害表示、順番固定、250ms演出、`prefers-reduced-motion`、通信断時の表示取り下げと最新状態への復帰も検証対象です。任意の `PRESENTATION_SCREENSHOT` にファイルパスを指定するとダミー投稿の発表画面だけを保存できます。
