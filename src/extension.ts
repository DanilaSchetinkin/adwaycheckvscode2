import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CheckResult, LandingChecker, stripHtml } from './checker';
import { AdwayCodeActionProvider, buildFixEdit, FixId, fixAllLocalPathsWithCss } from './codeActions';
import { cleanupLanding, moveLinksToHead, removeHtmlComments } from './cleanup';
import {
    collectFlaggedExternalImageUrls,
    dedupeAssetFolders,
    downloadExternalImages,
    extractExternalImageUrlFromLine
} from './downloadAssets';
import { AdwayDiagnostics, detectCode, getFixesForCode, getFixesForMessage } from './diagnostics';
import { normalizeAnchorHrefs } from './normalizeHrefs';
import { AdwayResultsTreeProvider } from './resultsTree';
import {
    checkScriptAssets,
    insertScriptSrcTag,
    removeScriptSrcTag
} from './scriptAssets';
import { initSheets, getSheetsDirectory } from './sheets';
import { initProjectStructureCommand } from './projectStructure';
import { ONEFORM_SPAN } from './snippetTexts';
import { SnippetProvider } from './snippets';
import { AdwayStatusBar } from './statusBar';
import { runFixWizard } from './fixWizard';
import { fixExtensionlessAssets, findExtensionlessAssets } from './extensionlessAssets';
import { setupAdwayVideoPlayer } from './videoPlayer';
import {
    buildVideoHtmlBlock,
    buildVideoJs,
    VIDEO_CSS
} from './videoTemplates';
import { previewCssDiffs, previewDiffAndConfirm, registerChangePreview } from './ai/changePreview';
import { buildPlayerReplacePlan, detectOldPlayer } from './ai/aiPlayer';
import { checkOllamaAvailable, getOllamaConfig } from './ai/ollamaClient';
import { getTemplatesStatus } from './ai/templatesLoader';
import { openAdwayAiChat } from './ai/aiChatPanel';

let diagnosticsProvider: AdwayDiagnostics;
let statusBar: AdwayStatusBar;
let resultsTree: AdwayResultsTreeProvider;
let resultsPanel: vscode.WebviewPanel | undefined;
let resultsPanelSource: { document: vscode.TextDocument; column: vscode.ViewColumn } | undefined;
let resultsPanelResults: CheckResult[] = [];

