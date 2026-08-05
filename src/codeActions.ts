import * as path from 'path';
import * as vscode from 'vscode';
import { findFormRanges } from './checker';
import { cleanupLanding, flattenPictureSources, removeHtmlComments, removeTargetAttributes } from './cleanup';
import { AdwayDiagnosticCodes } from './diagnostics';
import { findMissingLocalPaths, fixCssLocalPaths } from './filePaths';
import { normalizeAnchorHrefs } from './normalizeHrefs';
import {
    FORM_SNIPPET,
    HIDDEN_INPUTS,
    JQUERY_SNIPPET,
    LAZY_SCRIPT,
    REQUIRED_SCRIPTS,
    SCROLL_SCRIPT,
    VALIDATION_SCRIPT
} from './snippetTexts';

export type FixId =
    | 'jquery'
    | 'lazy'
    | 'scroll'
    | 'validation'
    | 'validationAll'
    | 'validationReplaceName'
    | 'validationInsertNew'
    | 'hidden'
    | 'form'
    | 'fixForm'
    | 'doctype'
    | 'method'
    | 'action'
    | 'required'
    | 'oneform'
    | 'base'
    | 'hrefNormalize'
    | 'removeTarget'
    | 'flattenPicture'
    | 'cleanupLanding'
    | 'fixLocalPath'
    | 'removeComments';

const REQUIRED_HIDDEN: Array<{ name: string; snippet: string }> = [
    { name: 'fbpx', snippet: '<input type="hidden" name="fbpx" value="{fbpx}">' },
    { name: 'utm_code', snippet: '<input type="hidden" name="utm_code" value="{subid}">' },
    { name: 'cid', snippet: '<input type="hidden" name="cid" value="{campaign_id}">' },
    { name: 'sid', snippet: '<input type="hidden" name="sid" value="">' },
    { name: 'hash', snippet: '<input type="hidden" name="hash" value="{hash}">' },
    { name: 'country', snippet: '<input type="hidden" name="country" value="">' }
];

function pickFormRange(document: vscode.TextDocument, line: number) {
    const html = document.getText();
    const ranges = findFormRanges(html);
    if (ranges.length === 0) {
        return null;
    }
    const offset = document.offsetAt(new vscode.Position(Math.min(line, document.lineCount - 1), 0));
    const inside = ranges.find(r => offset >= r.start && offset <= r.end);
    if (inside) {
        return inside;
    }
    return ranges.reduce((best, r) =>
        Math.abs(r.start - offset) < Math.abs(best.start - offset) ? r : best
    );
}

