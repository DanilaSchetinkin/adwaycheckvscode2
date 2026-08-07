import * as path from 'path';
import * as vscode from 'vscode';
import { FORM_SNIPPET } from '../snippetTexts';
import { previewDiffAndConfirm } from './changePreview';
import {
    checkOllamaAvailable,
    getOllamaConfig,
    OllamaMessage,
    ollamaChatMessages
} from './ollamaClient';
import {
    formatTemplateHintsForPrompt,
    getTemplatesStatus,
    loadTemplateHints
} from './templatesLoader';

type ChatTurn = { role: 'user' | 'assistant'; content: string };

type PendingHtmlApply = {
    proposed: string;
    sourceUri?: vscode.Uri;
};

const SYSTEM_BASE = `You are Adway AI Chat — assistant for Adway landing HTML/CSS/JS editors.
Language: answer in the same language as the user (usually Russian).

You help with:
- free Adway order form (action="/order.php", method="post", hidden fbpx/utm_code/cid/sid/hash/country, name+phone required, id="oneform" nearby)
- removing extra sections that don't belong on a free/simple land
- finding conflicting / duplicate / leftover CSS (old player, competing form styles, !important wars)
- free video player (#container_video), paths images/css/js/media

Rules:
1) Prefer concrete, actionable advice tied to the CURRENT HTML (and selection if any).
2) If you propose a full file or large HTML rewrite, put it in ONE fenced block:
\`\`\`html
...full or large fragment...
\`\`\`
The editor can Apply that block via Compare. Do not invent filenames inside the fence.
3) For CSS conflicts: list selectors/files and why they conflict; optionally propose cleaned CSS in \`\`\`css.
4) Keep answers short when asking questions; when editing, be precise.
5) Do NOT claim you already changed the file — only the user applies via the UI.
6) Small 3B models: if the HTML is huge, focus on form/section/CSS hotspots, not rewriting 10k lines blindly.`;

let panel: vscode.WebviewPanel | undefined;
let history: ChatTurn[] = [];
let pendingApply: PendingHtmlApply | undefined;