export function activate(context: vscode.ExtensionContext) {
    console.log('Adway Checker активирован');

    initSheets(context);
    registerChangePreview(context);

    diagnosticsProvider = new AdwayDiagnostics();
    statusBar = new AdwayStatusBar();
    resultsTree = new AdwayResultsTreeProvider(diagnosticsProvider);

    context.subscriptions.push(
        diagnosticsProvider,
        statusBar,
        diagnosticsProvider.onDidUpdate(event => {
            statusBar.onDiagnosticsUpdated(event);
            resultsTree.onDiagnosticsUpdated(event);
        }),
        vscode.window.onDidChangeActiveTextEditor(editor => {
            statusBar.refreshForActiveEditor();
            resultsTree.onActiveEditorChanged(editor);
        }),
        vscode.commands.registerCommand(
            'adway.openTreeIssue',
            async (uriArg: string | vscode.Uri | { $mid?: number; path?: string; scheme?: string; fsPath?: string }, line: number) => {
                try {
                    let uri: vscode.Uri;
                    if (typeof uriArg === 'string') {
                        uri = vscode.Uri.parse(uriArg);
                    } else if (uriArg instanceof vscode.Uri) {
                        uri = uriArg;
                    } else if (uriArg && typeof uriArg === 'object' && (uriArg as vscode.Uri).scheme) {
                        const o = uriArg as vscode.Uri;
                        uri = vscode.Uri.from({
                            scheme: o.scheme,
                            authority: o.authority,
                            path: o.path,
                            query: o.query,
                            fragment: o.fragment
                        });
                    } else {
                        vscode.window.showErrorMessage('Adway: не удалось открыть файл из панели');
                        return;
                    }

                    const doc = await vscode.workspace.openTextDocument(uri);
                    const editor = await vscode.window.showTextDocument(doc, {
                        preview: false,
                        preserveFocus: false
                    });
                    const maxLine = Math.max(0, doc.lineCount - 1);
                    const safeLine = Math.min(Math.max(0, Number(line) || 0), maxLine);
                    const lineText = doc.lineAt(safeLine).text;
                    const range = new vscode.Range(safeLine, 0, safeLine, lineText.length);
                    editor.selection = new vscode.Selection(range.start, range.end);
                    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e);
                    vscode.window.showErrorMessage(`Adway: переход к строке — ${msg}`);
                }
            }
        ),
        (() => {
            const treeView = vscode.window.createTreeView('adwayResults', {
                treeDataProvider: resultsTree,
                showCollapseAll: true
            });
            treeView.onDidChangeSelection(async e => {
                const node = e.selection[0] as
                    | { kind?: string; uri?: vscode.Uri; line?: number }
                    | undefined;
                if (node && node.kind === 'issue' && node.uri && node.line !== undefined) {
                    await vscode.commands.executeCommand(
                        'adway.openTreeIssue',
                        node.uri.toString(),
                        node.line
                    );
                }
            });
            return treeView;
        })(),
        vscode.commands.registerCommand('adway.focusResultsTree', () => {
            void vscode.commands.executeCommand('adwayResults.focus');
        }),
        vscode.commands.registerCommand('adway.fixWizard', async (ctx?: unknown) => {
            const editor = await getHtmlEditorForFix(ctx);
            if (!editor) {
                vscode.window.showErrorMessage('Откройте HTML файл');
                return;
            }
            await runFixWizard(editor, doc => diagnosticsProvider.updateDiagnostics(doc));
        }),
        vscode.languages.registerCodeActionsProvider(
            { language: 'html', scheme: '*' },
            new AdwayCodeActionProvider(),
            { providedCodeActionKinds: AdwayCodeActionProvider.providedCodeActionKinds }
        ),
        vscode.commands.registerCommand(
            'adway.applyFix',
            async (uriString: string, fixId: FixId, line?: number) => {
                try {
                    const uri = vscode.Uri.parse(uriString);
                    const document = await vscode.workspace.openTextDocument(uri);
                    const edit = buildFixEdit(document, fixId, line ?? 0);
                    if (!edit) {
                        vscode.window.showWarningMessage(`Adway: не удалось подготовить фикс «${fixId}»`);
                        return;
                    }
                    const ok = await vscode.workspace.applyEdit(edit);
                    if (!ok) {
                        vscode.window.showErrorMessage(`Adway: правка «${fixId}» не применилась`);
                        return;
                    }
                    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
                    await diagnosticsProvider.updateDiagnostics(document);
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e);
                    vscode.window.showErrorMessage(`Adway Quick Fix: ${msg}`);
                }
            }
        )
    );

    async function runActiveFix(fixId: FixId, okMessage: string, ctx?: unknown) {
        const editor = await getHtmlEditorForFix(ctx);
        if (!editor) {
            vscode.window.showErrorMessage('Откройте HTML файл');
            return;
        }
        const edit = buildFixEdit(editor.document, fixId, editor.selection.active.line);
        if (!edit) {
            vscode.window.showInformationMessage(`Adway: нечего применять («${fixId}»)`);
            return;
        }
        const ok = await vscode.workspace.applyEdit(edit);
        if (!ok) {
            vscode.window.showErrorMessage('Adway: правка не применилась');
            return;
        }
        await diagnosticsProvider.updateDiagnostics(editor.document);
        vscode.window.showInformationMessage(okMessage);
    }

    const checkCommand = vscode.commands.registerCommand(
        'adway.checkLanding',
        async (uri?: vscode.Uri) => {
            const document = await resolveLandingHtmlDocument({
                uri: uri instanceof vscode.Uri ? uri : undefined,
                allowPick: true
            });
            if (!document) {
                vscode.window.showErrorMessage(
                    'Adway: не найден HTML лендинга. Откройте index.html или выберите файл.'
                );
                return;
            }

            const editor = await vscode.window.showTextDocument(document, {
                preview: false,
                preserveFocus: false
            });

            await diagnosticsProvider.updateDiagnostics(editor.document);

            const checker = new LandingChecker(editor.document);
            const results = await checker.check();

            resultsPanelSource = {
                document: editor.document,
                column: editor.viewColumn ?? vscode.ViewColumn.One
            };
            // тот же порядок, что в панели: ошибки → предупреждения → успехи
            resultsPanelResults = [
                ...results.filter(r => r.success === false),
                ...results.filter(r => r.success === 'warning'),
                ...results.filter(r => r.success === true)
            ];

            if (!resultsPanel) {
                resultsPanel = vscode.window.createWebviewPanel(
                    'adwayResults',
                    'Результаты проверки Adway',
                    vscode.ViewColumn.Beside,
                    {
                        enableScripts: true,
                        enableCommandUris: ['adway.resultsGoTo'],
                        retainContextWhenHidden: true
                    }
                );

                resultsPanel.onDidDispose(() => {
                    resultsPanel = undefined;
                    resultsPanelSource = undefined;
                    resultsPanelResults = [];
                });
            }

            resultsPanel.title = `Результаты Adway — ${path.basename(editor.document.fileName)}`;
            resultsPanel.webview.html = generateResultsHtml(resultsPanelResults);
            resultsPanel.reveal(vscode.ViewColumn.Beside, true);
        }
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('adway.resultsGoTo', async (line?: number, file?: string | null) => {
            if (!resultsPanelSource) {
                return;
            }
            const safe =
                typeof line === 'number' && !Number.isNaN(line) && line >= 0 ? line : undefined;
            const rel =
                typeof file === 'string' && file.trim() ? file.trim().replace(/\\/g, '/') : undefined;
            await revealResultsLine(resultsPanelSource, safe, rel);
        }),
        vscode.commands.registerCommand('adway.resultsShowFixesContext', async (ctx?: unknown) => {
            await showFixesFromWebviewContext(ctx);
        })
    );

    const snippetProvider = new SnippetProvider();

    context.subscriptions.push(
        checkCommand,
        vscode.commands.registerCommand('adway.insertJquery', async (ctx?: unknown) => {
            if (!(await getHtmlEditorForFix(ctx))) {
                vscode.window.showErrorMessage('Откройте HTML файл');
                return;
            }
            await snippetProvider.insertJquery();
        }),
        vscode.commands.registerCommand('adway.insertScripts', async (ctx?: unknown) => {
            if (!(await getHtmlEditorForFix(ctx))) {
                vscode.window.showErrorMessage('Откройте HTML файл');
                return;
            }
            await snippetProvider.insertScripts();
        }),
        vscode.commands.registerCommand('adway.insertHiddenInputs', async (ctx?: unknown) => {
            if (!(await getHtmlEditorForFix(ctx))) {
                vscode.window.showErrorMessage('Откройте HTML файл');
                return;
            }
            await snippetProvider.insertHiddenInputs();
        }),
        vscode.commands.registerCommand('adway.insertForm', () => snippetProvider.insertForm()),
        vscode.commands.registerCommand('adway.insertDate', () => snippetProvider.insertDate()),
        vscode.commands.registerCommand('adway.insertVideoScript', () => snippetProvider.insertVideoScript()),
        vscode.commands.registerCommand('adway.openSnippets', () => snippetProvider.showSnippetsPicker()),
        vscode.commands.registerCommand('adway.initProjectStructure', () => initProjectStructureCommand()),
        vscode.commands.registerCommand('adway.insertDoctype', (ctx?: unknown) =>
            runActiveFix('doctype', 'Adway: вставлен DOCTYPE', ctx)
        ),
        vscode.commands.registerCommand('adway.removeBase', (ctx?: unknown) =>
            runActiveFix('base', 'Adway: <base> удалён', ctx)
        ),
        vscode.commands.registerCommand('adway.removeTarget', (ctx?: unknown) =>
            runActiveFix('removeTarget', 'Adway: target удалены', ctx)
        ),
        vscode.commands.registerCommand('adway.flattenPicture', (ctx?: unknown) =>
            runActiveFix('flattenPicture', 'Adway: <source> убраны', ctx)
        ),
        vscode.commands.registerCommand('adway.insertLazy', (ctx?: unknown) =>
            runActiveFix('lazy', 'Adway: lazy loading вставлен', ctx)
        ),
        vscode.commands.registerCommand('adway.insertScroll', (ctx?: unknown) =>
            runActiveFix('scroll', 'Adway: скрипт прокрутки вставлен', ctx)
        ),
        vscode.commands.registerCommand('adway.insertValidation', (ctx?: unknown) =>
            runActiveFix('validation', 'Adway: валидаторы вставлены', ctx)
        ),
        vscode.commands.registerCommand('adway.fixValidationName', (ctx?: unknown) =>
            runActiveFix('validationReplaceName', 'Adway: валидатор имени обновлён', ctx)
        ),
        vscode.commands.registerCommand('adway.addOneform', (ctx?: unknown) =>
            runActiveFix('oneform', 'Adway: id="oneform" добавлен', ctx)
        ),
        vscode.commands.registerCommand('adway.insertOneformSpan', async (ctx?: unknown) => {
            const editor = await getHtmlEditorForFix(ctx);
            if (!editor) {
                vscode.window.showErrorMessage('Откройте HTML файл');
                return;
            }
            const html = editor.document.getText();
            if (/id\s*=\s*["']oneform["']/i.test(html)) {
                vscode.window.showInformationMessage('Adway: id="oneform" уже есть в документе');
                return;
            }
            const ok = await editor.edit(editBuilder => {
                editBuilder.insert(editor.selection.active, ONEFORM_SPAN);
            });
            if (!ok) {
                vscode.window.showErrorMessage('Adway: не удалось вставить span');
                return;
            }
            await diagnosticsProvider.updateDiagnostics(editor.document);
            vscode.window.showInformationMessage('Adway: вставлен <span id="oneform"></span>');
        }),
        vscode.commands.registerCommand('adway.connectScriptFile', async (ctx?: unknown) => {
            const editor = await getHtmlEditorForFix(ctx);
            if (!editor) {
                vscode.window.showErrorMessage('Откройте HTML файл');
                return;
            }
            if (editor.document.uri.scheme !== 'file') {
                vscode.window.showErrorMessage('Сохраните HTML на диск');
                return;
            }
            const htmlDir = path.dirname(editor.document.uri.fsPath);
            let scriptPath = await pickScriptPathFromContext(ctx, editor.document.getText(), htmlDir, 'unconnected');
            if (!scriptPath) {
                return;
            }
            const html = editor.document.getText();
            if (new RegExp(`<script\\b[^>]*\\bsrc\\s*=\\s*(["'])(?:\\./)?${escapeRegExp(scriptPath)}\\1`, 'i').test(html)) {
                vscode.window.showInformationMessage(`Adway: ${scriptPath} уже подключён`);
                return;
            }
            const next = insertScriptSrcTag(html, scriptPath);
            const fullRange = new vscode.Range(
                editor.document.positionAt(0),
                editor.document.positionAt(html.length)
            );
            const ok = await editor.edit(eb => eb.replace(fullRange, next));
            if (!ok) {
                vscode.window.showErrorMessage('Adway: не удалось подключить скрипт');
                return;
            }
            await diagnosticsProvider.updateDiagnostics(editor.document);
            vscode.window.showInformationMessage(`Adway: подключён <script src="${scriptPath}">`);
        }),
        vscode.commands.registerCommand('adway.deleteUnconnectedScript', async (ctx?: unknown) => {
            const editor = await getHtmlEditorForFix(ctx);
            if (!editor) {
                vscode.window.showErrorMessage('Откройте HTML файл');
                return;
            }
            if (editor.document.uri.scheme !== 'file') {
                vscode.window.showErrorMessage('Сохраните HTML на диск');
                return;
            }
            const htmlDir = path.dirname(editor.document.uri.fsPath);
            const scriptPath = await pickScriptPathFromContext(
                ctx,
                editor.document.getText(),
                htmlDir,
                'unconnected'
            );
            if (!scriptPath) {
                return;
            }
            const full = path.join(htmlDir, scriptPath);
            if (!fs.existsSync(full)) {
                vscode.window.showErrorMessage(`Adway: файл не найден: ${scriptPath}`);
                return;
            }
            const confirm = await vscode.window.showWarningMessage(
                `Удалить неподключённый файл «${scriptPath}»?`,
                { modal: true },
                'Удалить'
            );
            if (confirm !== 'Удалить') {
                return;
            }
            try {
                fs.unlinkSync(full);
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                vscode.window.showErrorMessage(`Adway: не удалось удалить — ${msg}`);
                return;
            }
            await diagnosticsProvider.updateDiagnostics(editor.document);
            vscode.window.showInformationMessage(`Adway: удалён ${scriptPath}`);
        }),
        vscode.commands.registerCommand('adway.removeMissingScriptTag', async (ctx?: unknown) => {
            const editor = await getHtmlEditorForFix(ctx);
            if (!editor) {
                vscode.window.showErrorMessage('Откройте HTML файл');
                return;
            }
            const htmlDir =
                editor.document.uri.scheme === 'file'
                    ? path.dirname(editor.document.uri.fsPath)
                    : undefined;
            const scriptPath = await pickScriptPathFromContext(
                ctx,
                editor.document.getText(),
                htmlDir,
                'missing'
            );
            if (!scriptPath) {
                return;
            }
            const html = editor.document.getText();
            const { html: next, removed } = removeScriptSrcTag(html, scriptPath);
            if (removed === 0) {
                vscode.window.showInformationMessage(
                    `Adway: тег <script src="${scriptPath}"> не найден`
                );
                return;
            }
            const fullRange = new vscode.Range(
                editor.document.positionAt(0),
                editor.document.positionAt(html.length)
            );
            const ok = await editor.edit(eb => eb.replace(fullRange, next));
            if (!ok) {
                vscode.window.showErrorMessage('Adway: не удалось удалить тег script');
                return;
            }
            await diagnosticsProvider.updateDiagnostics(editor.document);
            vscode.window.showInformationMessage(
                `Adway: удалено тегов script: ${removed} (${scriptPath})`
            );
        }),
        vscode.commands.registerCommand('adway.dedupeImages', async (ctx?: unknown) => {
            const editor = await getHtmlEditorForFix(ctx);
            if (!editor) {
                vscode.window.showErrorMessage('Откройте HTML файл');
                return;
            }
            if (editor.document.uri.scheme !== 'file') {
                vscode.window.showErrorMessage('Сохраните HTML на диск');
                return;
            }
            const htmlDir = path.dirname(editor.document.uri.fsPath);
            const html = editor.document.getText();
            const { html: next, removed, kept } = dedupeAssetFolders(html, htmlDir);
            if (removed.length === 0) {
                vscode.window.showInformationMessage(
                    `Adway: дублей в images/css/js нет (уникальных файлов: ${kept})`
                );
                return;
            }
            if (next !== html) {
                const fullRange = new vscode.Range(
                    editor.document.positionAt(0),
                    editor.document.positionAt(html.length)
                );
                const ok = await editor.edit(eb => eb.replace(fullRange, next));
                if (!ok) {
                    vscode.window.showErrorMessage('Adway: HTML не обновлён после дедупа');
                    return;
                }
            }
            await diagnosticsProvider.updateDiagnostics(editor.document);
            const preview = removed.slice(0, 8).join(', ') + (removed.length > 8 ? '…' : '');
            vscode.window.showInformationMessage(
                `Adway: удалено дублей: ${removed.length} (${preview})`
            );
        }),
        vscode.commands.registerCommand('adway.setupVideoPlayer', async (ctx?: unknown) => {
            const editor = await getHtmlEditorForFix(ctx);
            if (!editor) {
                vscode.window.showErrorMessage('Откройте HTML файл');
                return;
            }
            if (editor.document.uri.scheme !== 'file') {
                vscode.window.showErrorMessage('Сохраните HTML на диск');
                return;
            }
            await editor.document.save();
            const htmlDir = path.dirname(editor.document.uri.fsPath);
            const html = editor.document.getText();
            const result = setupAdwayVideoPlayer(html, htmlDir);
            if (result.html !== html) {
                const fullRange = new vscode.Range(
                    editor.document.positionAt(0),
                    editor.document.positionAt(html.length)
                );
                const ok = await editor.edit(eb => eb.replace(fullRange, result.html));
                if (!ok) {
                    vscode.window.showErrorMessage('Adway: не удалось обновить HTML');
                    return;
                }
                await editor.document.save();
            }
            await diagnosticsProvider.updateDiagnostics(editor.document);
            const parts = [
                ...result.created.map(c => `+${c}`),
                ...result.moved,
                ...result.notes.slice(0, 4)
            ];
            vscode.window.showInformationMessage(
                `Adway: бесплатный видео-плеер — ${parts.slice(0, 6).join('; ') || 'готово'}`
            );
        }),
        vscode.commands.registerCommand('adway.aiCheck', async () => {
            const status = await checkOllamaAvailable();
            const cfg = getOllamaConfig();
            const templates = getTemplatesStatus();
            const parts = [status.message, templates.message];
            if (status.ok) {
                vscode.window.showInformationMessage(`Adway AI: ${parts.join(' · ')}`);
            } else {
                vscode.window.showWarningMessage(`Adway AI: ${parts.join(' · ')}`);
            }
            console.log('Adway AI config', cfg, status, templates);
        }),
        vscode.commands.registerCommand('adway.aiChat', () => {
            openAdwayAiChat(context);
        }),
        vscode.commands.registerCommand('adway.aiRemoveOldPlayer', async (ctx?: unknown) => {
            const editor = await getHtmlEditorForFix(ctx);
            if (!editor) {
                vscode.window.showErrorMessage('Откройте HTML файл');
                return;
            }
            const html = editor.document.getText();
            const htmlDir =
                editor.document.uri.scheme === 'file'
                    ? path.dirname(editor.document.uri.fsPath)
                    : undefined;

            const detected = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Adway AI: ищем секцию старого плеера…',
                    cancellable: false
                },
                async () => detectOldPlayer(html)
            );

            if (!detected.snippet) {
                vscode.window.showInformationMessage(
                    `Adway AI: блок плеера не найден (${detected.reason})`
                );
                return;
            }

            const plan = buildPlayerReplacePlan(html, detected, htmlDir);
            if (plan.htmlAfterReplace === html) {
                vscode.window.showErrorMessage('Adway AI: не удалось подготовить замену секции');
                return;
            }

            type AiPlayerMode = 'replace' | 'delete';
            let action: AiPlayerMode | undefined;
            let cssAlreadyPreviewed = false;

            const pickAction = async (title: string): Promise<AiPlayerMode | 'css' | undefined> => {
                const item = await vscode.window.showQuickPick(
                    [
                        {
                            label: 'Заменить секцию на бесплатный плеер',
                            description: 'рекомендуется',
                            detail: plan.summaryLines.join(' · '),
                            id: 'replace' as const
                        },
                        {
                            label: 'Только удалить секцию',
                            description: 'без #container_video',
                            detail: plan.summaryLines.join(' · '),
                            id: 'delete' as const
                        },
                        {
                            label: 'Сначала показать CSS-diff',
                            description:
                                plan.cssCleanups.length > 0
                                    ? `${plan.cssCleanups.length} файл(ов)`
                                    : 'правил не найдено',
                            detail: 'Compare по CSS (как в Visual Studio)',
                            id: 'css' as const
                        }
                    ],
                    { title, placeHolder: detected.reason }
                );
                return item?.id;
            };

            let choice = await pickAction('Adway AI: что сделать с найденной секцией?');
            if (!choice) {
                return;
            }
            if (choice === 'css') {
                cssAlreadyPreviewed = true;
                if (!plan.cssCleanups.length) {
                    vscode.window.showInformationMessage(
                        'Adway AI: в локальных CSS правил старого плеера не найдено'
                    );
                } else {
                    await previewCssDiffs(
                        plan.cssCleanups.map(c => ({
                            fileRel: c.fileRel,
                            before: c.before,
                            after: c.after,
                            targetUri: vscode.Uri.file(c.absPath)
                        }))
                    );
                }
                const again = await vscode.window.showQuickPick(
                    [
                        {
                            label: 'Заменить секцию на бесплатный плеер',
                            id: 'replace' as const
                        },
                        {
                            label: 'Только удалить секцию',
                            id: 'delete' as const
                        }
                    ],
                    { title: 'Adway AI: применить после просмотра CSS?' }
                );
                if (!again) {
                    return;
                }
                action = again.id;
            } else {
                action = choice;
            }

            const proposed =
                action === 'replace' ? plan.htmlAfterReplace : plan.htmlAfterDelete;
            const title =
                action === 'replace'
                    ? 'Adway AI: HTML было ↔ будет (секция → бесплатный плеер)'
                    : 'Adway AI: HTML было ↔ будет (удаление секции)';

            const cssNote = plan.cssCleanups.length
                ? ` + CSS (${plan.cssCleanups.map(c => c.fileRel).join(', ')})`
                : '';
            const okPreview = await previewDiffAndConfirm({
                title,
                original: html,
                proposed,
                language: 'html',
                message: `${plan.summaryLines.slice(0, 3).join('\n')}${cssNote}\n\nСлева — было, справа — будет.`,
                applyLabel: plan.cssCleanups.length ? 'Применить HTML + CSS' : 'Применить',
                cancelLabel: 'Отмена',
                targetUri: editor.document.uri
            });
            if (!okPreview) {
                return;
            }

            let writeCss = plan.cssCleanups.length > 0;
            if (writeCss && !cssAlreadyPreviewed) {
                const seeCss = await vscode.window.showInformationMessage(
                    `Показать diff CSS перед записью (${plan.cssCleanups.length})?`,
                    'Показать',
                    'Сразу записать',
                    'Без CSS'
                );
                if (seeCss === 'Показать') {
                    await previewCssDiffs(
                        plan.cssCleanups.map(c => ({
                            fileRel: c.fileRel,
                            before: c.before,
                            after: c.after,
                            targetUri: vscode.Uri.file(c.absPath)
                        }))
                    );
                    const go = await vscode.window.showInformationMessage(
                        'Записать CSS-правки на диск?',
                        'Записать CSS',
                        'Пропустить CSS'
                    );
                    writeCss = go === 'Записать CSS';
                } else if (seeCss === 'Без CSS' || seeCss === undefined) {
                    writeCss = false;
                }
            }

            if (writeCss) {
                for (const c of plan.cssCleanups) {
                    fs.writeFileSync(c.absPath, c.after, 'utf8');
                }
            }

            const liveDoc = await vscode.workspace.openTextDocument(editor.document.uri);
            const fullRange = new vscode.Range(
                liveDoc.positionAt(0),
                liveDoc.positionAt(liveDoc.getText().length)
            );
            const we = new vscode.WorkspaceEdit();
            we.replace(liveDoc.uri, fullRange, proposed);
            const ok = await vscode.workspace.applyEdit(we);
            if (!ok) {
                vscode.window.showErrorMessage('Adway AI: правка HTML не применилась');
                return;
            }
            await vscode.window.showTextDocument(liveDoc, { preview: false, preserveFocus: false });

            let note =
                action === 'replace'
                    ? `секция заменена на бесплатный плеер (${detected.source})`
                    : `секция удалена (${detected.source})`;
            if (writeCss) {
                note += `; CSS обновлён (${plan.cssCleanups.length})`;
            }

            if (action === 'replace' && htmlDir) {
                const afterDoc = await vscode.workspace.openTextDocument(editor.document.uri);
                await afterDoc.save();
                const after = afterDoc.getText();
                const result = setupAdwayVideoPlayer(after, htmlDir, {
                    writeAssets: true,
                    cleanup: false
                });
                if (result.html !== after) {
                    const range2 = new vscode.Range(
                        afterDoc.positionAt(0),
                        afterDoc.positionAt(after.length)
                    );
                    const we2 = new vscode.WorkspaceEdit();
                    we2.replace(afterDoc.uri, range2, result.html);
                    await vscode.workspace.applyEdit(we2);
                    const saved = await vscode.workspace.openTextDocument(editor.document.uri);
                    await saved.save();
                    await vscode.window.showTextDocument(saved, { preview: false });
                }
                if (result.created.length || result.notes.length) {
                    note += `; assets: ${(result.created.length ? result.created : result.notes)
                        .slice(0, 4)
                        .join(', ')}`;
                }
            }

            await diagnosticsProvider.updateDiagnostics(
                await vscode.workspace.openTextDocument(editor.document.uri)
            );
            vscode.window.showInformationMessage(`Adway AI: ${note}`);
        }),
        vscode.commands.registerCommand('adway.insertVideoBlock', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }
            await editor.edit(eb => eb.insert(editor.selection.active, buildVideoHtmlBlock()));
        }),
        vscode.commands.registerCommand('adway.insertVideoCss', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.uri.scheme !== 'file') {
                vscode.window.showErrorMessage('Откройте файл на диске');
                return;
            }
            const htmlDir = path.dirname(editor.document.uri.fsPath);
            const cssDir = path.join(htmlDir, 'css');
            if (!fs.existsSync(cssDir)) {
                fs.mkdirSync(cssDir, { recursive: true });
            }
            fs.writeFileSync(path.join(cssDir, 'video.css'), VIDEO_CSS, 'utf8');
            vscode.window.showInformationMessage('Adway: записан css/video.css');
        }),
        vscode.commands.registerCommand('adway.insertVideoJsFile', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.uri.scheme !== 'file') {
                vscode.window.showErrorMessage('Откройте файл на диске');
                return;
            }
            const htmlDir = path.dirname(editor.document.uri.fsPath);
            const jsDir = path.join(htmlDir, 'js');
            if (!fs.existsSync(jsDir)) {
                fs.mkdirSync(jsDir, { recursive: true });
            }
            fs.writeFileSync(path.join(jsDir, 'video.js'), buildVideoJs(150), 'utf8');
            vscode.window.showInformationMessage('Adway: записан js/video.js');
        }),
        vscode.commands.registerCommand('adway.refreshSheets', async () => {
            const directory = getSheetsDirectory();
            if (!directory) {
                vscode.window.showErrorMessage('Sheets не инициализирован');
                return;
            }
            try {
                const count = await directory.refresh();
                const when = new Date(directory.getLastLoadedAt()).toLocaleTimeString();
                vscode.window.showInformationMessage(
                    `Adway: кэш SID/Country обновлён (${count} записей, ${when})`
                );
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                vscode.window.showErrorMessage(`Adway: не удалось обновить Sheets — ${msg}`);
            }
        }),
        vscode.commands.registerCommand('adway.normalizeHrefs', async (ctx?: unknown) => {
            const editor = await getHtmlEditorForFix(ctx);
            if (!editor) {
                vscode.window.showErrorMessage('Откройте HTML файл');
                return;
            }

            const html = editor.document.getText();
            const { html: next, replaced } = normalizeAnchorHrefs(html);
            if (replaced === 0) {
                vscode.window.showInformationMessage(
                    'Adway: нечего менять — у <a> уже href="#", {offer} или tel:/mailto:'
                );
                return;
            }

            const fullRange = new vscode.Range(
                editor.document.positionAt(0),
                editor.document.positionAt(html.length)
            );
            const ok = await editor.edit(editBuilder => {
                editBuilder.replace(fullRange, next);
            });
            if (!ok) {
                vscode.window.showErrorMessage('Adway: не удалось заменить href');
                return;
            }

            await diagnosticsProvider.updateDiagnostics(editor.document);
            vscode.window.showInformationMessage(
                `Adway: заменено ${replaced} ссылок на href="#"`
            );
        }),
        vscode.commands.registerCommand('adway.cleanupLanding', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('Нет активного редактора');
                return;
            }
            if (editor.document.languageId !== 'html') {
                vscode.window.showErrorMessage('Команда работает только для HTML файлов');
                return;
            }

            const config = vscode.workspace.getConfiguration('adway');
            const html = editor.document.getText();
            const result = cleanupLanding(html, {
                removeTarget: true,
                removePictureSource: config.get<boolean>('cleanup.removePictureSource', true),
                normalizeHrefs: true,
                removeComments: false,
                moveLinksToHead: true
            });

            if (
                result.removedTargets === 0 &&
                result.flattenedPictures === 0 &&
                result.replacedHrefs === 0 &&
                result.movedLinks === 0
            ) {
                vscode.window.showInformationMessage('Adway: нечего чистить');
                return;
            }

            const fullRange = new vscode.Range(
                editor.document.positionAt(0),
                editor.document.positionAt(html.length)
            );
            const ok = await editor.edit(editBuilder => {
                editBuilder.replace(fullRange, result.html);
            });
            if (!ok) {
                vscode.window.showErrorMessage('Adway: cleanup не применился');
                return;
            }

            await diagnosticsProvider.updateDiagnostics(editor.document);
            const parts: string[] = [];
            if (result.removedTargets) {
                parts.push(`target: ${result.removedTargets}`);
            }
            if (result.flattenedPictures) {
                parts.push(`picture: ${result.flattenedPictures}`);
            }
            if (result.replacedHrefs) {
                parts.push(`href→#: ${result.replacedHrefs}`);
            }
            if (result.movedLinks) {
                parts.push(`link→head: ${result.movedLinks}`);
            }
            vscode.window.showInformationMessage(`Adway: почищено (${parts.join(', ')})`);
        }),
        vscode.commands.registerCommand('adway.moveLinksToHead', async (ctx?: unknown) => {
            const editor = await getHtmlEditorForFix(ctx);
            if (!editor) {
                vscode.window.showErrorMessage('Откройте HTML файл');
                return;
            }
            const html = editor.document.getText();
            const { html: next, moved } = moveLinksToHead(html);
            if (moved === 0) {
                vscode.window.showInformationMessage('Adway: все <link> уже в <head>');
                return;
            }
            const fullRange = new vscode.Range(
                editor.document.positionAt(0),
                editor.document.positionAt(html.length)
            );
            const ok = await editor.edit(eb => eb.replace(fullRange, next));
            if (!ok) {
                vscode.window.showErrorMessage('Adway: не удалось перенести <link>');
                return;
            }
            await diagnosticsProvider.updateDiagnostics(editor.document);
            vscode.window.showInformationMessage(`Adway: перенесено <link> в <head>: ${moved}`);
        }),
        vscode.commands.registerCommand('adway.removeComments', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'html') {
                vscode.window.showErrorMessage('Откройте HTML файл');
                return;
            }
            const html = editor.document.getText();
            const { html: next, removed } = removeHtmlComments(html);
            if (removed === 0) {
                vscode.window.showInformationMessage('Adway: HTML-комментариев не найдено');
                return;
            }
            const fullRange = new vscode.Range(
                editor.document.positionAt(0),
                editor.document.positionAt(html.length)
            );
            const ok = await editor.edit(editBuilder => {
                editBuilder.replace(fullRange, next);
            });
            if (!ok) {
                vscode.window.showErrorMessage('Adway: не удалось удалить комментарии');
                return;
            }
            await diagnosticsProvider.updateDiagnostics(editor.document);
            vscode.window.showInformationMessage(`Adway: удалено комментариев: ${removed}`);
        }),
        vscode.commands.registerCommand(
            'adway.downloadExternalImages',
            async (
                uriOrCtx?: string | vscode.Uri | Record<string, unknown>,
                opts?: { line?: number; url?: string }
            ) => {
                let document: vscode.TextDocument | undefined;
                let focusLine: number | undefined = opts?.line;
                let focusUrl: string | undefined = opts?.url;

                if (typeof uriOrCtx === 'string') {
                    document = await resolveLandingHtmlDocument({
                        uri: vscode.Uri.parse(uriOrCtx),
                        allowPick: true
                    });
                } else if (uriOrCtx instanceof vscode.Uri) {
                    document = await resolveLandingHtmlDocument({
                        uri: uriOrCtx,
                        allowPick: true
                    });
                } else {
                    document = (await getHtmlEditorForFix(uriOrCtx))?.document;
                    if (!document) {
                        document = await resolveLandingHtmlDocument({ allowPick: true });
                    }
                    const info = await resolveResultsContext(uriOrCtx);
                    if (focusLine === undefined && info.line >= 0) {
                        focusLine = info.line;
                    }
                    if (!focusUrl && info.index >= 0) {
                        focusUrl = extractExternalImageUrlFromLine(
                            stripHtml(resultsPanelResults[info.index]?.text || '')
                        );
                    }
                    if (!focusUrl && info.file && document?.uri.scheme === 'file' && info.line >= 0) {
                        try {
                            const cssAbs = path.resolve(
                                path.dirname(document.uri.fsPath),
                                info.file
                            );
                            const cssDoc = await vscode.workspace.openTextDocument(cssAbs);
                            if (info.line < cssDoc.lineCount) {
                                focusUrl = extractExternalImageUrlFromLine(
                                    cssDoc.lineAt(info.line).text
                                );
                            }
                        } catch {
                            // ignore
                        }
                    }
                }
                if (!document) {
                    vscode.window.showErrorMessage(
                        'Adway: не найден HTML лендинга для скачивания картинок'
                    );
                    return;
                }
                if (document.uri.scheme !== 'file') {
                    vscode.window.showErrorMessage('Сохраните файл на диск перед скачиванием');
                    return;
                }

                const htmlDir = path.dirname(document.uri.fsPath);
                const html = document.getText();

                if (
                    !focusUrl &&
                    focusLine !== undefined &&
                    focusLine >= 0 &&
                    focusLine < document.lineCount
                ) {
                    focusUrl = extractExternalImageUrlFromLine(document.lineAt(focusLine).text);
                }

                // URL только из ошибок «Внешнее изображение» (+ CSS)
                const errorUrls = collectExternalImageUrlsFromErrors(document);
                const whitelist = vscode.workspace
                    .getConfiguration('adway')
                    .get<string[]>('linkWhitelist', []);
                const flagged = collectFlaggedExternalImageUrls(html, whitelist, htmlDir);
                const fromErrors = errorUrls.length > 0 ? errorUrls : flagged;

                let onlyUrls: string[];
                if (focusUrl) {
                    onlyUrls = [focusUrl];
                } else if (fromErrors.length > 0) {
                    onlyUrls = fromErrors;
                } else {
                    vscode.window.showInformationMessage(
                        'Adway: в ошибках нет внешних изображений — качать нечего'
                    );
                    return;
                }

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title:
                            onlyUrls.length === 1
                                ? 'Adway: скачивание изображения…'
                                : `Adway: скачивание изображений из ошибок (${onlyUrls.length})…`,
                        cancellable: false
                    },
                    async () => {
                        const result = await downloadExternalImages(html, htmlDir, {
                            onlyUrls
                        });
                        if (
                            result.downloaded === 0 &&
                            result.reused === 0 &&
                            result.deduped === 0 &&
                            !result.cssUrlsFixed &&
                            result.failed.length === 0
                        ) {
                            vscode.window.showWarningMessage(
                                `Adway: не удалось скачать (${onlyUrls.length} URL). Проверьте сеть или откройте в браузере.`
                            );
                            return;
                        }
                        if (result.html !== html) {
                            const fullRange = new vscode.Range(
                                document!.positionAt(0),
                                document!.positionAt(html.length)
                            );
                            const edit = new vscode.WorkspaceEdit();
                            edit.replace(document!.uri, fullRange, result.html);
                            await vscode.workspace.applyEdit(edit);
                        }
                        // подтянуть открытые CSS после записи на диск
                        await syncOpenFilesFromDisk(
                            (result.cssFiles || []).map(f => path.join(htmlDir, f))
                        );
                        await diagnosticsProvider.updateDiagnostics(document!);
                        const parts: string[] = [];
                        if (result.downloaded) {
                            parts.push(`скачано: ${result.downloaded}`);
                        }
                        if (result.reused) {
                            parts.push(`уже были: ${result.reused}`);
                        }
                        if (result.deduped) {
                            const names = result.dedupedFiles;
                            const shown = names.slice(0, 8).join(', ');
                            const more = names.length > 8 ? ` и ещё ${names.length - 8}` : '';
                            parts.push(`дубли удалены: ${shown}${more}`);
                        }
                        if (result.failed.length) {
                            parts.push(`не удалось: ${result.failed.length}`);
                        }
                        if (result.cssUrlsFixed) {
                            const cssNames = (result.cssFiles || []).slice(0, 4).join(', ');
                            const more =
                                (result.cssFiles || []).length > 4
                                    ? ` и ещё ${(result.cssFiles || []).length - 4}`
                                    : '';
                            parts.push(
                                `CSS url(): ${result.cssUrlsFixed}${cssNames ? ` (${cssNames}${more})` : ''}`
                            );
                        }
                        const msg = `Adway: ${parts.join('; ') || 'готово'} → images/ + fonts/`;
                        if (result.dedupedFiles.length > 0) {
                            console.log(
                                '[Adway] удалены дубли в images/:',
                                result.dedupedFiles.join(', ')
                            );
                        }
                        if (result.failedReasons?.length) {
                            console.log(
                                '[Adway] download failed:',
                                result.failedReasons
                                    .map(f => `${f.url} → ${f.reason}`)
                                    .join('\n')
                            );
                        }
                        if (result.failed.length > 0) {
                            const why = (result.failedReasons || [])
                                .slice(0, 3)
                                .map(f => {
                                    let name = f.url;
                                    try {
                                        name = path.basename(new URL(f.url).pathname) || f.url;
                                    } catch {
                                        // keep
                                    }
                                    return `${name}: ${f.reason}`;
                                })
                                .join('; ');
                            const pick = await vscode.window.showWarningMessage(
                                why ? `${msg}. ${why}` : msg,
                                'Открыть нескачанные в браузере'
                            );
                            if (pick) {
                                for (const url of result.failed) {
                                    await vscode.env.openExternal(vscode.Uri.parse(url));
                                }
                            }
                        } else {
                            vscode.window.showInformationMessage(msg);
                        }
                    }
                );
            }
        ),
        vscode.commands.registerCommand('adway.openExternalImages', async (ctx?: unknown) => {
            const editor = await getHtmlEditorForFix(ctx);
            if (!editor) {
                vscode.window.showErrorMessage('Откройте HTML файл');
                return;
            }
            const whitelist = vscode.workspace
                .getConfiguration('adway')
                .get<string[]>('linkWhitelist', []);
            const fromErrors = collectExternalImageUrlsFromErrors(editor.document);
            const htmlDir =
                editor.document.uri.scheme === 'file'
                    ? path.dirname(editor.document.uri.fsPath)
                    : undefined;
            const urls =
                fromErrors.length > 0
                    ? fromErrors
                    : collectFlaggedExternalImageUrls(
                          editor.document.getText(),
                          whitelist,
                          htmlDir
                      );
            if (urls.length === 0) {
                vscode.window.showInformationMessage(
                    'Adway: в ошибках нет внешних изображений'
                );
                return;
            }

            const mode = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(globe) Открыть все в браузере',
                        description: `${urls.length} шт. — Save as вручную`,
                        value: 'all' as const
                    },
                    {
                        label: '$(list-selection) Выбрать картинки…',
                        description: 'открыть только выбранные',
                        value: 'pick' as const
                    }
                ],
                { placeHolder: 'Внешние изображения из ошибок — Save as' }
            );
            if (!mode) {
                return;
            }

            let toOpen = urls;
            if (mode.value === 'pick') {
                const selected = await vscode.window.showQuickPick(
                    urls.map(u => {
                        let label = u;
                        try {
                            label = path.basename(new URL(u).pathname) || u;
                        } catch {
                            // keep
                        }
                        return {
                            label,
                            description: u,
                            url: u
                        };
                    }),
                    { canPickMany: true, placeHolder: 'Выберите URL для открытия' }
                );
                if (!selected?.length) {
                    return;
                }
                toOpen = selected.map(s => s.url);
            }

            for (const url of toOpen) {
                await vscode.env.openExternal(vscode.Uri.parse(url));
            }
            vscode.window.showInformationMessage(
                `Adway: открыто ${toOpen.length} — сохраните в images/ (Save as)`
            );
        }),
        vscode.commands.registerCommand('adway.fixOrderForm', async (ctx?: unknown) => {
            const editor = await getHtmlEditorForFix(ctx);
            if (!editor) {
                vscode.window.showErrorMessage('Откройте HTML файл');
                return;
            }
            const edit = buildFixEdit(editor.document, 'fixForm', editor.selection.active.line);
            if (!edit) {
                vscode.window.showInformationMessage(
                    'Adway: форма не найдена или уже в порядке (action/method/hidden/required)'
                );
                return;
            }
            const ok = await vscode.workspace.applyEdit(edit);
            if (!ok) {
                vscode.window.showErrorMessage('Adway: не удалось починить форму');
                return;
            }
            await diagnosticsProvider.updateDiagnostics(editor.document);
            vscode.window.showInformationMessage(
                'Adway: форма обновлена (action/method/oneform/required/hidden)'
            );
        }),
        vscode.commands.registerCommand('adway.fixLocalPath', async (ctx?: unknown) => {
            const editor = await getHtmlEditorForFix(ctx);
            if (!editor) {
                vscode.window.showErrorMessage('Откройте HTML файл');
                return;
            }
            const edit = buildFixEdit(editor.document, 'fixLocalPath', editor.selection.active.line);
            if (!edit) {
                vscode.window.showInformationMessage(
                    'Adway: на этой строке нечего чинить (файл не найден в проекте)'
                );
                return;
            }
            const ok = await vscode.workspace.applyEdit(edit);
            if (!ok) {
                vscode.window.showErrorMessage('Adway: путь не исправлен');
                return;
            }
            await diagnosticsProvider.updateDiagnostics(editor.document);
            vscode.window.showInformationMessage('Adway: путь исправлен');
        }),
        vscode.commands.registerCommand('adway.fixAllLocalPaths', async (ctx?: unknown) => {
            const editor = await getHtmlEditorForFix(ctx);
            if (!editor) {
                vscode.window.showErrorMessage('Откройте HTML файл');
                return;
            }
            const { edit, cssFixed, cssFiles } = fixAllLocalPathsWithCss(editor.document);
            if (!edit && cssFixed === 0) {
                vscode.window.showInformationMessage(
                    'Adway: нет путей, которые можно заменить на найденные файлы'
                );
                return;
            }
            if (edit) {
                const ok = await vscode.workspace.applyEdit(edit);
                if (!ok) {
                    vscode.window.showErrorMessage('Adway: пути в HTML не исправлены');
                    return;
                }
            }
            await diagnosticsProvider.updateDiagnostics(editor.document);
            const parts: string[] = [];
            if (edit) {
                parts.push('HTML');
            }
            if (cssFixed) {
                parts.push(`CSS: ${cssFixed} (${cssFiles.slice(0, 4).join(', ')})`);
            }
            vscode.window.showInformationMessage(`Adway: пути исправлены (${parts.join('; ')})`);
        }),
        vscode.commands.registerCommand('adway.fixExtensionlessAssets', async (ctx?: unknown) => {
            const editor = await getHtmlEditorForFix(ctx);
            if (!editor) {
                vscode.window.showErrorMessage('Откройте HTML файл');
                return;
            }
            if (editor.document.uri.scheme !== 'file') {
                vscode.window.showErrorMessage('Сохраните HTML на диск');
                return;
            }
            const htmlDir = path.dirname(editor.document.uri.fsPath);
            const found = findExtensionlessAssets(htmlDir);
            if (found.length === 0) {
                vscode.window.showInformationMessage('Adway: файлов без расширения не найдено');
                return;
            }
            const confirm = await vscode.window.showWarningMessage(
                `Найдено ${found.length} файл(ов) без расширения (PNG/SVG/JPEG/WEBP/MP4…). Переименовать и обновить ссылки в HTML/CSS?`,
                { modal: true },
                'Восстановить',
                'Отмена'
            );
            if (confirm !== 'Восстановить') {
                return;
            }
            const html = editor.document.getText();
            const result = fixExtensionlessAssets(html, htmlDir);
            if (result.html !== html) {
                const fullRange = new vscode.Range(
                    editor.document.positionAt(0),
                    editor.document.positionAt(html.length)
                );
                const we = new vscode.WorkspaceEdit();
                we.replace(editor.document.uri, fullRange, result.html);
                const ok = await vscode.workspace.applyEdit(we);
                if (!ok) {
                    vscode.window.showErrorMessage('Adway: HTML не обновлён после переименования');
                    return;
                }
                await editor.document.save();
            }
            await diagnosticsProvider.updateDiagnostics(editor.document);
            const preview = result.renamed.slice(0, 6).join('; ') + (result.renamed.length > 6 ? '…' : '');
            vscode.window.showInformationMessage(
                `Adway: расширений восстановлено ${result.renamed.length}` +
                    (result.refsUpdated ? `, ссылок: ${result.refsUpdated}` : '') +
                    (preview ? ` (${preview})` : '')
            );
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => {
            if (doc.languageId === 'html') {
                void diagnosticsProvider.updateDiagnostics(doc);
            }
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.languageId === 'html') {
                diagnosticsProvider.scheduleUpdate(event.document);
            }
        }),
        vscode.workspace.onDidSaveTextDocument(doc => {
            if (doc.languageId === 'html') {
                void diagnosticsProvider.updateDiagnostics(doc);
            }
        })
    );

    // Проверить уже открытые HTML
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.languageId === 'html') {
            void diagnosticsProvider.updateDiagnostics(doc);
        }
    }
}

