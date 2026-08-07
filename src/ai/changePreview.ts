import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Diff «было → будет» (как Compare), затем выбор.
 *
 * Важно:
 * - слева — реальный файл (если передан targetUri), справа — предложение;
 * - подтверждение НЕ modal: иначе нельзя скроллить diff под диалогом.
 */

export type PreviewChoice = 'apply' | 'skip' | 'stop';

const SCHEME = 'adway-diff';

class ProposedContentProvider implements vscode.TextDocumentContentProvider {
    private readonly map = new Map<string, string>();
    private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this.emitter.event;

    set(uri: vscode.Uri, content: string): void {
        this.map.set(uri.toString(), content);
        this.emitter.fire(uri);
    }

    delete(uri: vscode.Uri): void {
        this.map.delete(uri.toString());
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.map.get(uri.toString()) ?? '';
    }
}

let provider: ProposedContentProvider | undefined;
let seq = 0;

export function registerChangePreview(context: vscode.ExtensionContext): void {
    provider = new ProposedContentProvider();
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
        vscode.workspace.onDidOpenTextDocument(async doc => {
            if (doc.uri.scheme !== SCHEME) {
                return;
            }
            const lang = new URLSearchParams(doc.uri.query).get('lang');
            if (lang && doc.languageId !== lang) {
                try {
                    await vscode.languages.setTextDocumentLanguage(doc, lang);
                } catch {
                    /* ignore */
                }
            }
        })
    );
}

function makeProposedUri(label: string, language: string): vscode.Uri {
    seq += 1;
    const safe = label.replace(/[^\w.\-а-яА-ЯёЁ]+/gi, '_').slice(0, 80) || 'file';
    // path выглядит как имя файла → подсветка языка через query
    return vscode.Uri.from({
        scheme: SCHEME,
        path: `/proposed/${seq}-${safe}`,
        query: `lang=${encodeURIComponent(language)}`
    });
}

function makeSnapshotUri(label: string, language: string): vscode.Uri {
    seq += 1;
    const safe = label.replace(/[^\w.\-а-яА-ЯёЁ]+/gi, '_').slice(0, 80) || 'file';
    return vscode.Uri.from({
        scheme: SCHEME,
        path: `/original/${seq}-${safe}`,
        query: `lang=${encodeURIComponent(language)}`
    });
}

export async function previewDiffAndConfirm(opts: {
    title: string;
    original: string;
    proposed: string;
    language: string;
    message: string;
    applyLabel?: string;
    cancelLabel?: string;
    /** Реальный файл слева в Compare (рекомендуется). */
    targetUri?: vscode.Uri;
}): Promise<boolean> {
    const choice = await previewDiffAndChoose({
        ...opts,
        skipLabel: opts.cancelLabel || 'Отмена',
        stopLabel: undefined
    });
    return choice === 'apply';
}

export async function previewDiffAndChoose(opts: {
    title: string;
    original: string;
    proposed: string;
    language: string;
    message: string;
    applyLabel?: string;
    skipLabel?: string;
    stopLabel?: string;
    targetUri?: vscode.Uri;
}): Promise<PreviewChoice> {
    if (!provider) {
        throw new Error('Adway diff: registerChangePreview() не вызван при activate');
    }

    const baseName = opts.targetUri
        ? path.basename(opts.targetUri.fsPath)
        : `file.${opts.language === 'css' ? 'css' : 'html'}`;

    const rightUri = makeProposedUri(baseName, opts.language);
    provider.set(rightUri, opts.proposed);

    let leftUri: vscode.Uri;
    let leftIsVirtual = false;

    if (opts.targetUri) {
        // слева — живой документ / файл на диске
        leftUri = opts.targetUri;
        // если буфер уже отличается от snapshot original — сравниваем snapshot,
        // чтобы diff = ровно то, что уйдёт в Apply
        try {
            const live = await vscode.workspace.openTextDocument(opts.targetUri);
            if (live.getText() !== opts.original) {
                leftUri = makeSnapshotUri(baseName, opts.language);
                provider.set(leftUri, opts.original);
                leftIsVirtual = true;
            }
        } catch {
            leftUri = makeSnapshotUri(baseName, opts.language);
            provider.set(leftUri, opts.original);
            leftIsVirtual = true;
        }
    } else {
        leftUri = makeSnapshotUri(baseName, opts.language);
        provider.set(leftUri, opts.original);
        leftIsVirtual = true;
    }

    // открыть Compare и отдать ему фокус (можно скроллить)
    await vscode.commands.executeCommand(
        'vscode.diff',
        leftUri,
        rightUri,
        opts.title,
        { preview: true, preserveFocus: false }
    );

    // дать UI отрисовать diff до тоста
    await delay(120);

    const applyLabel = opts.applyLabel || 'Применить';
    const skipLabel = opts.skipLabel || 'Пропустить';
    const stopLabel = opts.stopLabel;
    const buttons = stopLabel ? [applyLabel, skipLabel, stopLabel] : [applyLabel, skipLabel];

    // НЕ modal — иначе Cursor/VS Code блокируют просмотр diff
    const pick = await vscode.window.showInformationMessage(
        `${opts.message}\n\nСлева — было, справа — будет. Можно листать diff, потом выбрать действие.`,
        ...buttons
    );

    // убрать виртуальные доки из map (вкладки пользователь может закрыть сам)
    provider.delete(rightUri);
    if (leftIsVirtual) {
        provider.delete(leftUri);
    }

    // вернуть фокус на реальный файл, если он был
    if (opts.targetUri) {
        try {
            const doc = await vscode.workspace.openTextDocument(opts.targetUri);
            await vscode.window.showTextDocument(doc, {
                preview: false,
                preserveFocus: false,
                viewColumn: vscode.ViewColumn.One
            });
        } catch {
            /* ignore */
        }
    }

    if (pick === applyLabel) {
        return 'apply';
    }
    if (stopLabel && pick === stopLabel) {
        return 'stop';
    }
    return 'skip';
}

/** Открыть несколько CSS-diff подряд (без confirm на каждый). */
export async function previewCssDiffs(
    files: Array<{ fileRel: string; before: string; after: string; targetUri?: vscode.Uri }>
): Promise<void> {
    if (!provider) {
        throw new Error('Adway diff: registerChangePreview() не вызван при activate');
    }

    for (const f of files.slice(0, 5)) {
        const rightUri = makeProposedUri(f.fileRel, 'css');
        provider.set(rightUri, f.after);

        let leftUri: vscode.Uri;
        if (f.targetUri) {
            leftUri = f.targetUri;
        } else {
            leftUri = makeSnapshotUri(f.fileRel, 'css');
            provider.set(leftUri, f.before);
        }

        await vscode.commands.executeCommand(
            'vscode.diff',
            leftUri,
            rightUri,
            `Adway CSS: ${f.fileRel} (было ↔ будет)`,
            { preview: true, preserveFocus: false }
        );
        await delay(80);
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
