import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { previewCssDiffs, previewDiffAndChoose } from './changePreview';
import { CheckResult, stripHtml } from './checkTypes';
import { buildFixEdit, FixId } from './codeActions';
import { moveLinksToHead } from './cleanup';
import { AdwayDiagnosticCodes, detectCode } from './diagnostics';
import { findMissingLocalPaths, previewCssLocalPathFixes } from './filePaths';
import { findExtensionlessAssets } from './extensionlessAssets';
import { removeScriptSrcTag } from './scriptAssets';
import { setupAdwayVideoPlayer } from './videoPlayer';

export type WizardStepKind =
    | 'fixId'
    | 'moveLinks'
    | 'paths'
    | 'extensionless'
    | 'video'
    | 'downloadImages'
    | 'removeMissingScript';

export type WizardStep = {
    /** Ключ дедупа */
    id: string;
    title: string;
    detail: string;
    kind: WizardStepKind;
    fixId?: FixId;
    line?: number;
    code?: string;
};

const FORM_CODES = new Set<string>([
    AdwayDiagnosticCodes.hidden,
    AdwayDiagnosticCodes.forms,
    AdwayDiagnosticCodes.method,
    AdwayDiagnosticCodes.action,
    AdwayDiagnosticCodes.requiredName,
    AdwayDiagnosticCodes.requiredPhone
]);

const VIDEO_CODES = new Set<string>([
    AdwayDiagnosticCodes.videoHermes,
    AdwayDiagnosticCodes.videoVideojs,
    AdwayDiagnosticCodes.videoBlob,
    AdwayDiagnosticCodes.videoCss,
    AdwayDiagnosticCodes.videoJs,
    AdwayDiagnosticCodes.videoMediaPath,
    AdwayDiagnosticCodes.videoFormInside
]);

const STEP_ORDER = [
    'doctype',
    'base',
    'moveLinks',
    'flattenPicture',
    'removeTarget',
    'hrefNormalize',
    'paths',
    'extensionless',
    'jquery',
    'lazy',
    'scroll',
    'oneform',
    'validationReplaceName',
    'validation',
    'fixForm',
    'removeMissingScript',
    'video',
    'downloadImages'
];

/** Применить WorkspaceEdit к тексту документа (без записи). */
export function applyWorkspaceEditToString(
    document: vscode.TextDocument,
    edit: vscode.WorkspaceEdit
): string | null {
    const edits = edit.get(document.uri);
    if (!edits || edits.length === 0) {
        return null;
    }
    const sorted = [...edits].sort((a, b) => {
        const byStart = b.range.start.compareTo(a.range.start);
        if (byStart !== 0) {
            return byStart;
        }
        return b.range.end.compareTo(a.range.end);
    });
    let text = document.getText();
    // offsets from original document
    for (const e of sorted) {
        const start = document.offsetAt(e.range.start);
        const end = document.offsetAt(e.range.end);
        text = text.slice(0, start) + e.newText + text.slice(end);
    }
    return text;
}

function plainMessage(r: CheckResult): string {
    return stripHtml(r.text).replace(/[✅❌⚠️]/g, '').trim();
}