async function revealResultsLine(
    source: { document: vscode.TextDocument; column: vscode.ViewColumn },
    line: number | undefined,
    file?: string
): Promise<void> {
    const { document: sourceDocument, column: sourceColumn } = source;

    let targetDoc = sourceDocument;
    if (file) {
        const abs = path.resolve(path.dirname(sourceDocument.uri.fsPath), file);
        try {
            targetDoc = await vscode.workspace.openTextDocument(abs);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Adway: не удалось открыть ${file} — ${msg}`);
            return;
        }
    }

    if (line === undefined || Number.isNaN(Number(line))) {
        await vscode.window.showTextDocument(targetDoc, {
            viewColumn: sourceColumn,
            preserveFocus: false,
            preview: false
        });
        return;
    }

    const maxLine = Math.max(0, targetDoc.lineCount - 1);
    const safeLine = Math.min(Math.max(0, Number(line)), maxLine);
    const position = new vscode.Position(safeLine, 0);
    const range = new vscode.Range(
        position,
        new vscode.Position(safeLine, targetDoc.lineAt(safeLine).text.length)
    );

    const shown = await vscode.window.showTextDocument(targetDoc, {
        viewColumn: sourceColumn,
        selection: range,
        preserveFocus: false,
        preview: false
    });
    shown.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

type WebviewResultsContext = {
    index: number;
    line: number;
    file?: string;
    fixCode?: string;
};

/** URL из ошибок Adway «Внешнее изображение/шрифт» (панель + Problems, в т.ч. CSS). */
function collectExternalImageUrlsFromErrors(document: vscode.TextDocument): string[] {
    const urls = new Set<string>();

    const addFromError = (text: string, line?: number, fileUri?: vscode.Uri) => {
        const plain = stripHtml(text);
        if (!/внешнее изображение|внешний шрифт/i.test(plain)) {
            return;
        }
        let url = extractExternalImageUrlFromLine(plain);
        if (!url && line !== undefined && line >= 0) {
            try {
                const doc =
                    fileUri && fileUri.toString() !== document.uri.toString()
                        ? undefined
                        : document;
                if (doc && line < doc.lineCount) {
                    url = extractExternalImageUrlFromLine(doc.lineAt(line).text);
                }
            } catch {
                // ignore
            }
        }
        if (url) {
            urls.add(url);
        }
    };

    for (const result of resultsPanelResults) {
        if (result.success === false) {
            addFromError(result.text, result.line);
        }
    }

    for (const { uri, diagnostic } of diagnosticsProvider.getIssueEntries(document.uri)) {
        if (!diagnostic.source || !/adway/i.test(diagnostic.source)) {
            continue;
        }
        addFromError(diagnostic.message, diagnostic.range.start.line, uri);
        // если URL не вытащили из текста — пробуем строку CSS/HTML
        if (![...urls].some(u => diagnostic.message.includes(u))) {
            try {
                // уже добавили из message; доп. чтение файла для CSS
                if (uri.scheme === 'file' && /\.css$/i.test(uri.fsPath)) {
                    const cssDoc = vscode.workspace.textDocuments.find(
                        d => d.uri.toString() === uri.toString()
                    );
                    const lineText =
                        cssDoc && diagnostic.range.start.line < cssDoc.lineCount
                            ? cssDoc.lineAt(diagnostic.range.start.line).text
                            : undefined;
                    if (lineText) {
                        const u = extractExternalImageUrlFromLine(lineText);
                        if (u) {
                            urls.add(u);
                        }
                    }
                }
            } catch {
                // ignore
            }
        }
    }

    return [...urls];
}

function toContextNumber(value: unknown): number {
    if (typeof value === 'number' && !Number.isNaN(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        if (!Number.isNaN(n)) {
            return n;
        }
    }
    return -1;
}

async function readWebviewContextValue(key: string): Promise<unknown> {
    try {
        return await vscode.commands.executeCommand<unknown>('getContextKeyValue', key);
    } catch {
        return undefined;
    }
}

async function resolveResultsContext(ctx?: unknown): Promise<WebviewResultsContext> {
    const fromObj =
        ctx && typeof ctx === 'object' && !Array.isArray(ctx)
            ? (ctx as Record<string, unknown>)
            : undefined;

    let index = toContextNumber(fromObj?.adwayIndex);
    let line = toContextNumber(fromObj?.adwayLine);
    let file =
        typeof fromObj?.adwayFile === 'string' && fromObj.adwayFile.trim()
            ? fromObj.adwayFile.trim().replace(/\\/g, '/')
            : undefined;
    let fixCode =
        typeof fromObj?.adwayFixCode === 'string' ? fromObj.adwayFixCode : undefined;

    if (index < 0) {
        index = toContextNumber(await readWebviewContextValue('adwayIndex'));
    }
    if (line < 0) {
        line = toContextNumber(await readWebviewContextValue('adwayLine'));
    }
    if (!file) {
        const f = await readWebviewContextValue('adwayFile');
        if (typeof f === 'string' && f.trim()) {
            file = f.trim().replace(/\\/g, '/');
        }
    }
    if (!fixCode) {
        const code = await readWebviewContextValue('adwayFixCode');
        if (typeof code === 'string' && code) {
            fixCode = code;
        }
    }

    if (index < 0 && line >= 0) {
        index = resultsPanelResults.findIndex(
            r => r.line === line && (!file || r.file === file)
        );
    }
    if (index < 0 && fixCode) {
        index = resultsPanelResults.findIndex(
            r =>
                detectCode(stripHtml(r.text).replace(/[✅❌⚠️]/g, '').trim()) === fixCode
        );
    }

    if (index >= 0) {
        const r = resultsPanelResults[index];
        if (line < 0) {
            line = r?.line ?? -1;
        }
        if (!file && r?.file) {
            file = r.file;
        }
    }

    return { index, line, file, fixCode };
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractQuotedPath(text: string): string | undefined {
    const plain = stripHtml(text);
    const m =
        plain.match(/"((?:js|scripts)\/[^"]+\.(?:js|mjs|cjs))"/i) ||
        plain.match(/"([^"]+\.(?:js|mjs|cjs))"/i) ||
        plain.match(/"([^"]+)"/);
    return m?.[1]?.replace(/^\.\//, '');
}

async function pickScriptPathFromContext(
    ctx: unknown,
    html: string,
    htmlDir: string | undefined,
    kind: 'missing' | 'unconnected'
): Promise<string | undefined> {
    const info = await resolveResultsContext(ctx);
    if (info.index >= 0) {
        const fromMsg = extractQuotedPath(resultsPanelResults[info.index]?.text || '');
        if (fromMsg) {
            return fromMsg;
        }
    }

    if (!htmlDir) {
        vscode.window.showInformationMessage('Adway: нет пути к скрипту');
        return undefined;
    }

    const issues = checkScriptAssets(html, htmlDir).filter(i => i.kind === kind);
    if (issues.length === 0) {
        vscode.window.showInformationMessage(
            kind === 'unconnected'
                ? 'Adway: нет неподключённых скриптов в js/'
                : 'Adway: нет битых <script src>'
        );
        return undefined;
    }
    if (issues.length === 1) {
        return issues[0].path;
    }
    const picked = await vscode.window.showQuickPick(
        issues.map(i => ({ label: i.path, path: i.path })),
        {
            title:
                kind === 'unconnected'
                    ? 'Неподключённый скрипт'
                    : 'Битый script src',
            placeHolder: 'Выберите файл'
        }
    );
    return picked?.path;
}

/** Когда фокус в панели результатов — берём HTML из последней проверки. */
async function getHtmlEditorForFix(ctx?: unknown): Promise<vscode.TextEditor | undefined> {
    const info = await resolveResultsContext(ctx);
    const active = vscode.window.activeTextEditor;

    if (active?.document.languageId === 'html') {
        if (
            resultsPanelSource &&
            active.document.uri.toString() === resultsPanelSource.document.uri.toString() &&
            info.line >= 0 &&
            !info.file
        ) {
            await revealResultsLine(resultsPanelSource, info.line);
            return vscode.window.activeTextEditor;
        }
        return active;
    }

    if (resultsPanelSource) {
        // Ошибки из CSS не прыгают в HTML по «чужой» строке
        await revealResultsLine(
            resultsPanelSource,
            info.file ? undefined : info.line >= 0 ? info.line : undefined
        );
        return vscode.window.activeTextEditor;
    }

    const doc = await resolveLandingHtmlDocument({ allowPick: false });
    if (!doc) {
        return undefined;
    }
    return vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
}

const LANDING_ASSET_DIRS = new Set([
    'css',
    'js',
    'images',
    'media',
    'scripts',
    'fonts',
    'other'
]);

function isHtmlDocument(doc: vscode.TextDocument): boolean {
    return (
        doc.languageId === 'html' ||
        /\.html?$/i.test(doc.fileName) ||
        doc.fileName.toLowerCase().endsWith('.htm')
    );
}

function landingRootFromPath(filePath: string): string {
    let dir = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()
        ? filePath
        : path.dirname(filePath);
    const base = path.basename(dir).toLowerCase();
    if (LANDING_ASSET_DIRS.has(base)) {
        dir = path.dirname(dir);
    }
    return dir;
}

function listHtmlFilesInDir(dir: string): string[] {
    try {
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
            return [];
        }
        return fs
            .readdirSync(dir)
            .filter(name => /\.html?$/i.test(name))
            .map(name => path.join(dir, name))
            .sort((a, b) => {
                const aIndex = /index\.html?$/i.test(a) ? 0 : 1;
                const bIndex = /index\.html?$/i.test(b) ? 0 : 1;
                return aIndex - bIndex || a.localeCompare(b);
            });
    } catch {
        return [];
    }
}

/**
 * Найти HTML лендинга: активный HTML → панель результатов → рядом с файлом
 * (если открыт css/js/images) → QuickPick.
 */
async function resolveLandingHtmlDocument(opts?: {
    uri?: vscode.Uri;
    allowPick?: boolean;
}): Promise<vscode.TextDocument | undefined> {
    const allowPick = opts?.allowPick !== false;

    if (opts?.uri?.scheme === 'file') {
        const fsPath = opts.uri.fsPath;
        if (/\.html?$/i.test(fsPath) && fs.existsSync(fsPath)) {
            return vscode.workspace.openTextDocument(opts.uri);
        }
        const root = landingRootFromPath(fsPath);
        const htmls = listHtmlFilesInDir(root);
        if (htmls.length === 1) {
            return vscode.workspace.openTextDocument(htmls[0]);
        }
        if (htmls.length > 1 && allowPick) {
            const picked = await vscode.window.showQuickPick(
                htmls.map(p => ({
                    label: path.basename(p),
                    description: path.dirname(p),
                    path: p
                })),
                { title: 'Adway: какой HTML проверить?', placeHolder: 'Выберите лендинг' }
            );
            if (picked) {
                return vscode.workspace.openTextDocument(picked.path);
            }
            return undefined;
        }
    }

    if (resultsPanelSource?.document && isHtmlDocument(resultsPanelSource.document)) {
        return resultsPanelSource.document;
    }

    const active = vscode.window.activeTextEditor?.document;
    if (active && isHtmlDocument(active)) {
        return active;
    }

    if (active?.uri.scheme === 'file') {
        const root = landingRootFromPath(active.uri.fsPath);
        const htmls = listHtmlFilesInDir(root);
        if (htmls.length === 1) {
            return vscode.workspace.openTextDocument(htmls[0]);
        }
        if (htmls.length > 1 && allowPick) {
            const picked = await vscode.window.showQuickPick(
                htmls.map(p => ({
                    label: path.basename(p),
                    description: path.dirname(p),
                    path: p
                })),
                { title: 'Adway: какой HTML проверить?', placeHolder: 'Выберите лендинг' }
            );
            if (picked) {
                return vscode.workspace.openTextDocument(picked.path);
            }
            return undefined;
        }
    }

    if (!allowPick) {
        return undefined;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
        return undefined;
    }

    const found = await vscode.workspace.findFiles('**/*.{html,htm}', '**/node_modules/**', 30);
    if (found.length === 0) {
        return undefined;
    }
    if (found.length === 1) {
        return vscode.workspace.openTextDocument(found[0]);
    }
    const picked = await vscode.window.showQuickPick(
        found.map(u => ({
            label: path.basename(u.fsPath),
            description: vscode.workspace.asRelativePath(u),
            uri: u
        })),
        { title: 'Adway: какой HTML проверить?', placeHolder: 'Выберите лендинг' }
    );
    return picked ? vscode.workspace.openTextDocument(picked.uri) : undefined;
}

/** После записи CSS на диск — обновить открытые редакторы. */
async function syncOpenFilesFromDisk(absPaths: string[]): Promise<void> {
    for (const abs of absPaths) {
        const norm = path.normalize(abs);
        let diskText = '';
        try {
            diskText = fs.readFileSync(norm, 'utf8');
        } catch {
            continue;
        }
        const open = vscode.workspace.textDocuments.find(
            d => d.uri.scheme === 'file' && path.normalize(d.uri.fsPath) === norm
        );
        if (!open || open.getText() === diskText) {
            continue;
        }
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            open.uri,
            new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)),
            diskText
        );
        await vscode.workspace.applyEdit(edit);
    }
}

async function showFixesFromWebviewContext(ctx?: unknown): Promise<void> {
    const info = await resolveResultsContext(ctx);
    const result = info.index >= 0 ? resultsPanelResults[info.index] : undefined;
    const fixes = result
        ? getFixesForMessage(result.text)
        : getFixesForCode(info.fixCode);

    if (fixes.length === 0) {
        vscode.window.showInformationMessage('Adway: для этого пункта нет команды исправления');
        return;
    }

    await getHtmlEditorForFix(ctx);

    const picked = await vscode.window.showQuickPick(
        fixes.map(f => ({ label: f.label, command: f.command })),
        {
            title: 'Исправление',
            placeHolder: 'Выберите команду'
        }
    );
    if (picked) {
        await vscode.commands.executeCommand(picked.command, ctx);
    }
}

/** command: URI для webview (ЛКМ без скриптов). */
function webviewCommandUri(command: string, ...args: unknown[]): string {
    return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

function escapeAttr(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderResultItem(result: CheckResult, cssClass: string, index: number): string {
    const hasLine = result.line !== undefined;
    const fileLabel = result.file ? path.basename(result.file) : '';
    const lineNumberBadge = hasLine
        ? `<span class="line-number">${fileLabel ? escapeAttr(fileLabel) + ':' : ''}стр. ${(result.line ?? 0) + 1}</span>`
        : result.file
          ? `<span class="line-number">${escapeAttr(fileLabel)}</span>`
          : '';
    const canFix = cssClass === 'error' || cssClass === 'warning';
    const goHref = webviewCommandUri(
        'adway.resultsGoTo',
        hasLine ? result.line : -1,
        result.file ?? null
    );
    const tip = result.file
        ? canFix
            ? 'ЛКМ — открыть файл · ПКМ — исправить'
            : 'ЛКМ — открыть файл'
        : canFix
          ? 'ЛКМ — к строке · ПКМ — исправить'
          : 'ЛКМ — к строке';
    const fixCode = canFix
        ? detectCode(stripHtml(result.text).replace(/[✅❌⚠️]/g, '').trim())
        : undefined;
    const vscodeContext = {
        webviewSection: 'adwayResult',
        preventDefaultContextMenuItems: true,
        adwayIndex: index,
        adwayLine: hasLine ? result.line : -1,
        adwayCanFix: canFix,
        ...(result.file ? { adwayFile: result.file } : {}),
        ...(fixCode ? { adwayFixCode: fixCode } : {})
    };
    const contextAttr = JSON.stringify(vscodeContext).replace(/'/g, '&#39;');

    return `<div class="result-item ${cssClass}"
        data-vscode-context='${contextAttr}'
        title="${tip}">
        <a class="result-main clickable" href="${goHref}">
            ${lineNumberBadge}
            <span class="result-text">${result.text}</span>
        </a>
    </div>`;
}

function generateResultsHtml(results: CheckResult[]): string {
    const errors = results.filter(r => r.success === false);
    const warnings = results.filter(r => r.success === 'warning');
    const successes = results.filter(r => r.success === true);

    let html = `<!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <style>
            body {
                font-family: var(--vscode-font-family);
                color: var(--vscode-foreground);
                background-color: var(--vscode-editor-background);
                padding: 20px;
            }
            .result-group {
                margin-bottom: 20px;
                border-left: 4px solid;
                padding-left: 15px;
            }
            .error-group {
                border-color: var(--vscode-errorForeground);
            }
            .warning-group {
                border-color: var(--vscode-editorWarning-foreground, #cca700);
            }
            .success-group {
                border-color: var(--vscode-testing-iconPassed);
            }
            .group-title {
                font-size: 18px;
                font-weight: bold;
                margin-bottom: 10px;
            }
            .result-item {
                margin: 5px 0;
                border-radius: 4px;
                background-color: var(--vscode-editor-inactiveSelectionBackground);
                display: flex;
                align-items: stretch;
                user-select: none;
            }
            .result-main {
                flex: 1;
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 8px;
                text-decoration: none;
                color: inherit;
                min-width: 0;
            }
            .result-main.clickable {
                cursor: pointer;
            }
            .result-item:hover {
                background-color: var(--vscode-list-hoverBackground);
            }
            .line-number {
                background-color: var(--vscode-badge-background);
                color: var(--vscode-badge-foreground);
                padding: 2px 6px;
                border-radius: 3px;
                font-size: 11px;
                font-weight: bold;
                min-width: 40px;
                text-align: center;
                flex-shrink: 0;
            }
            .result-text {
                flex: 1;
                min-width: 0;
            }
            .error {
                color: var(--vscode-errorForeground);
            }
            .warning {
                color: var(--vscode-editorWarning-foreground, #cca700);
            }
            .success {
                color: var(--vscode-testing-iconPassed);
            }
            .value-highlight {
                background-color: var(--vscode-editor-selectionBackground);
                padding: 2px 4px;
                border-radius: 3px;
                font-family: 'Courier New', monospace;
            }
        </style>
    </head>
    <body>`;

    let itemIndex = 0;

    if (errors.length > 0) {
        html += `<div class="result-group error-group">
            <div class="group-title">Ошибки (${errors.length})</div>`;
        errors.forEach(result => {
            html += renderResultItem(result, 'error', itemIndex++);
        });
        html += `</div>`;
    }

    if (warnings.length > 0) {
        html += `<div class="result-group warning-group">
            <div class="group-title">Предупреждения (${warnings.length})</div>`;
        warnings.forEach(result => {
            html += renderResultItem(result, 'warning', itemIndex++);
        });
        html += `</div>`;
    }

    if (successes.length > 0) {
        html += `<div class="result-group success-group">
            <div class="group-title">Успешные проверки (${successes.length})</div>`;
        successes.forEach(result => {
            html += renderResultItem(result, 'success', itemIndex++);
        });
        html += `</div>`;
    }

    html += `</body></html>`;
    return html;
}

export function deactivate() {
    // disposed via subscriptions
}