export function openAdwayAiChat(context: vscode.ExtensionContext): void {
    if (panel) {
        panel.reveal(vscode.ViewColumn.Beside);
        void postStatus();
        return;
    }

    panel = vscode.window.createWebviewPanel(
        'adwayAiChat',
        'Adway AI Chat',
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    panel.webview.html = getWebviewHtml(panel.webview);
    panel.onDidDispose(
        () => {
            panel = undefined;
            history = [];
            pendingApply = undefined;
        },
        null,
        context.subscriptions
    );

    panel.webview.onDidReceiveMessage(
        async (msg: { type?: string; text?: string }) => {
            if (!panel) {
                return;
            }
            switch (msg.type) {
                case 'ready':
                    await postStatus();
                    panel.webview.postMessage({ type: 'history', turns: history });
                    break;
                case 'clear':
                    history = [];
                    pendingApply = undefined;
                    panel.webview.postMessage({ type: 'history', turns: [] });
                    panel.webview.postMessage({ type: 'pendingApply', has: false });
                    break;
                case 'send':
                    await handleSend((msg.text || '').trim());
                    break;
                case 'applyHtml':
                    await handleApplyHtml();
                    break;
                default:
                    break;
            }
        },
        undefined,
        context.subscriptions
    );

    void postStatus();
}

async function postStatus(): Promise<void> {
    if (!panel) {
        return;
    }
    const ollama = await checkOllamaAvailable();
    const templates = getTemplatesStatus();
    const doc = getActiveHtmlDoc();
    panel.webview.postMessage({
        type: 'status',
        ollamaOk: ollama.ok,
        ollamaMsg: ollama.message,
        templatesMsg: templates.message,
        file: doc ? path.basename(doc.fileName) : '(нет HTML)',
        model: getOllamaConfig().model
    });
}

function getActiveHtmlDoc(): vscode.TextDocument | undefined {
    const ed = vscode.window.activeTextEditor;
    if (ed && /\.html?$/i.test(ed.document.fileName)) {
        return ed.document;
    }
    // любой открытый html
    for (const d of vscode.workspace.textDocuments) {
        if (d.uri.scheme === 'file' && /\.html?$/i.test(d.fileName)) {
            return d;
        }
    }
    return undefined;
}

function shrinkForChat(html: string, max = 14000): string {
    if (html.length <= max) {
        return html;
    }
    const head = html.slice(0, Math.floor(max * 0.35));
    const midStart = Math.max(0, Math.floor(html.length / 2) - Math.floor(max * 0.15));
    const mid = html.slice(midStart, midStart + Math.floor(max * 0.3));
    const tail = html.slice(-Math.floor(max * 0.35));
    return `${head}\n\n<!-- … truncated for AI context … -->\n\n${mid}\n\n<!-- … truncated … -->\n\n${tail}`;
}

function buildContextBlock(): string {
    const doc = getActiveHtmlDoc();
    const ed = vscode.window.activeTextEditor;
    const parts: string[] = [];

    parts.push('### Adway free form reference (target shape)\n```html\n' + FORM_SNIPPET + '\n```');

    const freeHints = loadTemplateHints('freePlayer', 1, 2500);
    const landHints = loadTemplateHints('landing', 1, 2500);
    const hints = [...freeHints, ...landHints];
    if (hints.length) {
        parts.push(formatTemplateHintsForPrompt(hints));
    }

    if (doc) {
        const html = doc.getText();
        parts.push(
            `### Current file: ${path.basename(doc.fileName)} (${html.length} chars)\n\`\`\`html\n${shrinkForChat(html)}\n\`\`\``
        );
        if (ed && ed.document === doc && !ed.selection.isEmpty) {
            const sel = ed.document.getText(ed.selection);
            if (sel.trim().length > 0 && sel.length < 8000) {
                parts.push(`### Current selection\n\`\`\`html\n${sel}\n\`\`\``);
            }
        }
    } else {
        parts.push('### Current file\n(no HTML open — answer generally; ask user to open a land)');
    }

    return parts.join('\n\n');
}

function extractHtmlCandidate(reply: string): string | undefined {
    const re = /```(?:html|htm)?\s*\n([\s\S]*?)```/gi;
    let best: string | undefined;
    let m: RegExpExecArray | null;
    while ((m = re.exec(reply))) {
        const body = (m[1] || '').trim();
        if (body.length < 80) {
            continue;
        }
        // полный документ или крупный фрагмент с form/section
        if (
            /<!doctype|<html\b|<form\b|<section\b|<body\b/i.test(body) ||
            body.length > 400
        ) {
            if (!best || body.length > best.length) {
                best = body;
            }
        }
    }
    return best;
}

async function handleSend(text: string): Promise<void> {
    if (!panel || !text) {
        return;
    }

    const status = await checkOllamaAvailable();
    if (!status.ok) {
        panel.webview.postMessage({
            type: 'error',
            text: status.message
        });
        return;
    }

    history.push({ role: 'user', content: text });
    panel.webview.postMessage({ type: 'history', turns: history });
    panel.webview.postMessage({ type: 'busy', busy: true });

    const config = getOllamaConfig();
    const messages: OllamaMessage[] = [
        { role: 'system', content: SYSTEM_BASE + '\n\n' + buildContextBlock() }
    ];
    // последние реплики без раздувания (контекст HTML уже в system)
    const recent = history.slice(-8);
    for (const t of recent) {
        messages.push({ role: t.role, content: t.content });
    }

    try {
        const reply = await ollamaChatMessages(messages, config, {
            formatJson: false,
            temperature: 0.25,
            numPredict: 3072
        });
        history.push({ role: 'assistant', content: reply });

        const html = extractHtmlCandidate(reply);
        const doc = getActiveHtmlDoc();
        if (html && doc) {
            pendingApply = { proposed: html, sourceUri: doc.uri };
        } else {
            pendingApply = undefined;
        }

        panel.webview.postMessage({ type: 'history', turns: history });
        panel.webview.postMessage({
            type: 'pendingApply',
            has: !!pendingApply,
            hint: pendingApply
                ? 'В ответе есть HTML-блок — можно открыть Compare и применить'
                : ''
        });
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        history.push({
            role: 'assistant',
            content: `⚠️ Ошибка Ollama: ${msg}`
        });
        panel.webview.postMessage({ type: 'history', turns: history });
        panel.webview.postMessage({ type: 'error', text: msg });
    } finally {
        panel.webview.postMessage({ type: 'busy', busy: false });
        await postStatus();
    }
}

async function handleApplyHtml(): Promise<void> {
    if (!pendingApply) {
        vscode.window.showWarningMessage('Adway AI Chat: нет HTML для применения');
        return;
    }

    let doc = getActiveHtmlDoc();
    if (pendingApply.sourceUri) {
        try {
            doc = await vscode.workspace.openTextDocument(pendingApply.sourceUri);
        } catch {
            /* keep getActiveHtmlDoc */
        }
    }
    if (!doc) {
        vscode.window.showErrorMessage('Откройте HTML файл для применения');
        return;
    }

    const original = doc.getText();
    let proposed = pendingApply.proposed;

    // если ИИ вернул только <form>… — заменить первую форму в документе
    if (/^\s*<form\b/i.test(proposed) && !/<html\b/i.test(proposed)) {
        const formRe = /<form\b[\s\S]*?<\/form>/i;
        if (formRe.test(original)) {
            proposed = original.replace(formRe, proposed);
        } else {
            vscode.window.showWarningMessage(
                'В ответе только <form>, а в файле формы нет — вставлю в конец <body> не буду. Попросите полный HTML или откройте место вставки.'
            );
            return;
        }
    }

    if (proposed === original) {
        vscode.window.showInformationMessage('Adway AI Chat: изменений нет');
        return;
    }

    const ok = await previewDiffAndConfirm({
        title: `Adway AI Chat: ${path.basename(doc.fileName)} (было ↔ будет)`,
        original,
        proposed,
        language: 'html',
        message: 'Применить правку от Adway AI Chat к файлу?',
        applyLabel: 'Применить',
        cancelLabel: 'Отмена',
        targetUri: doc.uri
    });

    if (!ok) {
        return;
    }

    const live =
        vscode.workspace.textDocuments.find(d => d.uri.toString() === doc!.uri.toString()) ||
        (await vscode.workspace.openTextDocument(doc.uri));
    const fullRange = new vscode.Range(live.positionAt(0), live.positionAt(live.getText().length));
    const we = new vscode.WorkspaceEdit();
    we.replace(live.uri, fullRange, proposed);
    const applied = await vscode.workspace.applyEdit(we);
    if (applied) {
        await vscode.window.showTextDocument(live, { preview: false, preserveFocus: false });
        vscode.window.showInformationMessage('Adway AI Chat: правки применены');
        pendingApply = undefined;
        panel?.webview.postMessage({ type: 'pendingApply', has: false });
    } else {
        vscode.window.showErrorMessage('Adway AI Chat: не удалось применить');
    }
}

function getWebviewHtml(webview: vscode.Webview): string {
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
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Adway AI Chat</title>
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
    --btn2: var(--vscode-button-secondaryBackground);
    --btn2-fg: var(--vscode-button-secondaryForeground);
    --user: color-mix(in srgb, var(--vscode-button-background) 22%, transparent);
    --bot: color-mix(in srgb, var(--vscode-editor-foreground) 8%, transparent);
    --err: var(--vscode-errorForeground);
  }
  * { box-sizing: border-box; }
  html, body {
    height: 100%; margin: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--fg); background: var(--bg);
  }
  .wrap { display: flex; flex-direction: column; height: 100%; }
  .status {
    padding: 8px 12px; border-bottom: 1px solid var(--border);
    font-size: 12px; color: var(--muted); line-height: 1.4;
  }
  .status strong { color: var(--fg); font-weight: 600; }
  .chips {
    display: flex; flex-wrap: wrap; gap: 6px;
    padding: 8px 12px; border-bottom: 1px solid var(--border);
  }
  .chip {
    border: 1px solid var(--border); background: transparent; color: var(--fg);
    border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 12px;
  }
  .chip:hover { background: var(--bot); }
  .log {
    flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px;
  }
  .msg {
    max-width: 95%; padding: 8px 10px; border-radius: 6px;
    white-space: pre-wrap; word-break: break-word; line-height: 1.45;
  }
  .msg.user { align-self: flex-end; background: var(--user); }
  .msg.assistant { align-self: flex-start; background: var(--bot); border: 1px solid var(--border); }
  .msg .role { font-size: 11px; color: var(--muted); margin-bottom: 4px; }
  .composer {
    border-top: 1px solid var(--border); padding: 10px 12px;
    display: flex; flex-direction: column; gap: 8px;
  }
  textarea {
    width: 100%; min-height: 72px; resize: vertical;
    background: var(--input); color: var(--input-fg);
    border: 1px solid var(--border); border-radius: 4px;
    padding: 8px; font-family: inherit; font-size: inherit;
  }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  button.primary {
    background: var(--btn); color: var(--btn-fg); border: none;
    padding: 6px 14px; border-radius: 4px; cursor: pointer;
  }
  button.secondary {
    background: var(--btn2); color: var(--btn2-fg); border: none;
    padding: 6px 12px; border-radius: 4px; cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  .err { color: var(--err); font-size: 12px; padding: 0 12px 8px; }
  .hint { font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <div class="status" id="status">Загрузка…</div>
  <div class="chips">
    <button class="chip" data-q="Замени форму на бесплатную Adway (order.php, hidden-поля, name+phone, oneform). Сохрани тексты/язык если возможно.">Форма бесплатного лэнда</button>
    <button class="chip" data-q="Удали лишние секции для простого бесплатного лэнда: оставь нужные для оффера/формы/видео, убери мусорные блоки. Объясни что убрал и верни HTML в блоке \`\`\`html если правишь файл.">Удалить лишние секции</button>
    <button class="chip" data-q="Найди стили которые конфликтуют с формой или плеером (дубли, старый video-js/hermes, !important, перекрытия). Списком: селектор → проблема → что сделать.">Конфликтующие стили</button>
  </div>
  <div class="log" id="log"></div>
  <div class="err" id="err" hidden></div>
  <div class="composer">
    <textarea id="input" placeholder="Спроси про текущий HTML… (контекст файла подставится сам)"></textarea>
    <div class="row">
      <button class="primary" id="send">Отправить</button>
      <button class="secondary" id="apply" disabled>Compare → Применить HTML</button>
      <button class="secondary" id="clear">Очистить</button>
      <span class="hint" id="applyHint"></span>
    </div>
  </div>
</div>
<script>
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const status = document.getElementById('status');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const applyBtn = document.getElementById('apply');
  const clearBtn = document.getElementById('clear');
  const applyHint = document.getElementById('applyHint');
  const errEl = document.getElementById('err');
  let busy = false;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function render(turns) {
    log.innerHTML = '';
    for (const t of turns || []) {
      const div = document.createElement('div');
      div.className = 'msg ' + t.role;
      div.innerHTML = '<div class="role">' + (t.role === 'user' ? 'Вы' : 'Adway AI') + '</div>' + esc(t.content);
      log.appendChild(div);
    }
    log.scrollTop = log.scrollHeight;
  }

  function setBusy(v) {
    busy = v;
    sendBtn.disabled = v;
    input.disabled = v;
  }

  sendBtn.addEventListener('click', () => {
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    vscode.postMessage({ type: 'send', text });
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendBtn.click();
    }
  });
  applyBtn.addEventListener('click', () => vscode.postMessage({ type: 'applyHtml' }));
  clearBtn.addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
  document.querySelectorAll('.chip').forEach(btn => {
    btn.addEventListener('click', () => {
      input.value = btn.getAttribute('data-q') || '';
      input.focus();
    });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'status') {
      const ok = msg.ollamaOk ? 'OK' : 'нет';
      status.innerHTML = '<strong>Ollama:</strong> ' + esc(msg.ollamaMsg || ok)
        + ' · <strong>файл:</strong> ' + esc(msg.file || '')
        + ' · <strong>модель:</strong> ' + esc(msg.model || '')
        + '<br/>' + esc(msg.templatesMsg || '');
    } else if (msg.type === 'history') {
      render(msg.turns);
    } else if (msg.type === 'busy') {
      setBusy(!!msg.busy);
    } else if (msg.type === 'pendingApply') {
      applyBtn.disabled = !msg.has;
      applyHint.textContent = msg.hint || '';
    } else if (msg.type === 'error') {
      errEl.hidden = false;
      errEl.textContent = msg.text || 'Ошибка';
      setTimeout(() => { errEl.hidden = true; }, 8000);
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