export function buildWizardSteps(results: CheckResult[]): WizardStep[] {
    const map = new Map<string, WizardStep>();

    for (const r of results) {
        if (r.success === true) {
            continue;
        }
        const msg = plainMessage(r);
        const code = detectCode(msg);
        if (!code) {
            continue;
        }

        const add = (step: WizardStep) => {
            const prev = map.get(step.id);
            if (prev) {
                prev.detail = `${prev.detail}\n• ${msg}`;
                if (prev.line === undefined && r.line !== undefined) {
                    prev.line = r.line;
                }
                return;
            }
            map.set(step.id, { ...step, detail: `• ${msg}` });
        };

        if (FORM_CODES.has(code)) {
            add({
                id: 'fixForm',
                title: 'Починить форму заказа',
                detail: '',
                kind: 'fixId',
                fixId: 'fixForm',
                line: r.line,
                code
            });
            continue;
        }
        if (VIDEO_CODES.has(code)) {
            add({
                id: 'video',
                title: 'Установить бесплатный видео-плеер',
                detail: '',
                kind: 'video',
                line: r.line,
                code
            });
            continue;
        }

        switch (code) {
            case AdwayDiagnosticCodes.doctype:
                add({
                    id: 'doctype',
                    title: 'Вставить <!DOCTYPE html>',
                    detail: '',
                    kind: 'fixId',
                    fixId: 'doctype',
                    line: r.line,
                    code
                });
                break;
            case AdwayDiagnosticCodes.base:
                add({
                    id: 'base',
                    title: 'Удалить <base>',
                    detail: '',
                    kind: 'fixId',
                    fixId: 'base',
                    line: r.line,
                    code
                });
                break;
            case AdwayDiagnosticCodes.linkOutsideHead:
                add({
                    id: 'moveLinks',
                    title: 'Перенести <link> в <head>',
                    detail: '',
                    kind: 'moveLinks',
                    line: r.line,
                    code
                });
                break;
            case AdwayDiagnosticCodes.picture:
                add({
                    id: 'flattenPicture',
                    title: 'Убрать <source> из <picture>',
                    detail: '',
                    kind: 'fixId',
                    fixId: 'flattenPicture',
                    line: r.line,
                    code
                });
                break;
            case AdwayDiagnosticCodes.target:
                add({
                    id: 'removeTarget',
                    title: 'Удалить target=',
                    detail: '',
                    kind: 'fixId',
                    fixId: 'removeTarget',
                    line: r.line,
                    code
                });
                break;
            case AdwayDiagnosticCodes.href:
                add({
                    id: 'hrefNormalize',
                    title: 'Нормализовать href → #',
                    detail: '',
                    kind: 'fixId',
                    fixId: 'hrefNormalize',
                    line: r.line,
                    code
                });
                break;
            case AdwayDiagnosticCodes.localPath:
                add({
                    id: 'paths',
                    title: 'Исправить локальные пути (HTML + CSS)',
                    detail: '',
                    kind: 'paths',
                    line: r.line,
                    code
                });
                break;
            case AdwayDiagnosticCodes.extensionless:
                add({
                    id: 'extensionless',
                    title: 'Восстановить расширения ассетов',
                    detail: '',
                    kind: 'extensionless',
                    line: r.line,
                    code
                });
                break;
            case AdwayDiagnosticCodes.jquery:
                add({
                    id: 'jquery',
                    title: 'Вставить jQuery 3.6.0',
                    detail: '',
                    kind: 'fixId',
                    fixId: 'jquery',
                    line: r.line,
                    code
                });
                break;
            case AdwayDiagnosticCodes.lazy:
                add({
                    id: 'lazy',
                    title: 'Вставить lazy loading',
                    detail: '',
                    kind: 'fixId',
                    fixId: 'lazy',
                    line: r.line,
                    code
                });
                break;
            case AdwayDiagnosticCodes.scroll:
                add({
                    id: 'scroll',
                    title: 'Вставить скрипт прокрутки',
                    detail: '',
                    kind: 'fixId',
                    fixId: 'scroll',
                    line: r.line,
                    code
                });
                break;
            case AdwayDiagnosticCodes.oneform:
                add({
                    id: 'oneform',
                    title: 'Добавить id="oneform"',
                    detail: '',
                    kind: 'fixId',
                    fixId: 'oneform',
                    line: r.line,
                    code
                });
                break;
            case AdwayDiagnosticCodes.validationOld:
                add({
                    id: 'validationReplaceName',
                    title: 'Обновить валидатор имени',
                    detail: '',
                    kind: 'fixId',
                    fixId: 'validationReplaceName',
                    line: r.line,
                    code
                });
                break;
            case AdwayDiagnosticCodes.validationMissing:
                add({
                    id: 'validation',
                    title: 'Вставить валидаторы',
                    detail: '',
                    kind: 'fixId',
                    fixId: 'validation',
                    line: r.line,
                    code
                });
                break;
            case AdwayDiagnosticCodes.scriptMissing:
                add({
                    id: 'removeMissingScript',
                    title: 'Удалить битые <script src>',
                    detail: '',
                    kind: 'removeMissingScript',
                    line: r.line,
                    code
                });
                break;
            case AdwayDiagnosticCodes.externalImage:
                add({
                    id: 'downloadImages',
                    title: 'Скачать внешние изображения',
                    detail: '',
                    kind: 'downloadImages',
                    line: r.line,
                    code
                });
                break;
            default:
                break;
        }
    }

    const steps = [...map.values()];
    steps.sort((a, b) => {
        const ia = STEP_ORDER.indexOf(a.id);
        const ib = STEP_ORDER.indexOf(b.id);
        return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
    return steps;
}

type Proposed = {
    html?: string;
    css?: Array<{ fileRel: string; absPath: string; before: string; after: string }>;
    note?: string;
    /** Только подтверждение + команда, без HTML-diff */
    commandOnly?: string;
};

function computeProposed(document: vscode.TextDocument, step: WizardStep): Proposed | null {
    const html = document.getText();
    const htmlDir =
        document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : undefined;

    switch (step.kind) {
        case 'fixId': {
            if (!step.fixId) {
                return null;
            }
            const edit = buildFixEdit(document, step.fixId, step.line ?? 0);
            if (!edit) {
                return null;
            }
            const next = applyWorkspaceEditToString(document, edit);
            if (!next || next === html) {
                return null;
            }
            return { html: next };
        }
        case 'moveLinks': {
            const { html: next, moved } = moveLinksToHead(html);
            if (moved === 0 || next === html) {
                return null;
            }
            return { html: next, note: `перенесено link: ${moved}` };
        }
        case 'paths': {
            if (!htmlDir) {
                return null;
            }
            const pathResult = computeHtmlPathFixes(document);
            const css = previewCssLocalPathFixes(html, htmlDir).map(c => ({
                fileRel: c.fileRel,
                absPath: c.absPath,
                before: c.before,
                after: c.after
            }));
            if ((!pathResult || pathResult === html) && css.length === 0) {
                return null;
            }
            return {
                html: pathResult && pathResult !== html ? pathResult : html,
                css,
                note: css.length ? `CSS файлов: ${css.length}` : undefined
            };
        }
        case 'extensionless': {
            if (!htmlDir) {
                return null;
            }
            const found = findExtensionlessAssets(htmlDir);
            if (!found.length) {
                return null;
            }
            return {
                note: `${found.length} файл(ов): ${found
                    .slice(0, 5)
                    .map(f => `${f.relPath}→.${f.kind}`)
                    .join('; ')}`,
                commandOnly: 'adway.fixExtensionlessAssets'
            };
        }
        case 'video': {
            if (!htmlDir) {
                return { note: 'Сохраните HTML на диск', commandOnly: 'adway.setupVideoPlayer' };
            }
            const result = setupAdwayVideoPlayer(html, htmlDir, {
                writeAssets: false,
                cleanup: false
            });
            if (result.html === html) {
                return {
                    note: result.notes.slice(0, 3).join('; ') || 'HTML без изменений (assets?)',
                    commandOnly: 'adway.setupVideoPlayer'
                };
            }
            return {
                html: result.html,
                note: [...result.created, ...result.notes].slice(0, 5).join('; ')
            };
        }
        case 'downloadImages':
            return {
                note: 'Скачает внешние картинки в images/ и обновит src',
                commandOnly: 'adway.downloadExternalImages'
            };
        case 'removeMissingScript': {
            // удалить все script src с «не найден» — эвристика: теги на удалённые локальные пути
            // упрощённо: пользователь подтвердит diff по одному паттерну из detail
            const srcMatch = step.detail.match(/js\/[^\s"'<>]+\.js/i);
            if (!srcMatch) {
                return {
                    note: 'Выберите скрипт вручную (команда Удалить тег script)',
                    commandOnly: 'adway.removeMissingScriptTag'
                };
            }
            const { html: next, removed } = removeScriptSrcTag(html, srcMatch[0]);
            if (removed === 0) {
                return null;
            }
            return { html: next, note: `удалить тег: ${srcMatch[0]}` };
        }
        default:
            return null;
    }
}

/** HTML-правки путей без записи CSS. */
function computeHtmlPathFixes(document: vscode.TextDocument): string | null {
    if (document.uri.scheme !== 'file') {
        return null;
    }
    const html = document.getText();
    const htmlDir = path.dirname(document.uri.fsPath);
    const issues = findMissingLocalPaths(html, htmlDir).filter(i => i.suggestedUrl && !i.cssFile);
    if (issues.length === 0) {
        return null;
    }
    const sorted = [...issues].sort((a, b) => html.lastIndexOf(a.search) - html.lastIndexOf(b.search));
    let current = html;
    let changed = false;
    for (const issue of sorted) {
        if (!issue.suggestedUrl) {
            continue;
        }
        const quoteMatch = issue.search.match(
            /^(src|href|srcset|poster|data)\s*=\s*(["'])([\s\S]*)\2$/i
        );
        if (quoteMatch) {
            const attr = quoteMatch[1];
            const q = quoteMatch[2];
            const value = quoteMatch[3];
            const nextAttr =
                /^srcset$/i.test(attr) && value.includes(issue.url)
                    ? `${attr}=${q}${value.replace(issue.url, issue.suggestedUrl)}${q}`
                    : `${attr}=${q}${issue.suggestedUrl}${q}`;
            if (current.includes(issue.search)) {
                current = current.replace(issue.search, nextAttr);
                changed = true;
                continue;
            }
        }
        if (issue.search.startsWith('url(') && current.includes(issue.search)) {
            current = current.replace(
                issue.search,
                issue.search.replace(issue.url, issue.suggestedUrl)
            );
            changed = true;
            continue;
        }
        if (current.includes(issue.url)) {
            current = current.replace(issue.url, issue.suggestedUrl);
            changed = true;
        }
    }
    return changed ? current : null;
}

async function applyHtmlToDocument(document: vscode.TextDocument, next: string): Promise<boolean> {
    const current = document.getText();
    if (current === next) {
        return true;
    }
    const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(current.length)
    );
    const we = new vscode.WorkspaceEdit();
    we.replace(document.uri, fullRange, next);
    const ok = await vscode.workspace.applyEdit(we);
    if (!ok) {
        return false;
    }
    // Вернуть фокус на реальный файл (иначе кажется, что Apply не сработал —
    // на экране остаётся ephemeral Compare).
    try {
        await vscode.window.showTextDocument(document, {
            preview: false,
            preserveFocus: false,
            viewColumn: vscode.ViewColumn.One
        });
    } catch {
        // ignore
    }
    return true;
}

/**
 * Мастер: все ошибки чекера по пунктам с Compare.
 */
export async function runFixWizard(
    editor: vscode.TextEditor,
    refreshDiagnostics: (doc: vscode.TextDocument) => Promise<void>
): Promise<void> {
    if (editor.document.languageId !== 'html') {
        vscode.window.showErrorMessage('Откройте HTML файл');
        return;
    }

    const targetUri = editor.document.uri;

    const results = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Adway: проверка для мастера правок…',
            cancellable: false
        },
        async () => {
            const doc = await vscode.workspace.openTextDocument(targetUri);
            const { LandingChecker } = await import('./checkHost');
            return new LandingChecker(doc).check();
        }
    );

    const steps = buildWizardSteps(results);
    if (steps.length === 0) {
        const failing = results.filter(r => r.success !== true).length;
        vscode.window.showInformationMessage(
            failing
                ? `Adway: ошибок/варнингов: ${failing}, но автофиксов нет (SID, внешний CSS/JS и т.п.)`
                : 'Adway: исправлять нечего — проверка чистая'
        );
        return;
    }

    const start = await vscode.window.showQuickPick(
        [
            {
                label: `Начать мастер (${steps.length} пункт(ов))`,
                description: 'Compare по каждому → Применить / Пропустить / Стоп',
                id: 'go'
            },
            {
                label: 'Показать список пунктов',
                description: steps.map(s => s.title).join(' · '),
                id: 'list'
            }
        ],
        { title: 'Adway: мастер правок чекера' }
    );
    if (!start) {
        return;
    }
    if (start.id === 'list') {
        const pick = await vscode.window.showQuickPick(
            steps.map((s, i) => ({
                label: `${i + 1}. ${s.title}`,
                detail: s.detail.split('\n')[0],
                step: s
            })),
            { title: 'Пункты мастера' }
        );
        if (!pick) {
            return;
        }
    }

    let applied = 0;
    let skipped = 0;

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const doc = await vscode.workspace.openTextDocument(targetUri);
        const proposed = computeProposed(doc, step);

        if (!proposed) {
            skipped += 1;
            continue;
        }

        if (proposed.commandOnly && !proposed.html) {
            const go = await vscode.window.showInformationMessage(
                `Пункт ${i + 1}/${steps.length}: ${step.title}\n${proposed.note || step.detail}\n\nВыполнить команду?`,
                { modal: true },
                'Выполнить',
                'Пропустить',
                'Стоп'
            );
            if (go === 'Стоп' || go === undefined) {
                if (go === undefined) {
                    skipped += 1;
                    break;
                }
                break;
            }
            if (go !== 'Выполнить') {
                skipped += 1;
                continue;
            }
            await vscode.window.showTextDocument(doc, { preview: false });
            await vscode.commands.executeCommand(proposed.commandOnly);
            applied += 1;
            await refreshDiagnostics(await vscode.workspace.openTextDocument(targetUri));
            continue;
        }

        const original = doc.getText();
        const nextHtml = proposed.html || original;
        if (nextHtml === original && !(proposed.css && proposed.css.length)) {
            skipped += 1;
            continue;
        }

        if (proposed.css?.length) {
            await previewCssDiffs(
                proposed.css.map(c => ({
                    fileRel: c.fileRel,
                    before: c.before,
                    after: c.after,
                    targetUri: vscode.Uri.file(c.absPath)
                }))
            );
        }

        const choice = await previewDiffAndChoose({
            title: `Adway ${i + 1}/${steps.length}: ${step.title}`,
            original,
            proposed: nextHtml,
            language: 'html',
            message: `Пункт ${i + 1} из ${steps.length}: ${step.title}\n${step.detail.split('\n').slice(0, 4).join('\n')}${
                proposed.note ? `\n${proposed.note}` : ''
            }\n\nСлева — было, справа — будет.`,
            applyLabel: 'Применить',
            skipLabel: 'Пропустить',
            stopLabel: 'Стоп',
            targetUri
        });

        if (choice === 'stop') {
            break;
        }
        if (choice === 'skip') {
            skipped += 1;
            continue;
        }

        // снова открыть актуальный документ (после diff)
        const doc2 = await vscode.workspace.openTextDocument(targetUri);
        if (nextHtml !== original) {
            const ok = await applyHtmlToDocument(doc2, nextHtml);
            if (!ok) {
                vscode.window.showErrorMessage(
                    `Adway: не применился пункт «${step.title}» (WorkspaceEdit)`
                );
                break;
            }
        } else {
            await vscode.window.showTextDocument(doc2, { preview: false });
        }

        if (proposed.css?.length) {
            for (const c of proposed.css) {
                try {
                    fs.writeFileSync(c.absPath, c.after, 'utf8');
                } catch {
                    // ignore
                }
            }
        }

        if (step.kind === 'video' && targetUri.scheme === 'file') {
            const htmlDir = path.dirname(targetUri.fsPath);
            const live = await vscode.workspace.openTextDocument(targetUri);
            await live.save();
            const after = live.getText();
            const result = setupAdwayVideoPlayer(after, htmlDir, {
                writeAssets: true,
                cleanup: false
            });
            if (result.html !== after) {
                await applyHtmlToDocument(live, result.html);
                const live2 = await vscode.workspace.openTextDocument(targetUri);
                await live2.save();
            }
        }

        applied += 1;
        await refreshDiagnostics(await vscode.workspace.openTextDocument(targetUri));
        vscode.window.showInformationMessage(
            `Adway: применено «${step.title}» (${applied}/${steps.length})`
        );
    }

    await vscode.window.showTextDocument(targetUri, { preview: false });
    vscode.window.showInformationMessage(
        `Adway мастер: применено ${applied}, пропущено ${skipped}, всего пунктов ${steps.length}`
    );
}