function addRequiredOnNamedInputs(formHtml: string): string {
    return formHtml.replace(
        /<input\b([^>]*?)>/gi,
        (full, attrs: string) => {
            const nameMatch = attrs.match(/\bname\s*=\s*(["'])(name|phone)\1/i);
            if (!nameMatch) {
                return full;
            }
            if (/\brequired\b/i.test(attrs)) {
                return full;
            }
            return `<input${attrs} required>`;
        }
    );
}

/**
 * Чинит одну форму на месте: action, method, target, oneform, required, недостающие 6 hidden.
 * Чужие hidden / разметку полей не удаляет.
 */
export function fixOrderFormHtml(formHtml: string): { html: string; changed: boolean } {
    const openRe = /<form\b[^>]*>/i;
    const openMatch = formHtml.match(openRe);
    if (!openMatch || openMatch.index === undefined) {
        return { html: formHtml, changed: false };
    }

    let openTag = openMatch[0];
    const before = formHtml.slice(0, openMatch.index);
    let rest = formHtml.slice(openMatch.index + openTag.length);

    // target с формы
    openTag = openTag.replace(/\s+target\s*=\s*(["'][^"']*["']|[^\s>]+)/gi, '');

    // action
    if (/action\s*=/i.test(openTag)) {
        openTag = openTag.replace(/action\s*=\s*(['"])[^'"]*\1/i, 'action="/order.php"');
    } else {
        openTag = openTag.replace(/<form\b/i, '<form action="/order.php"');
    }

    // method
    if (/method\s*=/i.test(openTag)) {
        openTag = openTag.replace(/method\s*=\s*(['"])[^'"]*\1/i, 'method="post"');
    } else {
        openTag = openTag.replace(/<form\b/i, '<form method="post"');
    }

    // id="oneform"
    if (!/\bid\s*=\s*(['"])oneform\1/i.test(openTag)) {
        if (/\bid\s*=/i.test(openTag)) {
            openTag = openTag.replace(/\bid\s*=\s*(['"])[^'"]*\1/i, 'id="oneform"');
        } else {
            openTag = openTag.replace(/<form\b/i, '<form id="oneform"');
        }
    }

    let body = addRequiredOnNamedInputs(rest);

    const missingSnippets: string[] = [];
    for (const field of REQUIRED_HIDDEN) {
        const re = new RegExp(
            `<input\\b[^>]*\\bname\\s*=\\s*(['"])${field.name}\\1[^>]*>`,
            'i'
        );
        if (!re.test(openTag + body)) {
            missingSnippets.push(field.snippet);
        }
    }

    if (missingSnippets.length > 0) {
        const closeIdx = body.toLowerCase().lastIndexOf('</form>');
        const block = missingSnippets.join('\n') + '\n';
        if (closeIdx === -1) {
            body = body + '\n' + block;
        } else {
            body = body.slice(0, closeIdx) + block + body.slice(closeIdx);
        }
    }

    const next = before + openTag + body;
    return { html: next, changed: next !== formHtml };
}

function fixOrderFormInPlace(document: vscode.TextDocument, line: number): vscode.WorkspaceEdit | null {
    const html = document.getText();
    const range = pickFormRange(document, line);
    if (!range) {
        return null;
    }
    const formHtml = html.slice(range.start, range.end);
    const { html: nextForm, changed } = fixOrderFormHtml(formHtml);
    if (!changed) {
        return null;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
        document.uri,
        new vscode.Range(document.positionAt(range.start), document.positionAt(range.end)),
        nextForm
    );
    return edit;
}

function insertAfterOpenTag(document: vscode.TextDocument, openTagRe: RegExp, text: string): vscode.WorkspaceEdit | null {
    const html = document.getText();
    const match = html.match(openTagRe);
    if (!match || match.index === undefined) {
        return null;
    }
    const pos = document.positionAt(match.index + match[0].length);
    const edit = new vscode.WorkspaceEdit();
    // всегда с новой строки, чтобы не прилипало к <html>/<head>…
    const chunk = text.trim();
    edit.insert(document.uri, pos, `\n  ${chunk}\n`);
    return edit;
}

function insertBeforeCloseTag(document: vscode.TextDocument, closeTag: string, text: string): vscode.WorkspaceEdit | null {
    const html = document.getText();
    const idx = html.toLowerCase().lastIndexOf(closeTag.toLowerCase());
    if (idx === -1) {
        return null;
    }
    const pos = document.positionAt(idx);
    const edit = new vscode.WorkspaceEdit();
    const chunk = text.trim();
    // перевод строки до и после — не в одну строку с соседним тегом
    const needNlBefore = idx > 0 && html[idx - 1] !== '\n';
    edit.insert(document.uri, pos, `${needNlBefore ? '\n' : ''}  ${chunk}\n`);
    return edit;
}

function insertAtLine(document: vscode.TextDocument, line: number, text: string): vscode.WorkspaceEdit {
    const safeLine = Math.min(Math.max(line, 0), Math.max(0, document.lineCount - 1));
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(safeLine, 0), text + '\n');
    return edit;
}

function replaceFullDocument(document: vscode.TextDocument, next: string): vscode.WorkspaceEdit | null {
    const html = document.getText();
    if (next === html) {
        return null;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
        document.uri,
        new vscode.Range(document.positionAt(0), document.positionAt(html.length)),
        next
    );
    return edit;
}

function replaceInDocument(document: vscode.TextDocument, search: RegExp, replacement: string): vscode.WorkspaceEdit | null {
    const html = document.getText();
    search.lastIndex = 0;
    if (!search.test(html)) {
        return null;
    }
    search.lastIndex = 0;
    const next = html.replace(search, replacement);
    return replaceFullDocument(document, next);
}

function addAttributeOnLine(document: vscode.TextDocument, line: number, attr: string): vscode.WorkspaceEdit | null {
    const safeLine = Math.min(Math.max(line, 0), Math.max(0, document.lineCount - 1));
    const text = document.lineAt(safeLine).text;
    if (new RegExp(`\\b${attr.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text) ||
        text.includes(attr.trim())) {
        return null;
    }
    const m = text.match(/^(.*?)(\s*\/?>)(\s*)$/);
    if (!m) {
        return null;
    }
    const next = `${m[1]} ${attr.trim()}${m[2]}${m[3]}`;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, document.lineAt(safeLine).range, next);
    return edit;
}

function fixActionOnLine(document: vscode.TextDocument, line: number): vscode.WorkspaceEdit | null {
    const safeLine = Math.min(Math.max(line, 0), Math.max(0, document.lineCount - 1));
    const text = document.lineAt(safeLine).text;
    if (!/action\s*=/i.test(text)) {
        const html = document.getText();
        const formMatch = html.match(/<form\b[^>]*>/i);
        if (!formMatch || formMatch.index === undefined) {
            return null;
        }
        const original = formMatch[0];
        let next: string;
        if (/action\s*=/i.test(original)) {
            next = original.replace(/action\s*=\s*(['"])[^'"]*\1/i, 'action="/order.php"');
        } else {
            next = original.replace(/<form\b/i, '<form action="/order.php"');
        }
        if (next === original) {
            return null;
        }
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            document.uri,
            new vscode.Range(
                document.positionAt(formMatch.index),
                document.positionAt(formMatch.index + original.length)
            ),
            next
        );
        return edit;
    }
    const next = text.replace(/action\s*=\s*(['"])[^'"]*\1/i, 'action="/order.php"');
    if (next === text) {
        return null;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, document.lineAt(safeLine).range, next);
    return edit;
}

/** Вставить 6 hidden перед </form>, ближайшим к line (или первая форма). */
function insertHiddenBeforeFormClose(document: vscode.TextDocument, line: number): vscode.WorkspaceEdit | null {
    const html = document.getText();
    const ranges = findFormRanges(html);
    if (ranges.length === 0) {
        return insertAtLine(document, line, HIDDEN_INPUTS);
    }

    const offset = document.offsetAt(new vscode.Position(Math.min(line, document.lineCount - 1), 0));
    let range = ranges.find(r => offset >= r.start && offset <= r.end);
    if (!range) {
        range = ranges.reduce((best, r) =>
            Math.abs(r.start - offset) < Math.abs(best.start - offset) ? r : best
        );
    }

    const formHtml = html.slice(range.start, range.end);
    const closeIdx = formHtml.toLowerCase().lastIndexOf('</form>');
    if (closeIdx === -1) {
        return insertAtLine(document, line, HIDDEN_INPUTS);
    }
    const insertAt = range.start + closeIdx;
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, document.positionAt(insertAt), HIDDEN_INPUTS + '\n');
    return edit;
}

function fixLocalPathOnLine(document: vscode.TextDocument, line: number): vscode.WorkspaceEdit | null {
    if (document.uri.scheme !== 'file') {
        return null;
    }
    const html = document.getText();
    const htmlDir = path.dirname(document.uri.fsPath);
    const issues = findMissingLocalPaths(html, htmlDir).filter(i => i.suggestedUrl);
    if (issues.length === 0) {
        return null;
    }

    const lineStart = document.offsetAt(new vscode.Position(Math.min(line, document.lineCount - 1), 0));
    const lineEnd =
        line + 1 < document.lineCount
            ? document.offsetAt(new vscode.Position(line + 1, 0))
            : html.length;
    const lineText = document.lineAt(Math.min(line, document.lineCount - 1)).text;

    // строка с link на css — чиним url() внутри этого CSS
    const cssFromLine = issues.find(
        i =>
            i.cssFile &&
            (lineText.includes(i.cssFile) ||
                lineText.toLowerCase().includes(path.basename(i.cssFile).toLowerCase()))
    );
    if (cssFromLine?.cssFile) {
        const only = findMissingLocalPaths(html, htmlDir).filter(
            i => i.cssFile === cssFromLine.cssFile && i.suggestedUrl
        );
        // временно: fixCssLocalPaths правит все CSS — ок для одной команды
        const r = fixCssLocalPaths(html, htmlDir);
        if (r.fixed > 0) {
            // HTML не менялся — вернём пустой replace той же строки как сигнал успеха? 
            // Лучше null и пусть extension вызывает fixCss — для buildFixEdit вернём no-op
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                document.uri,
                new vscode.Range(line, 0, line, lineText.length),
                lineText
            );
            return edit;
        }
        if (only.length === 0) {
            return null;
        }
    }

    const htmlIssues = issues.filter(i => !i.cssFile);
    const onLine =
        htmlIssues.find(i => {
            const idx = html.indexOf(i.search);
            return idx >= lineStart && idx < lineEnd;
        }) ||
        htmlIssues.find(i => {
            const idx = html.indexOf(i.url);
            return idx >= lineStart && idx < lineEnd;
        }) ||
        htmlIssues[0];

    if (!onLine) {
        // только CSS-проблемы — поправить все CSS
        const r = fixCssLocalPaths(html, htmlDir);
        if (r.fixed === 0) {
            return null;
        }
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            document.uri,
            new vscode.Range(line, 0, line, lineText.length),
            lineText
        );
        return edit;
    }

    return applyLocalPathFix(document, html, onLine);
}

/** Исправить все пути в HTML + url() в CSS. */
export function fixAllLocalPathsWithCss(document: vscode.TextDocument): {
    edit: vscode.WorkspaceEdit | null;
    cssFixed: number;
    cssFiles: string[];
} {
    if (document.uri.scheme !== 'file') {
        return { edit: null, cssFixed: 0, cssFiles: [] };
    }
    const html = document.getText();
    const htmlDir = path.dirname(document.uri.fsPath);
    const cssFix = fixCssLocalPaths(html, htmlDir);

    const issues = findMissingLocalPaths(html, htmlDir).filter(i => i.suggestedUrl && !i.cssFile);
    if (issues.length === 0) {
        return { edit: null, cssFixed: cssFix.fixed, cssFiles: cssFix.files };
    }

    const sorted = [...issues].sort((a, b) => html.lastIndexOf(a.search) - html.lastIndexOf(b.search));
    let current = html;
    let changed = false;
    for (const issue of sorted) {
        if (!issue.suggestedUrl) {
            continue;
        }
        const quoteMatch = issue.search.match(/^(src|href|srcset|poster|data)\s*=\s*(["'])([\s\S]*)\2$/i);
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

    return {
        edit: changed && current !== html ? replaceFullDocument(document, current) : null,
        cssFixed: cssFix.fixed,
        cssFiles: cssFix.files
    };
}

/** Обратная совместимость: только WorkspaceEdit для HTML (CSS чинится через WithCss). */
export function fixAllLocalPaths(document: vscode.TextDocument): vscode.WorkspaceEdit | null {
    return fixAllLocalPathsWithCss(document).edit;
}

function applyLocalPathFix(
    document: vscode.TextDocument,
    html: string,
    issue: { url: string; search: string; suggestedUrl?: string }
): vscode.WorkspaceEdit | null {
    if (!issue.suggestedUrl) {
        return null;
    }

    const quoteMatch = issue.search.match(/^(src|href|srcset|poster|data)\s*=\s*(["'])([\s\S]*)\2$/i);
    let nextAttr: string | null = null;
    if (quoteMatch) {
        const attr = quoteMatch[1];
        const q = quoteMatch[2];
        const value = quoteMatch[3];
        if (/^srcset$/i.test(attr) && value.includes(issue.url)) {
            nextAttr = `${attr}=${q}${value.replace(issue.url, issue.suggestedUrl)}${q}`;
        } else {
            nextAttr = `${attr}=${q}${issue.suggestedUrl}${q}`;
        }
    }

    if (nextAttr) {
        const idx = html.indexOf(issue.search);
        if (idx === -1) {
            return null;
        }
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            document.uri,
            new vscode.Range(document.positionAt(idx), document.positionAt(idx + issue.search.length)),
            nextAttr
        );
        return edit;
    }

    if (html.includes(issue.url)) {
        const edit = new vscode.WorkspaceEdit();
        const idx = html.indexOf(issue.url);
        edit.replace(
            document.uri,
            new vscode.Range(document.positionAt(idx), document.positionAt(idx + issue.url.length)),
            issue.suggestedUrl
        );
        return edit;
    }
    return null;
}

/** Строит WorkspaceEdit для fixId. */
export function buildFixEdit(
    document: vscode.TextDocument,
    fixId: FixId,
    line = 0
): vscode.WorkspaceEdit | null {
    switch (fixId) {
        case 'jquery':
            return (
                insertAfterOpenTag(document, /<head\b[^>]*>/i, JQUERY_SNIPPET) ||
                insertBeforeCloseTag(document, '</head>', JQUERY_SNIPPET) ||
                insertAfterOpenTag(document, /<html\b[^>]*>/i, JQUERY_SNIPPET) ||
                insertAtLine(document, line, JQUERY_SNIPPET)
            );
        case 'lazy':
            return (
                insertBeforeCloseTag(document, '</body>', LAZY_SCRIPT) ||
                insertAtLine(document, line, LAZY_SCRIPT)
            );
        case 'scroll':
            return (
                insertBeforeCloseTag(document, '</body>', SCROLL_SCRIPT) ||
                insertAtLine(document, line, SCROLL_SCRIPT)
            );
        case 'validation':
            return (
                insertBeforeCloseTag(document, '</body>', VALIDATION_SCRIPT) ||
                insertAtLine(document, line, VALIDATION_SCRIPT)
            );
        case 'validationAll':
            return (
                insertBeforeCloseTag(document, '</body>', REQUIRED_SCRIPTS) ||
                insertAtLine(document, line, REQUIRED_SCRIPTS)
            );
        case 'validationReplaceName':
            return replaceInDocument(
                document,
                /\/\[\^a-zA-Zа-яА-ЯёЁіїіЇ\\s\]\/g/g,
                '/[^\\p{L}\\s]/gu'
            );
        case 'validationInsertNew':
            return (
                insertBeforeCloseTag(document, '</body>', VALIDATION_SCRIPT) ||
                insertAtLine(document, line, VALIDATION_SCRIPT)
            );
        case 'hidden':
            return insertHiddenBeforeFormClose(document, line);
        case 'fixForm':
            return fixOrderFormInPlace(document, line);
        case 'fixLocalPath':
            return fixLocalPathOnLine(document, line);
        case 'form':
            return (
                insertBeforeCloseTag(document, '</body>', FORM_SNIPPET) ||
                insertAtLine(document, line, FORM_SNIPPET)
            );
        case 'doctype': {
            const edit = new vscode.WorkspaceEdit();
            edit.insert(document.uri, new vscode.Position(0, 0), '<!DOCTYPE html>\n');
            return edit;
        }
        case 'method':
            return addAttributeOnLine(document, line, 'method="post"') || (() => {
                const html = document.getText();
                const formMatch = html.match(/<form\b[^>]*>/i);
                if (!formMatch || formMatch.index === undefined) {
                    return null;
                }
                if (/method\s*=/i.test(formMatch[0])) {
                    return null;
                }
                const next = formMatch[0].replace(/<form\b/i, '<form method="post"');
                const e = new vscode.WorkspaceEdit();
                e.replace(
                    document.uri,
                    new vscode.Range(
                        document.positionAt(formMatch.index),
                        document.positionAt(formMatch.index + formMatch[0].length)
                    ),
                    next
                );
                return e;
            })();
        case 'action':
            return fixActionOnLine(document, line);
        case 'required':
            return addAttributeOnLine(document, line, 'required');
        case 'oneform': {
            const html = document.getText();
            if (/id\s*=\s*["']oneform["']/i.test(html)) {
                return null;
            }
            const formMatch = html.match(/<form\b[^>]*>/i);
            if (!formMatch || formMatch.index === undefined) {
                return null;
            }
            const edit = new vscode.WorkspaceEdit();
            edit.insert(document.uri, document.positionAt(formMatch.index + '<form'.length), ' id="oneform"');
            return edit;
        }
        case 'hrefNormalize': {
            const { html: next, replaced } = normalizeAnchorHrefs(document.getText());
            if (replaced === 0) {
                return null;
            }
            return replaceFullDocument(document, next);
        }
        case 'removeTarget': {
            const { html: next, removed } = removeTargetAttributes(document.getText());
            if (removed === 0) {
                return null;
            }
            return replaceFullDocument(document, next);
        }
        case 'flattenPicture': {
            const { html: next, flattened } = flattenPictureSources(document.getText());
            if (flattened === 0) {
                return null;
            }
            return replaceFullDocument(document, next);
        }
        case 'removeComments': {
            const { html: next, removed } = removeHtmlComments(document.getText());
            if (removed === 0) {
                return null;
            }
            return replaceFullDocument(document, next);
        }
        case 'cleanupLanding': {
            const config = vscode.workspace.getConfiguration('adway');
            const result = cleanupLanding(document.getText(), {
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
                return null;
            }
            return replaceFullDocument(document, result.html);
        }
        case 'base': {
            const html = document.getText();
            const match = html.match(/<base\b[^>]*\/?>/i);
            if (!match || match.index === undefined) {
                return null;
            }
            const edit = new vscode.WorkspaceEdit();
            edit.delete(
                document.uri,
                new vscode.Range(
                    document.positionAt(match.index),
                    document.positionAt(match.index + match[0].length)
                )
            );
            return edit;
        }
        default:
            return null;
    }
}

function createCommandAction(
    title: string,
    diagnostic: vscode.Diagnostic,
    document: vscode.TextDocument,
    fixId: FixId,
    preferred = true
): vscode.CodeAction {
    const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
    action.diagnostics = [diagnostic];
    action.isPreferred = preferred;
    action.command = {
        command: 'adway.applyFix',
        title,
        arguments: [document.uri.toString(), fixId, diagnostic.range.start.line]
    };
    return action;
}

export class AdwayCodeActionProvider implements vscode.CodeActionProvider {
    static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

    provideCodeActions(
        document: vscode.TextDocument,
        _range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];

        for (const diagnostic of context.diagnostics) {
            if (diagnostic.source !== 'Adway Checker') {
                continue;
            }
            const code = String(diagnostic.code || '');

            switch (code) {
                case AdwayDiagnosticCodes.jquery:
                    actions.push(createCommandAction('Adway: Вставить jQuery 3.6.0 в <head>', diagnostic, document, 'jquery'));
                    break;
                case AdwayDiagnosticCodes.lazy:
                    actions.push(createCommandAction('Adway: Вставить lazy loading', diagnostic, document, 'lazy'));
                    break;
                case AdwayDiagnosticCodes.scroll:
                    actions.push(createCommandAction('Adway: Вставить скрипт прокрутки к #oneform', diagnostic, document, 'scroll'));
                    {
                        const span = new vscode.CodeAction(
                            'Adway: Вставить <span id="oneform"></span>',
                            vscode.CodeActionKind.QuickFix
                        );
                        span.diagnostics = [diagnostic];
                        span.command = {
                            command: 'adway.insertOneformSpan',
                            title: 'Вставить span oneform'
                        };
                        actions.push(span);
                    }
                    break;
                case AdwayDiagnosticCodes.validationMissing:
                    actions.push(createCommandAction('Adway: Вставить валидаторы имени/телефона', diagnostic, document, 'validation'));
                    actions.push(createCommandAction('Adway: Вставить все обязательные скрипты', diagnostic, document, 'validationAll', false));
                    break;
                case AdwayDiagnosticCodes.validationOld:
                    actions.push(createCommandAction('Adway: Заменить старый regex имени на Unicode', diagnostic, document, 'validationReplaceName'));
                    actions.push(createCommandAction('Adway: Вставить новый шаблон валидаторов', diagnostic, document, 'validationInsertNew', false));
                    break;
                case AdwayDiagnosticCodes.hidden:
                    actions.push(createCommandAction(
                        'Adway: Починить форму (action/method/hidden/required)',
                        diagnostic,
                        document,
                        'fixForm'
                    ));
                    actions.push(createCommandAction('Adway: Вставить 6 скрытых инпутов в форму', diagnostic, document, 'hidden', false));
                    break;
                case AdwayDiagnosticCodes.forms:
                    actions.push(createCommandAction(
                        'Adway: Починить форму (action/method/hidden/required)',
                        diagnostic,
                        document,
                        'fixForm'
                    ));
                    actions.push(createCommandAction('Adway: Вставить форму заказа', diagnostic, document, 'form', false));
                    break;
                case AdwayDiagnosticCodes.doctype:
                    actions.push(createCommandAction('Adway: Вставить <!DOCTYPE html>', diagnostic, document, 'doctype'));
                    break;
                case AdwayDiagnosticCodes.method:
                    actions.push(createCommandAction(
                        'Adway: Починить форму (action/method/hidden/required)',
                        diagnostic,
                        document,
                        'fixForm'
                    ));
                    actions.push(createCommandAction('Adway: Добавить method="post"', diagnostic, document, 'method', false));
                    break;
                case AdwayDiagnosticCodes.action:
                    actions.push(createCommandAction(
                        'Adway: Починить форму (action/method/hidden/required)',
                        diagnostic,
                        document,
                        'fixForm'
                    ));
                    actions.push(createCommandAction('Adway: Заменить action на "/order.php"', diagnostic, document, 'action', false));
                    break;
                case AdwayDiagnosticCodes.requiredName:
                case AdwayDiagnosticCodes.requiredPhone:
                    actions.push(createCommandAction(
                        'Adway: Починить форму (action/method/hidden/required)',
                        diagnostic,
                        document,
                        'fixForm'
                    ));
                    actions.push(createCommandAction('Adway: Добавить required', diagnostic, document, 'required', false));
                    break;
                case AdwayDiagnosticCodes.oneform:
                    actions.push(createCommandAction(
                        'Adway: Починить форму (action/method/hidden/required)',
                        diagnostic,
                        document,
                        'fixForm'
                    ));
                    actions.push(createCommandAction('Adway: Добавить id="oneform" к форме', diagnostic, document, 'oneform', false));
                    {
                        const span = new vscode.CodeAction(
                            'Adway: Вставить <span id="oneform"></span>',
                            vscode.CodeActionKind.QuickFix
                        );
                        span.diagnostics = [diagnostic];
                        span.command = {
                            command: 'adway.insertOneformSpan',
                            title: 'Вставить span oneform'
                        };
                        actions.push(span);
                    }
                    break;
                case AdwayDiagnosticCodes.base:
                    actions.push(createCommandAction('Adway: Удалить тег <base>', diagnostic, document, 'base'));
                    break;
                case AdwayDiagnosticCodes.href:
                    actions.push(createCommandAction(
                        'Adway: Заменить все href у <a> на "#"',
                        diagnostic,
                        document,
                        'hrefNormalize'
                    ));
                    break;
                case AdwayDiagnosticCodes.target:
                    actions.push(createCommandAction(
                        'Adway: Починить форму (action/method/hidden/required)',
                        diagnostic,
                        document,
                        'fixForm',
                        false
                    ));
                    actions.push(createCommandAction('Adway: Удалить все target', diagnostic, document, 'removeTarget'));
                    break;
                case AdwayDiagnosticCodes.picture:
                    actions.push(createCommandAction('Adway: Убрать <source> из <picture>', diagnostic, document, 'flattenPicture'));
                    break;
                case AdwayDiagnosticCodes.linkOutsideHead: {
                    const move = new vscode.CodeAction(
                        'Adway: Перенести <link> в <head>',
                        vscode.CodeActionKind.QuickFix
                    );
                    move.diagnostics = [diagnostic];
                    move.isPreferred = true;
                    move.command = {
                        command: 'adway.moveLinksToHead',
                        title: 'Перенести link в head'
                    };
                    actions.push(move);
                    break;
                }
                case AdwayDiagnosticCodes.localPath:
                    actions.push(createCommandAction(
                        'Adway: Исправить путь (images/css/js/media)',
                        diagnostic,
                        document,
                        'fixLocalPath'
                    ));
                    break;
                case AdwayDiagnosticCodes.scriptUnconnected: {
                    const connect = new vscode.CodeAction(
                        'Adway: Подключить скрипт в HTML',
                        vscode.CodeActionKind.QuickFix
                    );
                    connect.diagnostics = [diagnostic];
                    connect.isPreferred = true;
                    connect.command = {
                        command: 'adway.connectScriptFile',
                        title: 'Подключить скрипт'
                    };
                    actions.push(connect);
                    const del = new vscode.CodeAction(
                        'Adway: Удалить неподключённый файл',
                        vscode.CodeActionKind.QuickFix
                    );
                    del.diagnostics = [diagnostic];
                    del.command = {
                        command: 'adway.deleteUnconnectedScript',
                        title: 'Удалить скрипт'
                    };
                    actions.push(del);
                    break;
                }
                case AdwayDiagnosticCodes.scriptMissing: {
                    const remove = new vscode.CodeAction(
                        'Adway: Удалить тег <script src>',
                        vscode.CodeActionKind.QuickFix
                    );
                    remove.diagnostics = [diagnostic];
                    remove.isPreferred = true;
                    remove.command = {
                        command: 'adway.removeMissingScriptTag',
                        title: 'Удалить script'
                    };
                    actions.push(remove);
                    actions.push(createCommandAction(
                        'Adway: Исправить путь',
                        diagnostic,
                        document,
                        'fixLocalPath',
                        false
                    ));
                    break;
                }
                case AdwayDiagnosticCodes.videoHermes:
                case AdwayDiagnosticCodes.videoVideojs:
                case AdwayDiagnosticCodes.videoBlob:
                case AdwayDiagnosticCodes.videoCss:
                case AdwayDiagnosticCodes.videoJs:
                case AdwayDiagnosticCodes.videoMediaPath:
                case AdwayDiagnosticCodes.videoFormInside: {
                    const setup = new vscode.CodeAction(
                        'Adway: Установить видео-плеер (бесплатный)',
                        vscode.CodeActionKind.QuickFix
                    );
                    setup.diagnostics = [diagnostic];
                    setup.isPreferred = true;
                    setup.command = {
                        command: 'adway.setupVideoPlayer',
                        title: 'Установить видео-плеер (бесплатный)'
                    };
                    actions.push(setup);
                    break;
                }
                case AdwayDiagnosticCodes.externalImage: {
                    const action = new vscode.CodeAction(
                        'Adway: Скачать это изображение в images/',
                        vscode.CodeActionKind.QuickFix
                    );
                    action.diagnostics = [diagnostic];
                    action.isPreferred = true;
                    action.command = {
                        command: 'adway.downloadExternalImages',
                        title: 'Скачать изображение',
                        arguments: [
                            document.uri.toString(),
                            { line: diagnostic.range.start.line }
                        ]
                    };
                    actions.push(action);
                    break;
                }
            }

            // Fallback: по тексту, если code не распознан
            const msg = diagnostic.message.toLowerCase();
            if (
                !actions.some(a => a.command?.arguments?.[1] === 'fixLocalPath') &&
                (msg.includes('неверный путь') || msg.includes('файл не найден'))
            ) {
                actions.push(createCommandAction(
                    'Adway: Исправить путь на images/css/js',
                    diagnostic,
                    document,
                    'fixLocalPath'
                ));
            }
        }

        return actions;
    }
}
