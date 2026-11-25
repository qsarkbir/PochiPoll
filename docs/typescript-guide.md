# PochiPoll の TypeScript 学習ガイド

PochiPoll のアプリ本体は TypeScript で書きます。`npm run build` を実行すると、Node.js とブラウザが読み込む JavaScript が `dist/` に生成されます。ソースを変更するときは `src/` を編集します。相対 import の末尾には、実行時に解決される `.js` を指定します。

## どのファイルから読むか

| ファイル | 読むと分かること |
| --- | --- |
| [src/types.ts](../src/types.ts) | 質問、集計、認証ロール、API の入出力 |
| [src/server.ts](../src/server.ts) | HTTP リクエストの受付、権限の検査、レスポンス |
| [src/session.ts](../src/session.ts) | 質問と投票の検証、メモリ内の状態、画面ごとの公開範囲 |
| [src/public/common.ts](../src/public/common.ts) | DOM 操作、API リクエスト、状態のポーリング |
| [src/public/admin.ts](../src/public/admin.ts) | 運営画面、質問集の編集・読み込み・保存 |
| [src/public/participate.ts](../src/public/participate.ts) | 投票、回答変更、ブラウザに残す回答の控え |
| [src/public/present.ts](../src/public/present.ts)・[charts.ts](../src/public/charts.ts) | 発表画面、QR コード、集計グラフ |

## 型の基礎

`let sending = false` と書くと、コンパイラは `sending` を `boolean` と推論します。`let choices: number[] = []` では、空の配列に今後入る値を数値として明示します。投票のコードでこの違いを確認できます。

`interface` はオブジェクトの構造を記述します。たとえば `VoteReceipt` は、投票 API が返す `sessionId` と `voteRevision` を定義しています。`type` はオブジェクトのほか候補の組み合わせにも使えます。`QuestionType` は次の二つの文字列に限ったユニオン型です。

```ts
type QuestionType = 'single' | 'multiple';
```

`ControlInput` では、`action` の値ごとに必要な項目が変わります。`action: 'erase'` なら `confirm: true` と消去対象の `sessionId` が必要です。このように共通の項目で型を特定できる組み合わせを、判別可能なユニオン型と呼びます。運営画面がどちらかを省いて全消去をリクエストすると、型エラーになります。

## 投票を例にたどる

1. 参加画面は選択済みの番号を `number[]` で持ちます。単一選択は一つの番号、複数選択は番号の配列を送るため、`VoteInput.choices` の型は `number | number[]` です。
2. ブラウザの `request` は API のパスから送信データと戻り値の型を選びます。戻り値は `Promise` なので、`await` すると応答を使える状態になります。通信エラーは `catch` で受け、`error instanceof RequestError` で HTTP ステータスを参照できる型に絞り込みます。
3. サーバーは受け取った JSON を `unknown` として扱い、値と現在の質問の状態を実行時に検証します。たとえば `typeof voteRevision === 'number'` で型を絞り、正の整数か、現在の質問と一致するかを順に確認します。TypeScript の型はコンパイル時に使われるため、外部から直接送られた JSON を検証するにはこの処理が必要です。
4. `PollSession` は票を `Map<string, number[]>` に保持します。キーは質問ごとの匿名の識別子、値は選択肢の番号です。同じキーに再投票すると値が置き換わります。複数選択で空配列を受理するとキーごと削除し、回答者数からも除きます。選択肢の重複は `Set` に入れたあとの要素数で確認します。API には画面ごとの項目や集計値だけを返します。

## DOM とブラウザ保存

`document.getElementById` の戻り値には `null` が含まれます。共通関数 `$('question-type', HTMLSelectElement)` は要素の存在と種類を確かめるので、その結果から `value` を読み取れます。`el('input')` では、タグ名から入力要素の型を推論します。

旧質問集の `fakeslido-deck` バージョン1と、ブラウザの `fakeslido:deck`・`fakeslido:participant` のキーは継続して使えます。保存済み JSON はネットワーク入力と同じく `unknown` として読み、必要な構造を確かめます。質問ごとの詳しい検証はサーバーが行います。

## 実行と検証

Node.js 24 を使い、リポジトリのルートで実行します。

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run test:load
npm start
```

`typecheck` はファイルを出力せずに型だけを検査します。`build` は `dist/` を作り直し、HTML・CSS・SVG・同梱の QR ライブラリもコピーします。両テストコマンドはビルドからやり直します。運営画面は起動時に表示される URL で開きます。HTTPS 公開の手順は [README](../README.md) を参照してください。
