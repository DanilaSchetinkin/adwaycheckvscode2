import * as path from 'path';
import * as vscode from 'vscode';
import { previewDiffAndConfirm } from './changePreview';
import { importHeaderFooterFromUrl } from './headerFooterImport';

let panel: vscode.WebviewPanel | undefined;

export function openHeaderFooterImportPanel(context: vscode.ExtensionContext): void {
    if (panel) {
        panel.reveal(vscode.ViewColumn.Beside);
        return;
    }

    panel = vscode.window.createWebviewPanel(
        'adwayHeaderFooterImport',
        'Adway: Шапка / подвал по ссылке',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.webview.html = getHtml(panel.webview);
    panel.onDidDispose(
        () => {
            panel = undefined;
        },
        null,
        context.subscriptions
    );

    panel.webview.onDidReceiveMessage(
        async (msg: { type?: string; url?: string; header?: boolean; footer?: boolean }) => {
            if (!panel || msg.type !== 'import') {
                return;
            }
            const url = (msg.url || '').trim();
            const wantHeader = !!msg.header;
            const wantFooter = !!msg.footer;
            if (!url) {
                panel.webview.postMessage({ type: 'error', text: 'Вставьте ссылку на сайт' });
                return;
            }
            if (!wantHeader && !wantFooter) {
                panel.webview.postMessage({
                    type: 'error',
                    text: 'Выберите Header и/или Footer'
                });
                return;
            }

            const editor = vscode.window.activeTextEditor;
            let doc =
                editor && /\.html?$/i.test(editor.document.fileName)
                    ? editor.document
                    : vscode.workspace.textDocuments.find(
                          d => d.uri.scheme === 'file' && /\.html?$/i.test(d.fileName)
                      );

            if (!doc || doc.uri.scheme !== 'file') {
                panel.webview.postMessage({
                    type: 'error',
                    text: 'Откройте сохранённый HTML лендинга (index.html)'
                });
                return;
            }

            panel.webview.postMessage({ type: 'busy', busy: true });
            try {
                const htmlDir = path.dirname(doc.uri.fsPath);
                const before = doc.getText();
                const result = await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'Adway: качаем шапку/подвал…',
                        cancellable: false
                    },
                    async () =>
                        importHeaderFooterFromUrl(url, before, htmlDir, {
                            header: wantHeader,
                            footer: wantFooter
                        })
                );

                if (result.html === before) {
                    panel.webview.postMessage({
                        type: 'done',
                        text: 'Изменений в HTML нет. ' + result.warnings.join(' ')
                    });
                    return;
                }

                const ok = await previewDiffAndConfirm({
                    title: `Adway: header/footer ← ${url}`,
                    original: before,
                    proposed: result.html,
                    language: 'html',
                    message:
                        [
                            ...result.notes.slice(0, 6),
                            ...(result.warnings.length
                                ? ['⚠ ' + result.warnings.slice(0, 3).join('; ')]
                                : [])
                        ].join('\n') || 'Применить вставку header/footer?',
                    applyLabel: 'Применить',
                    cancelLabel: 'Отмена',
                    targetUri: doc.uri
                });

                if (!ok) {
                    panel.webview.postMessage({ type: 'done', text: 'Отменено' });
                    return;
                }

                const live = await vscode.workspace.openTextDocument(doc.uri);
                const fullRange = new vscode.Range(
                    live.positionAt(0),
                    live.positionAt(live.getText().length)
                );
                const we = new vscode.WorkspaceEdit();
                we.replace(live.uri, fullRange, result.html);
                await vscode.workspace.applyEdit(we);
                await vscode.window.showTextDocument(live, { preview: false });

                const summary = [
                    `Готово: ${result.created.slice(0, 8).join(', ')}`,
                    result.warnings.length ? `предупреждений: ${result.warnings.length}` : ''
                ]
                    .filter(Boolean)
                    .join(' · ');
                panel.webview.postMessage({ type: 'done', text: summary });
                vscode.window.showInformationMessage(`Adway: ${summary}`);
            } catch (e: unknown) {
                const text = e instanceof Error ? e.message : String(e);
                panel.webview.postMessage({ type: 'error', text });
                vscode.window.showErrorMessage(`Adway header/footer: ${text}`);
            } finally {
                panel.webview.postMessage({ type: 'busy', busy: false });
            }
        },
        undefined,
        context.subscriptions
    );
}

function getHtml(webview: vscode.Webview): string {
    const csp = [
        `default-src 'none'`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `script-src ${webview.cspSource} 'unsafe-inline'`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<title>Header / Footer</title>
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-widget-border, #444);
    --input: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --btn: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
  }
  body {
    margin: 0; padding: 16px;
    font-family: var(--vscode-font-family);
    color: var(--fg); background: var(--bg);
  }
  h1 { font-size: 16px; margin: 0 0 8px; font-weight: 600; }
  p { color: var(--muted); font-size: 12px; line-height: 1.45; margin: 0 0 14px; }
  label { display: block; font-size: 12px; margin-bottom: 4px; }
  input[type=url], input[type=text] {
    width: 100%; box-sizing: border-box;
    background: var(--input); color: var(--input-fg);
    border: 1px solid var(--border); border-radius: 4px;
    padding: 8px; margin-bottom: 12px;
  }
  .row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 14px; }
  .check { display: flex; align-items: center; gap: 6px; font-size: 13px; }
  button {
    background: var(--btn); color: var(--btn-fg); border: none;
    padding: 8px 16px; border-radius: 4px; cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  .msg { margin-top: 12px; font-size: 12px; white-space: pre-wrap; }
  .msg.err { color: var(--vscode-errorForeground); }
</style>
</head>
<body>
  <h1>Шапка / подвал по ссылке</h1>
  <p>Вставь URL сайта-эталона, выбери Header / Footer (или оба). Adway скачает разметку, вырежет стили в <code>css/hdr.css</code> / <code>css/ftr.css</code>, картинки в <code>images/</code> и предложит Compare.</p>
  <p>Работает на статических/SSR страницах. Тяжёлый JS-сайт может отдать пустую шапку — тогда нужен Playwright.</p>

  <label for="url">Ссылка</label>
  <input id="url" type="url" placeholder="https://www.who.int/hungary" />

  <div class="row">
    <label class="check"><input type="checkbox" id="header" checked /> Header (шапка)</label>
    <label class="check"><input type="checkbox" id="footer" checked /> Footer (подвал)</label>
  </div>

  <button id="go">Скачать и вставить</button>
  <div class="msg" id="msg"></div>

<script>
  const vscode = acquireVsCodeApi();
  const msg = document.getElementById('msg');
  const go = document.getElementById('go');
  go.addEventListener('click', () => {
    msg.className = 'msg';
    msg.textContent = 'Запуск…';
    vscode.postMessage({
      type: 'import',
      url: document.getElementById('url').value,
      header: document.getElementById('header').checked,
      footer: document.getElementById('footer').checked
    });
  });
  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'busy') {
      go.disabled = !!m.busy;
    } else if (m.type === 'error') {
      msg.className = 'msg err';
      msg.textContent = m.text || 'Ошибка';
    } else if (m.type === 'done') {
      msg.className = 'msg';
      msg.textContent = m.text || 'Готово';
    }
  });
</script>
</body>
</html>`;
}
