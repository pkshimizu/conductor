/** 画面の中のリンク */

/** タスク詳細の URL */
export function detailPath(issue: number): string {
  return `/tasks/${issue}`;
}

/** 修飾キーの状態（MouseEvent のうち使うところだけ） */
export interface ClickLike {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** 修飾キーなしの左クリックか（それ以外はブラウザに任せ、新しいタブなどで開く） */
export function isPlainClick(event: ClickLike): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}
