import * as vscode from 'vscode';
import { CheckResult, LandingChecker } from './checker';
import { AdwayCodeActionProvider, buildFixEdit, FixId, fixAllLocalPaths } from './codeActions';
import { cleanupLanding } from './cleanup';
import { AdwayDiagnostics } from './diagnostics';
import { normalizeAnchorHrefs } from './normalizeHrefs';
import { AdwayResultsTreeProvider } from './resultsTree';
import { initSheets, getSheetsDirectory } from './sheets';
import { initProjectStructureCommand } from './projectStructure';
import { SnippetProvider } from './snippets';
import { AdwayStatusBar } from './statusBar';

let diagnosticsProvider: AdwayDiagnostics;
let statusBar: AdwayStatusBar;
let resultsTree: AdwayResultsTreeProvider;

export function activate(context: vscode.ExtensionContext) {
    console.log('Adway Checker активирован');

    initSheets(context);

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

    async function runActiveFix(fixId: FixId, okMessage: string) {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'html') {
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

    const checkCommand = vscode.commands.registerCommand('adway.checkLanding', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('Нет активного редактора');
            return;
        }

        if (editor.document.languageId !== 'html') {
            vscode.window.showErrorMessage('Команда работает только для HTML файлов');
            return;
        }

        await diagnosticsProvider.updateDiagnostics(editor.document);

        const checker = new LandingChecker(editor.document);
        const results = await checker.check();

        // Запоминаем основной редактор — клик по ошибке вернёт туда, а не в колонку отчёта
        const sourceDocument = editor.document;
        const sourceColumn = editor.viewColumn ?? vscode.ViewColumn.One;

        const panel = vscode.window.createWebviewPanel(
            'adwayResults',
            'Результаты проверки Adway',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: false
            }
        );

        panel.webview.html = generateResultsHtml(results);

        panel.webview.onDidReceiveMessage(
            async message => {
                if (message.command === 'goToLine') {
                    const line = Number(message.line) || 0;
                    const maxLine = Math.max(0, sourceDocument.lineCount - 1);
                    const safeLine = Math.min(Math.max(0, line), maxLine);
                    const position = new vscode.Position(safeLine, 0);
                    const range = new vscode.Range(
                        position,
                        new vscode.Position(safeLine, sourceDocument.lineAt(safeLine).text.length)
                    );

                    const shown = await vscode.window.showTextDocument(sourceDocument, {
                        viewColumn: sourceColumn,
                        selection: range,
                        preserveFocus: false,
                        preview: false
                    });
                    shown.revealRange(range, vscode.TextEditorRevealType.InCenter);
                }
            },
            undefined,
            context.subscriptions
        );
    });

    const snippetProvider = new SnippetProvider();

    context.subscriptions.push(
        checkCommand,
        vscode.commands.registerCommand('adway.insertJquery', () => snippetProvider.insertJquery()),
        vscode.commands.registerCommand('adway.insertScripts', () => snippetProvider.insertScripts()),
        vscode.commands.registerCommand('adway.insertHiddenInputs', () => snippetProvider.insertHiddenInputs()),
        vscode.commands.registerCommand('adway.insertForm', () => snippetProvider.insertForm()),
        vscode.commands.registerCommand('adway.insertDate', () => snippetProvider.insertDate()),
        vscode.commands.registerCommand('adway.insertVideoScript', () => snippetProvider.insertVideoScript()),
        vscode.commands.registerCommand('adway.openSnippets', () => snippetProvider.showSnippetsPicker()),
        vscode.commands.registerCommand('adway.initProjectStructure', () => initProjectStructureCommand()),
        vscode.commands.registerCommand('adway.insertDoctype', () => runActiveFix('doctype', 'Adway: вставлен DOCTYPE')),
        vscode.commands.registerCommand('adway.removeBase', () => runActiveFix('base', 'Adway: <base> удалён')),
        vscode.commands.registerCommand('adway.removeTarget', () => runActiveFix('removeTarget', 'Adway: target удалены')),
        vscode.commands.registerCommand('adway.flattenPicture', () => runActiveFix('flattenPicture', 'Adway: <source> убраны')),
        vscode.commands.registerCommand('adway.insertLazy', () => runActiveFix('lazy', 'Adway: lazy loading вставлен')),
        vscode.commands.registerCommand('adway.insertScroll', () => runActiveFix('scroll', 'Adway: скрипт прокрутки вставлен')),
        vscode.commands.registerCommand('adway.insertValidation', () => runActiveFix('validation', 'Adway: валидаторы вставлены')),
        vscode.commands.registerCommand('adway.fixValidationName', () =>
            runActiveFix('validationReplaceName', 'Adway: валидатор имени обновлён')
        ),
        vscode.commands.registerCommand('adway.addOneform', () => runActiveFix('oneform', 'Adway: id="oneform" добавлен')),
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
        vscode.commands.registerCommand('adway.normalizeHrefs', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('Нет активного редактора');
                return;
            }
            if (editor.document.languageId !== 'html') {
                vscode.window.showErrorMessage('Команда работает только для HTML файлов');
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
                normalizeHrefs: true
            });

            if (
                result.removedTargets === 0 &&
                result.flattenedPictures === 0 &&
                result.replacedHrefs === 0
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
            vscode.window.showInformationMessage(`Adway: почищено (${parts.join(', ')})`);
        }),
        vscode.commands.registerCommand('adway.fixOrderForm', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('Нет активного редактора');
                return;
            }
            if (editor.document.languageId !== 'html') {
                vscode.window.showErrorMessage('Команда работает только для HTML файлов');
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
        vscode.commands.registerCommand('adway.fixLocalPath', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'html') {
                vscode.window.showErrorMessage('Откройте HTML файл');
                return;
            }
            const edit = buildFixEdit(editor.document, 'fixLocalPath', editor.selection.active.line);
            if (!edit) {
                vscode.window.showInformationMessage(
                    'Adway: на этой строке нечего чинить (нет файла в images/css/js)'
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
        vscode.commands.registerCommand('adway.fixAllLocalPaths', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'html') {
                vscode.window.showErrorMessage('Откройте HTML файл');
                return;
            }
            const edit = fixAllLocalPaths(editor.document);
            if (!edit) {
                vscode.window.showInformationMessage(
                    'Adway: нет путей, которые можно заменить на images/css/js'
                );
                return;
            }
            const ok = await vscode.workspace.applyEdit(edit);
            if (!ok) {
                vscode.window.showErrorMessage('Adway: пути не исправлены');
                return;
            }
            await diagnosticsProvider.updateDiagnostics(editor.document);
            vscode.window.showInformationMessage('Adway: все найденные пути исправлены');
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

function renderResultItem(result: CheckResult, cssClass: string): string {
    const hasLine = result.line !== undefined;
    const clickableClass = hasLine ? 'clickable' : '';
    const onclick = hasLine ? `onclick="goToLine(${result.line})"` : '';
    const lineNumberBadge = hasLine ? `<span class="line-number">строка ${(result.line ?? 0) + 1}</span>` : '';
    return `<div class="result-item ${cssClass} ${clickableClass}" ${onclick}>
        ${lineNumberBadge}
        <span class="result-text">${result.text}</span>
    </div>`;
}

function generateResultsHtml(results: CheckResult[]): string {
    const errors = results.filter(r => r.success === false);
    const warnings = results.filter(r => r.success === 'warning');
    const successes = results.filter(r => r.success === true);

    let html = `<!DOCTYPE html>
    <html>
    <head>
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
                padding: 8px;
                margin: 5px 0;
                border-radius: 4px;
                background-color: var(--vscode-editor-inactiveSelectionBackground);
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .result-item.clickable {
                cursor: pointer;
                transition: background-color 0.2s;
            }
            .result-item.clickable:hover {
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
            }
            .result-text {
                flex: 1;
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

    if (errors.length > 0) {
        html += `<div class="result-group error-group">
            <div class="group-title">🔴 Ошибки (${errors.length})</div>`;
        errors.forEach(result => {
            html += renderResultItem(result, 'error');
        });
        html += `</div>`;
    }

    if (warnings.length > 0) {
        html += `<div class="result-group warning-group">
            <div class="group-title">⚠️ Предупреждения (${warnings.length})</div>`;
        warnings.forEach(result => {
            html += renderResultItem(result, 'warning');
        });
        html += `</div>`;
    }

    if (successes.length > 0) {
        html += `<div class="result-group success-group">
            <div class="group-title">✅ Успешные проверки (${successes.length})</div>`;
        successes.forEach(result => {
            html += renderResultItem(result, 'success');
        });
        html += `</div>`;
    }

    html += `
        <script>
            const vscode = acquireVsCodeApi();
            
            function goToLine(line) {
                vscode.postMessage({
                    command: 'goToLine',
                    line: line
                });
            }
        </script>
    </body></html>`;
    return html;
}

export function deactivate() {
    // disposed via subscriptions
}
