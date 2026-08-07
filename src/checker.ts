import { JSDOM } from 'jsdom';
import * as path from 'path';
import * as vscode from 'vscode';
import { findMissingLocalPaths } from './filePaths';
import { findExtensionlessAssets } from './extensionlessAssets';
import { countLinksOutsideHead } from './cleanup';
import { checkScriptAssets } from './scriptAssets';
import { detectVideoLandingIssues } from './videoPlayer';
import { readSheetsConfig, validateSidCountry } from './sheets';
import { checkUnusedScripts } from './unusedScripts';

/** true = ok, false = error, 'warning' = warning (как в Chrome) */
export type CheckSuccess = boolean | 'warning';

export interface CheckResult {
    success: CheckSuccess;
    text: string;
    /** 0-based line for Problems / jump */
    line?: number;
    severity?: vscode.DiagnosticSeverity;
}

export interface SidValidationResult {
    ok: boolean;
    error?: string;
    expectedCountry?: string;
}

export interface CheckerOptions {
    whitelist?: string[];
    /** Если не задан — SID/Country через Sheets пропускается (шаг 2) */
    validateSidCountry?: (sid: string, country: string) => Promise<SidValidationResult>;
    /** Если не задан — глубокий разбор содержимого внешних CSS/JS пропускается */
    fetchResource?: (url: string) => Promise<string | null>;
    baseUrl?: string;
    /** Папка HTML-файла для проверки локальных путей */
    htmlDir?: string;
    /** Проверять существование локальных src/href/srcset */
    checkLocalPaths?: boolean;
    /** Варнинг на <picture> с <source> */
    warnPictureSource?: boolean;
    /** Эвристика неиспользуемых/пустых/дублирующихся скриптов */
    checkUnusedScripts?: boolean;
}

const ALLOWED_ACTIONS = ['/order.php', '/fb-order.php', '/submit.php', '/process/order.php'];

const URL_EXCLUDED_PATTERNS = ['{offer}', 'javascript:'];

const DEFAULT_LINK_WHITELIST = [
    'static.joxi.pro',
    'static.cloudflareinsights.com',
    'cloudflareinsights.com',
    'github.com',
    'www.w3.org',
    'converteai.net',
    'vturb.com'
];

const VTURB_ADDITIONAL_WHITELIST = [
    'sentry.io',
    'a.vturb.net',
    'b-cdn.net',
    'clarity.ms',
    'facebook.net',
    'connect.facebook.net',
    'developers.google.com',
    'google.com',
    'aomedia.org',
    'localhost',
    '${e}${this.token}'
];

function escapeHtml(text: string): string {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function stripHtml(text: string): string {
    return text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function removeComments(code: string): string {
    code = code.replace(/\/\*[\s\S]*?\*\//g, '');
    code = code.replace(/\/\/.*$/gm, '');
    return code;
}

function isUrlMalformed(url: string): boolean {
    const malformedPatterns = [
        /^https?:\s+/,
        /^https?:\s*\/[^/]/,
        /^https?:\/\/\s+/,
    ];
    return malformedPatterns.some(pattern => pattern.test(url));
}

function isUrlExcluded(url: string): boolean {
    return URL_EXCLUDED_PATTERNS.some(pattern =>
        url === pattern || url.startsWith(pattern)
    );
}

function findLine(
    html: string,
    search: string,
    fromIndex = 0,
    endIndex?: number
): number | undefined {
    if (!search) {
        return undefined;
    }
    const limit = endIndex ?? html.length;
    const slice = html.slice(0, limit);
    const idx = slice.indexOf(search, fromIndex);
    if (idx === -1) {
        const lower = slice.toLowerCase();
        const idx2 = lower.indexOf(search.toLowerCase(), fromIndex);
        if (idx2 === -1 || idx2 >= limit) {
            return undefined;
        }
        return html.substring(0, idx2).split('\n').length - 1;
    }
    if (idx >= limit) {
        return undefined;
    }
    return html.substring(0, idx).split('\n').length - 1;
}

export type FormRange = { start: number; end: number };

/** Диапазоны <form>…</form> в исходном HTML (по порядку, с учётом вложенности). */
export function findFormRanges(html: string): FormRange[] {
    const ranges: FormRange[] = [];
    const re = /<\/?form\b[^>]*>/gi;
    const stack: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
        const tag = match[0];
        if (/^<form\b/i.test(tag)) {
            stack.push(match.index);
        } else if (stack.length > 0) {
            const start = stack.pop()!;
            ranges.push({ start, end: match.index + tag.length });
        }
    }
    return ranges;
}

function lineAtOffset(html: string, offset: number): number {
    return html.substring(0, Math.max(0, offset)).split('\n').length - 1;
}

function push(
    results: CheckResult[],
    success: CheckSuccess,
    text: string,
    html?: string,
    search?: string,
    fromIndex?: number,
    endIndex?: number
): void {
    const line =
        html && search
            ? findLine(html, search, fromIndex ?? 0, endIndex)
            : undefined;
    let severity: vscode.DiagnosticSeverity | undefined;
    if (success === false) {
        severity = vscode.DiagnosticSeverity.Error;
    } else if (success === 'warning') {
        severity = vscode.DiagnosticSeverity.Warning;
    }
    results.push({ success, text, line, severity });
}

function pushAtLine(
    results: CheckResult[],
    success: CheckSuccess,
    text: string,
    line?: number
): void {
    let severity: vscode.DiagnosticSeverity | undefined;
    if (success === false) {
        severity = vscode.DiagnosticSeverity.Error;
    } else if (success === 'warning') {
        severity = vscode.DiagnosticSeverity.Warning;
    }
    results.push({ success, text, line, severity });
}

function isInComment(html: string, position: number): boolean {
    const contextStart = Math.max(0, position - 200);
    const contextEnd = Math.min(html.length, position + 200);
    const context = html.substring(contextStart, contextEnd);
    const relativePosition = position - contextStart;

    const commentStarts: number[] = [];
    const commentEnds: number[] = [];
    const startPattern = /<!--/gi;
    const endPattern = /-->/gi;
    let match: RegExpExecArray | null;

    while ((match = startPattern.exec(context)) !== null) {
        commentStarts.push(match.index);
    }
    while ((match = endPattern.exec(context)) !== null) {
        commentEnds.push(match.index);
    }

    let lastStart = -1;
    for (const start of commentStarts) {
        if (start < relativePosition && start > lastStart) {
            lastStart = start;
        }
    }

    let hasEndBefore = false;
    for (const end of commentEnds) {
        if (end < relativePosition && end > lastStart) {
            hasEndBefore = true;
            break;
        }
    }

    return lastStart !== -1 && !hasEndBefore;
}

function detectOfferType(document: Document, htmlContent: string) {
    const allLinks = document.querySelectorAll('a[href]');
    let isCCOffer = false;
    let offerLinkFound: string | null = null;
    const wrongOfferLinks: string[] = [];
    const commentedWrongOfferLinks: string[] = [];

    allLinks.forEach(el => {
        const href = el.getAttribute('href') || '';
        if (href === '{offer}') {
            isCCOffer = true;
            offerLinkFound = href;
        }
        if (href.includes('{offer}') && href !== '{offer}') {
            wrongOfferLinks.push(href);
        }
    });

    const hrefPattern = /href\s*=\s*['"]([^'"]+)['"]/gi;
    let match: RegExpExecArray | null;
    while ((match = hrefPattern.exec(htmlContent)) !== null) {
        const href = match[1];
        if (href.includes('{offer}') && href !== '{offer}') {
            if (isInComment(htmlContent, match.index)) {
                commentedWrongOfferLinks.push(href);
            }
        }
    }

    return { isCCOffer, offerLinkFound, wrongOfferLinks, commentedWrongOfferLinks };
}

function checkIfVturbExists(document: Document): boolean {
    const scripts = document.querySelectorAll('script[src]');
    for (const script of Array.from(scripts)) {
        const src = script.getAttribute('src') || '';
        if (src.includes('vturb') || src.includes('converteai')) {
            return true;
        }
    }
    const vturbElements = document.querySelectorAll('[src*="vturb"], [src*="converteai"]');
    return vturbElements.length > 0;
}

function buildWhitelist(document: Document, base: string[]): string[] {
    if (checkIfVturbExists(document)) {
        return base.concat(VTURB_ADDITIONAL_WHITELIST);
    }
    return base;
}

function extractUrlsFromCss(content: string): string[] {
    const urls: string[] = [];
    let match: RegExpExecArray | null;

    const urlPattern = /url\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi;
    while ((match = urlPattern.exec(content)) !== null) {
        const url = match[1];
        if (url.includes('://') && !url.startsWith('data:')) {
            urls.push(url);
        }
    }

    const importPattern = /@import\s+(?:url\s*\(\s*)?['"]?([^'");\s]+)['"]?\s*\)?/gi;
    while ((match = importPattern.exec(content)) !== null) {
        const url = match[1];
        if (url.includes('://') && !url.startsWith('data:')) {
            urls.push(url);
        }
    }

    const directUrlPattern = /(?<!['"`])(https?:[^\s<>"'`)]+)/gi;
    while ((match = directUrlPattern.exec(content)) !== null) {
        const url = match[1];
        if (!url.startsWith('data:') && !urls.includes(url)) {
            urls.push(url);
        }
    }

    return urls;
}

function extractUrlsFromJs(content: string, whitelist: string[]): string[] {
    const urls: string[] = [];
    let match: RegExpExecArray | null;

    const fullUrlPattern = /['"`](https?:\/\/[^'"`\s<>\{\}]+)['"`]/gi;
    while ((match = fullUrlPattern.exec(content)) !== null) {
        const url = match[1];
        if (!isUrlExcluded(url) && !url.includes('${') && !url.startsWith('data:')) {
            urls.push(url);
        }
    }

    const templateLiteralPattern = /`([^`]+)`/g;
    while ((match = templateLiteralPattern.exec(content)) !== null) {
        const templateContent = match[1];
        if (templateContent.includes('http://') || templateContent.includes('https://')) {
            const urlMatch = templateContent.match(/(https?:\/\/[^`]+)/i);
            if (urlMatch) {
                const baseUrl = urlMatch[1];
                if (!baseUrl.startsWith('data:')) {
                    const domainMatch = baseUrl.match(/https?:\/\/([a-zA-Z0-9.-]+)/);
                    const realDomain = domainMatch ? domainMatch[1] : null;
                    const isWhitelisted = realDomain && whitelist.some(d => realDomain.includes(d));
                    if (!isWhitelisted && !urls.includes(baseUrl)) {
                        urls.push(baseUrl);
                    }
                }
            }
        }
    }

    const protocolPattern = /['"`](https?:\/\/)['"`]\s*\+/gi;
    while ((match = protocolPattern.exec(content)) !== null) {
        const remaining = content.substring(match.index + match[0].length);
        const continuationMatch = remaining.match(/^\s*['"`]([^'"`\s]+)['"`]/);
        if (continuationMatch) {
            const url = 'https://' + continuationMatch[1];
            if (!isUrlExcluded(url) && !urls.includes(url)) {
                urls.push(url);
            }
        }
    }

    const baseUrlPattern = /(?:const|let|var)\s+\w*\s*=\s*['"`](https?:\/\/[^'"`\s]+)['"`]/gi;
    while ((match = baseUrlPattern.exec(content)) !== null) {
        const url = match[1];
        if (!isUrlExcluded(url) && !url.startsWith('data:')) {
            urls.push(url);
        }
    }

    const directUrlPattern = /(?<!['"`])(https?:[^\s<>"'`)\]]+)/gi;
    while ((match = directUrlPattern.exec(content)) !== null) {
        const url = match[1];
        if (!isUrlExcluded(url) && !url.startsWith('data:') && !url.includes('${') && !urls.includes(url)) {
            urls.push(url);
        }
    }

    const singleLineCommentPattern = /\/\/\s*(https?:[^\s<>"'`)\]]+)/gi;
    while ((match = singleLineCommentPattern.exec(content)) !== null) {
        const url = match[1];
        if (!isUrlExcluded(url) && !url.startsWith('data:') && !urls.includes(url)) {
            urls.push(url);
        }
    }

    const multiLineCommentPattern = /\/\*[\s\S]*?\*\//gi;
    while ((match = multiLineCommentPattern.exec(content)) !== null) {
        const comment = match[0];
        const urlInCommentPattern = /https?:[^\s<>"'`)\]]+/gi;
        let urlMatch: RegExpExecArray | null;
        while ((urlMatch = urlInCommentPattern.exec(comment)) !== null) {
            const url = urlMatch[0];
            if (!isUrlExcluded(url) && !url.startsWith('data:') && !urls.includes(url)) {
                urls.push(url);
            }
        }
    }

    return urls;
}

function extractUrlsFromHtml(htmlContent: string, whitelist: string[]): string[] {
    const urls: string[] = [];
    let match: RegExpExecArray | null;

    const commentPattern = /<!--([\s\S]*?)-->/gi;
    while ((match = commentPattern.exec(htmlContent)) !== null) {
        const commentContent = match[1];

        const hrefPattern = /href\s*=\s*['"]([^'"]+)['"]/gi;
        let hrefMatch: RegExpExecArray | null;
        while ((hrefMatch = hrefPattern.exec(commentContent)) !== null) {
            const url = hrefMatch[1];
            if (!isUrlExcluded(url) && url.includes('://') && !url.startsWith('data:') && !urls.includes(url)) {
                urls.push(url);
            }
        }

        const srcPattern = /src\s*=\s*['"]([^'"]+)['"]/gi;
        let srcMatch: RegExpExecArray | null;
        while ((srcMatch = srcPattern.exec(commentContent)) !== null) {
            const url = srcMatch[1];
            if (!isUrlExcluded(url) && url.includes('://') && !url.startsWith('data:') && !urls.includes(url)) {
                urls.push(url);
            }
        }

        const directUrlPattern = /(?<!['"])(https?:[^\s<>"')\]]+)/gi;
        let directMatch: RegExpExecArray | null;
        while ((directMatch = directUrlPattern.exec(commentContent)) !== null) {
            const url = directMatch[1];
            if (!isUrlExcluded(url) && !url.startsWith('data:') && !urls.includes(url)) {
                urls.push(url);
            }
        }
    }

    const stylePattern = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    while ((match = stylePattern.exec(htmlContent)) !== null) {
        const cssUrls = extractUrlsFromCss(match[1]);
        cssUrls.forEach(url => {
            if (!isUrlExcluded(url) && !urls.includes(url)) {
                urls.push(url);
            }
        });
    }

    const scriptPattern = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    while ((match = scriptPattern.exec(htmlContent)) !== null) {
        const jsUrls = extractUrlsFromJs(match[1], whitelist);
        jsUrls.forEach(url => {
            if (!isUrlExcluded(url) && !urls.includes(url)) {
                urls.push(url);
            }
        });
    }

    return urls;
}

function resolveUrl(href: string, baseUrl: string): string {
    if (href.startsWith('//')) {
        return 'https:' + href;
    }
    if (href.startsWith('/')) {
        try {
            return new URL(href, baseUrl).href;
        } catch {
            return href;
        }
    }
    if (href.startsWith('./')) {
        return baseUrl.replace(/\/[^/]*$/, '/') + href.substring(2);
    }
    if (!href.includes('://')) {
        return baseUrl.replace(/\/[^/]*$/, '/') + href;
    }
    return href;
}

function checkOffer(document: Document, results: CheckResult[], html: string): void {
    const allForms = Array.from(document.querySelectorAll('form'));
    const formRanges = findFormRanges(html);
    const allHiddenInputs = document.querySelectorAll('input[type="hidden"]');
    const totalHiddenInputs = allHiddenInputs.length;
    let formsWithHiddenInputs = 0;
    let orderFormsFound = 0;
    const requiredHiddenFields = ['fbpx', 'utm_code', 'cid', 'sid', 'hash', 'country'];

    if (allForms.length === 0) {
        push(results, false, '❌ Формы не найдены. Добавьте форму заказа с action="/order.php"', html, '<body');
    } else {
        allForms.forEach((form, index) => {
            const hiddenInputs = form.querySelectorAll('input[type="hidden"]');
            const hasOrderFields = form.querySelector('input[name="name"], input[name="phone"]');
            if (!hasOrderFields && hiddenInputs.length === 0) {
                return;
            }
            orderFormsFound++;
            const range = formRanges[index];
            const from = range?.start ?? 0;
            const to = range?.end ?? html.length;
            // Ошибки «отсутствует поле» → строка </form> (куда вставляют hidden)
            const missingLine = range
                ? lineAtOffset(html, Math.max(range.start, range.end - '</form>'.length))
                : undefined;
            const formOpenLine = range ? lineAtOffset(html, range.start) : undefined;

            if (hiddenInputs.length === 6) {
                formsWithHiddenInputs++;
                push(results, true, `✅ Форма #${index + 1}: 6 скрытых инпутов`);
                requiredHiddenFields.forEach(fieldName => {
                    const input = form.querySelector(`input[type="hidden"][name="${fieldName}"]`) as HTMLInputElement | null;
                    if (input) {
                        if (fieldName === 'sid' || fieldName === 'country') {
                            if (input.value && input.value.trim() !== '') {
                                push(results, true, `✅ Форма #${index + 1}: name="${fieldName}" = <span class="value-highlight">"${escapeHtml(input.value)}"</span>`);
                            } else {
                                push(results, false, `❌ Форма #${index + 1}: name="${fieldName}" пустой`, html, `name="${fieldName}"`, from, to);
                            }
                        } else {
                            const valueDisplay = input.value || '(пусто)';
                            push(results, true, `✅ Форма #${index + 1}: name="${fieldName}" = <span class="value-highlight">"${escapeHtml(valueDisplay)}"</span>`);
                        }
                    } else {
                        pushAtLine(results, false, `❌ Форма #${index + 1}: Отсутствует name="${fieldName}"`, missingLine);
                    }
                });
            } else if (hiddenInputs.length > 0) {
                if (hiddenInputs.length < 6) {
                    pushAtLine(results, false, `❌ Форма #${index + 1}: Только <span class="value-highlight">${hiddenInputs.length}</span> скрытых инпутов (нужно <span class="value-highlight">6</span>)`, formOpenLine);
                } else {
                    pushAtLine(results, false, `❌ Форма #${index + 1}: <span class="value-highlight">${hiddenInputs.length}</span> скрытых инпутов (больше <span class="value-highlight">6</span>)`, formOpenLine);
                }
                requiredHiddenFields.forEach(fieldName => {
                    const input = form.querySelector(`input[type="hidden"][name="${fieldName}"]`) as HTMLInputElement | null;
                    if (!input) {
                        pushAtLine(results, false, `❌ Форма #${index + 1}: Отсутствует name="${fieldName}"`, missingLine);
                    } else if ((fieldName === 'sid' || fieldName === 'country') && (!input.value || input.value.trim() === '')) {
                        push(results, false, `❌ Форма #${index + 1}: name="${fieldName}" пустой`, html, `name="${fieldName}"`, from, to);
                    }
                });
            }
        });

        // Есть <form>, но ни одна не похожа на форму заказа (name/phone или hidden)
        if (orderFormsFound === 0) {
            push(results, false, '❌ Форма заказа не найдена. Нужна форма с name/phone или скрытыми инпутами (fbpx, sid, country…)', html, '<form');
        }
    }

    if (formsWithHiddenInputs > 0) {
        const expectedHidden = formsWithHiddenInputs * 6;
        if (totalHiddenInputs !== expectedHidden) {
            push(results, false, `❌ Всего скрытых инпутов: ${totalHiddenInputs} (ожидалось ${expectedHidden} для ${formsWithHiddenInputs} форм(ы))`);
        } else {
            push(results, true, `✅ Всего скрытых инпутов: ${totalHiddenInputs} (по 6 на форму)`);
        }
    }

    allForms.forEach((form, index) => {
        const action = form.getAttribute('action');
        if (!action) {
            return;
        }
        const hiddenInputs = form.querySelectorAll('input[type="hidden"]');
        const hasName = form.querySelector('input[name="name"]');
        const hasPhone = form.querySelector('input[name="phone"]');
        const hasNamePhone = hasName && hasPhone;
        const isOrderForm = hiddenInputs.length > 0 || hasNamePhone;
        if (!isOrderForm) {
            return;
        }

        const isAllowed = ALLOWED_ACTIONS.includes(action);
        if (!isAllowed) {
            const isMalformed = /^https?:\/[^/]/.test(action);
            const isExternal = action.startsWith('http://') || action.startsWith('https://') || action.startsWith('//') || isMalformed;
            if (isExternal) {
                if (isMalformed) {
                    const fixedAction = action.replace('http:/', 'http://').replace('https:/', 'https://');
                    push(results, false, `❌ Форма #${index + 1}: неверный формат action=<span class="value-highlight">"${escapeHtml(action)}"</span> (один слэш вместо двух). Исправьте на <span class="value-highlight">"${escapeHtml(fixedAction)}"</span> или замените на <span class="value-highlight">"/order.php"</span>`, html, `action="${action}"`);
                } else {
                    push(results, false, `❌ Форма #${index + 1}: внешний action=<span class="value-highlight">"${escapeHtml(action)}"</span>`, html, `action="${action}"`);
                }
            } else {
                push(results, false, `❌ Форма #${index + 1}: неверный action=<span class="value-highlight">"${escapeHtml(action)}"</span>`, html, `action="${action}"`);
            }
        } else {
            push(results, true, `✅ Форма #${index + 1}: action=<span class="value-highlight">"${escapeHtml(action)}"</span>`);
        }
    });

    allForms.forEach((form, index) => {
        const action = form.getAttribute('action');
        const hiddenInputs = form.querySelectorAll('input[type="hidden"]');
        const hasName = form.querySelector('input[name="name"]');
        const hasPhone = form.querySelector('input[name="phone"]');
        const hasNamePhone = hasName && hasPhone;
        const isOrderForm = hiddenInputs.length > 0 || hasNamePhone;
        if (isOrderForm) {
            return;
        }

        const inputs = form.querySelectorAll('input:not([type="hidden"])');
        const buttons = form.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type])');
        const inputsWithoutDisabled: string[] = [];
        const buttonsWithoutDisabled: string[] = [];

        inputs.forEach((input) => {
            if (!input.hasAttribute('disabled')) {
                const el = input as HTMLInputElement;
                inputsWithoutDisabled.push(`${el.tagName}${el.name ? ` name="${el.name}"` : ''}${el.type ? ` type="${el.type}"` : ''}`);
            }
        });
        buttons.forEach((button) => {
            if (!button.hasAttribute('disabled')) {
                const el = button as HTMLButtonElement;
                buttonsWithoutDisabled.push(`${el.tagName}${el.type ? ` type="${el.type}"` : ''}`);
            }
        });

        if (inputsWithoutDisabled.length > 0 || buttonsWithoutDisabled.length > 0) {
            let message = `Форма #${index + 1}`;
            if (action) {
                message += ` с action="${escapeHtml(action)}"`;
            }
            message += ` не имеет disabled элементов. `;
            if (inputsWithoutDisabled.length > 0) {
                message += `На инпуты (${inputsWithoutDisabled.join(', ')}) добавьте disabled. `;
            }
            if (buttonsWithoutDisabled.length > 0) {
                message += `На кнопки (${buttonsWithoutDisabled.join(', ')}) добавьте disabled.`;
            }
            push(results, false, `❌ ${message.trim()}`, html, '<form');
        }
    });

    allForms.forEach((form, index) => {
        const method = form.getAttribute('method');
        const hiddenInputs = form.querySelectorAll('input[type="hidden"]');
        if (hiddenInputs.length === 0) {
            return;
        }
        if (method && method.toLowerCase() === 'post') {
            push(results, true, `✅ Форма #${index + 1}: method=<span class="value-highlight">"post"</span>`);
        } else if (method) {
            push(results, false, `❌ Форма #${index + 1}: method=<span class="value-highlight">"${escapeHtml(method)}"</span> (ожидалось post)`, html, `method="${method}"`);
        } else {
            push(results, false, `❌ Форма #${index + 1}: method отсутствует`, html, '<form');
        }
    });

    allForms.forEach((form, index) => {
        const hiddenInputs = form.querySelectorAll('input[type="hidden"]');
        const hasOrderFields = form.querySelector('input[name="name"], input[name="phone"]');
        if (hiddenInputs.length === 0 && !hasOrderFields) {
            return;
        }
        const nameInput = form.querySelector('input[name="name"]');
        const phoneInput = form.querySelector('input[name="phone"]');

        if (!nameInput) {
            push(results, false, `❌ Форма #${index + 1}: инпут name="name" не найден`, html, '<form');
        } else {
            push(results, true, `✅ Форма #${index + 1}: инпут name="name" найден`);
            if (nameInput.hasAttribute('required')) {
                push(results, true, `✅ Форма #${index + 1}: у name="name" есть атрибут <span class="value-highlight">"required"</span>`);
            } else {
                push(results, false, `❌ Форма #${index + 1}: у name="name" нет атрибута <span class="value-highlight">"required"</span>`, html, 'name="name"');
            }
        }

        if (!phoneInput) {
            push(results, false, `❌ Форма #${index + 1}: инпут name="phone" не найден`, html, '<form');
        } else {
            push(results, true, `✅ Форма #${index + 1}: инпут name="phone" найден`);
            if (phoneInput.hasAttribute('required')) {
                push(results, true, `✅ Форма #${index + 1}: у name="phone" есть атрибут <span class="value-highlight">"required"</span>`);
            } else {
                push(results, false, `❌ Форма #${index + 1}: у name="phone" нет атрибута <span class="value-highlight">"required"</span>`, html, 'name="phone"');
            }
        }

        const selectElements = form.querySelectorAll('select');
        if (selectElements.length > 0) {
            push(results, false, `❌ Форма #${index + 1}: обнаружено <span class="value-highlight">${selectElements.length}</span> <select> элементов. Удалите все <select> из формы заказа`, html, '<select');
        }
    });

    const allLinksForCheck = document.querySelectorAll('a[href]');
    let hasOfferLink = false;
    const wrongOfferLinks: string[] = [];
    allLinksForCheck.forEach(el => {
        const href = el.getAttribute('href') || '';
        if (href === '{offer}') {
            hasOfferLink = true;
        }
        if (href.includes('{offer}') && href !== '{offer}') {
            wrongOfferLinks.push(href);
        }
    });

    if (hasOfferLink) {
        push(results, false, '❌ Найдена ссылка href=<span class="value-highlight">"{offer}"</span> (это CC оффер, а не обычный). Для обычного оффера используйте форму с action=<span class="value-highlight">"/order.php"</span>', html, 'href="{offer}"');
    }
    wrongOfferLinks.forEach(href => {
        push(results, false, `❌ Неправильная ссылка с {offer}: href=<span class="value-highlight">"${escapeHtml(href)}"</span> — должно быть строго href=<span class="value-highlight">"{offer}"</span> для CC оффера или форма для обычного оффера`, html, href);
    });

    const orderForms: { index: number; sid: string; country: string }[] = [];
    allForms.forEach((form, index) => {
        const hiddenInputs = form.querySelectorAll('input[type="hidden"]');
        const hasName = form.querySelector('input[name="name"]');
        const hasPhone = form.querySelector('input[name="phone"]');
        const hasNamePhone = hasName && hasPhone;
        const isOrderForm = hiddenInputs.length > 0 || hasNamePhone;
        if (!isOrderForm) {
            return;
        }
        const sidInput = form.querySelector('input[type="hidden"][name="sid"]') as HTMLInputElement | null;
        const countryInput = form.querySelector('input[type="hidden"][name="country"]') as HTMLInputElement | null;
        if (sidInput && countryInput && sidInput.value.trim() && countryInput.value.trim()) {
            orderForms.push({
                index: index + 1,
                sid: sidInput.value.trim(),
                country: countryInput.value.trim()
            });
        }
    });

    if (orderForms.length > 1) {
        const firstSid = orderForms[0].sid;
        if (orderForms.some(f => f.sid !== firstSid)) {
            const sidList = orderForms.map(f => `Форма #${f.index}: ${f.sid}`).join(', ');
            push(results, false, `❌ Разные SID на формах заказа. Найдено форм: ${orderForms.length}. SID должен быть одинаковый! Сейчас: ${sidList}`);
        }
        const firstCountry = orderForms[0].country;
        if (orderForms.some(f => f.country !== firstCountry)) {
            const countryList = orderForms.map(f => `Форма #${f.index}: ${f.country}`).join(', ');
            push(results, false, `❌ Разные Country на формах заказа. Найдено форм: ${orderForms.length}. Country должен быть одинаковый! Сейчас: ${countryList}`);
        }
    }
}

function checkCCOffer(
    document: Document,
    results: CheckResult[],
    offerInfo: ReturnType<typeof detectOfferType>,
    html: string
): void {
    if (!offerInfo.offerLinkFound) {
        push(results, false, '❌ Ссылка {offer} не найдена. Для CC оффера должна быть ссылка строго href=<span class="value-highlight">"{offer}"</span> (без доменов и путей)');
    } else {
        push(results, true, '✅ Ссылка href=<span class="value-highlight">"{offer}"</span> найдена');
    }

    offerInfo.wrongOfferLinks.forEach(href => {
        push(results, false, `❌ Неправильная ссылка: href=<span class="value-highlight">"${escapeHtml(href)}"</span> — должно быть строго href=<span class="value-highlight">"{offer}"</span>`, html, href);
    });

    offerInfo.commentedWrongOfferLinks.forEach(href => {
        push(results, false, `❌ Закомментированная ссылка с {offer}: href=<span class="value-highlight">"${escapeHtml(href)}"</span> — должно быть строго href=<span class="value-highlight">"{offer}"</span>. Удалите закомментированный код`, html, href);
    });

    const hiddenInputs = document.querySelectorAll('input[type="hidden"]');
    if (hiddenInputs.length === 0) {
        push(results, true, '✅ Скрытые инпуты отсутствуют (CC оффер)');
    } else {
        push(results, false, `❌ Найдено <span class="value-highlight">${hiddenInputs.length}</span> скрытых инпутов (для CC оффера не должно быть). Удалите все input type="hidden"`, html, 'type="hidden"');
    }

    const nameInput = document.querySelector('input[name="name"]');
    const phoneInput = document.querySelector('input[name="phone"]');
    if (!nameInput) {
        push(results, true, '✅ Инпут name="name" отсутствует (CC оффер)');
    } else {
        push(results, false, '❌ Найден name="name" (для CC оффера не должно быть). Удалите input[name="name"]', html, 'name="name"');
    }
    if (!phoneInput) {
        push(results, true, '✅ Инпут name="phone" отсутствует (CC оффер)');
    } else {
        push(results, false, '❌ Найден name="phone" (для CC оффера не должно быть). Удалите input[name="phone"]', html, 'name="phone"');
    }

    const forms = document.querySelectorAll('form[action]');
    if (forms.length === 0) {
        push(results, true, '✅ Формы с action отсутствуют (CC оффер)');
    } else {
        push(results, false, `❌ Найдено ${forms.length} форм(ы) с action (для CC оффера не должно быть). Удалите action у форм`, html, 'action=');
    }
}

function checkHrefAttributes(document: Document, results: CheckResult[], whitelist: string[], html: string): void {
    const links = document.querySelectorAll('a[href]');
    const excludedPatterns = ['tel:', 'mailto:'];
    const targetGroups: Record<string, string[]> = {};

    document.querySelectorAll('[target]').forEach(element => {
        const tagName = element.tagName.toLowerCase();
        const target = element.getAttribute('target');
        let identifier = tagName;
        if (element.hasAttribute('href')) {
            identifier = `href="${element.getAttribute('href')}"`;
        } else if (element.hasAttribute('src')) {
            identifier = `src="${element.getAttribute('src')}"`;
        }
        if (target !== null) {
            const targetValue = target || '(пустое значение)';
            if (!targetGroups[targetValue]) {
                targetGroups[targetValue] = [];
            }
            targetGroups[targetValue].push(identifier);
        }
    });

    links.forEach(link => {
        const href = link.getAttribute('href') || '';
        if (href === '{offer}') {
            return;
        }
        if (excludedPatterns.some(pattern => href === pattern || href.startsWith(pattern))) {
            return;
        }
        if (isUrlMalformed(href)) {
            push(results, false, `❌ Некорректная ссылка: href=<span class="value-highlight">"${escapeHtml(href)}"</span> — URL содержит пробелы после протокола или неправильный формат`, html, href);
            return;
        }
        if (href !== '#') {
            push(results, 'warning', `⚠️ Недопустимая ссылка: href=<span class="value-highlight">"${escapeHtml(href)}"</span> — должна быть строго href=<span class="value-highlight">"#"</span>`, html, `href="${href}"`);
        }
    });

    Object.entries(targetGroups).forEach(([targetValue, identifiers]) => {
        const count = identifiers.length;
        const uniqueIdentifiers = [...new Set(identifiers)];
        const identifiersList = uniqueIdentifiers.slice(0, 3).join(', ');
        const moreText = uniqueIdentifiers.length > 3 ? ` (и ещё ${uniqueIdentifiers.length - 3})` : '';
        push(results, false, `❌ Найдено элементов с target=<span class="value-highlight">"${targetValue}"</span>: <span class="value-highlight">${count}</span>. У элементов не должно быть атрибута target${moreText}: <span class="value-highlight">${identifiersList}</span>`, html, 'target=');
    });

    document.querySelectorAll('img[src]').forEach(img => {
        const src = img.getAttribute('src') || '';
        if (src.startsWith('data:') || src.startsWith('{') || src.includes('{')) {
            return;
        }
        const isExternal = /^https?:\/\//i.test(src) || src.startsWith('//');
        if (!isExternal) {
            return;
        }
        const isWhitelisted = whitelist.some(domain => src.includes(domain));
        if (!isWhitelisted && !src.includes('cdnjs.cloudflare.com')) {
            push(results, false, `❌ Внешнее изображение: img src=<span class="value-highlight">"${escapeHtml(src)}"</span> — скачайте в images/ (Adway: Скачать внешние изображения)`, html, src);
        }
    });
}

async function checkExternalResources(
    document: Document,
    results: CheckResult[],
    whitelist: string[],
    html: string,
    baseUrl: string,
    fetchResource?: (url: string) => Promise<string | null>
): Promise<void> {
    const checkedUrls = new Set<string>();

    for (const link of Array.from(document.querySelectorAll('link[rel="stylesheet"][href]'))) {
        const href = link.getAttribute('href') || '';
        if (href.startsWith('data:') || href.startsWith('{')) {
            continue;
        }
        const fullUrl = resolveUrl(href, baseUrl);
        const isExternal = /^https?:\/\//i.test(href) || href.startsWith('//');
        if (isExternal) {
            const isWhitelisted = whitelist.some(domain => href.includes(domain));
            if (!isWhitelisted && !href.includes('cdnjs.cloudflare.com')) {
                push(
                    results,
                    false,
                    `❌ Внешний CSS: <span class="value-highlight">"${escapeHtml(href)}"</span> — положите файл в css/ и замените путь`,
                    html,
                    href
                );
            }
        }
        if (fetchResource) {
            const content = await fetchResource(fullUrl);
            if (content) {
                for (const url of extractUrlsFromCss(content)) {
                    if (checkedUrls.has(url)) {
                        continue;
                    }
                    checkedUrls.add(url);
                    if (!whitelist.some(domain => url.includes(domain)) && !url.includes('cdnjs.cloudflare.com')) {
                        push(results, 'warning', `⚠️ Ссылка в CSS (${escapeHtml(fullUrl)}): <span class="value-highlight">"${escapeHtml(url)}"</span>`);
                    }
                }
            }
        }
    }

    for (const script of Array.from(document.querySelectorAll('script[src]'))) {
        const src = script.getAttribute('src') || '';
        if (!src || src.startsWith('data:') || src.startsWith('{')) {
            continue;
        }
        // jQuery с CDN — ок
        if (src.includes('jquery') && src.includes('cdnjs.cloudflare.com')) {
            continue;
        }
        const fullUrl = resolveUrl(src, baseUrl);
        const isExternal = /^https?:\/\//i.test(src) || src.startsWith('//');
        if (isExternal) {
            const isWhitelisted = whitelist.some(domain => src.includes(domain));
            if (!isWhitelisted && !src.includes('cdnjs.cloudflare.com')) {
                push(
                    results,
                    false,
                    `❌ Внешний JS: <span class="value-highlight">"${escapeHtml(src)}"</span> — положите файл в js/ и замените путь (jQuery CDN допустим)`,
                    html,
                    src
                );
            }
        }
        if (fetchResource) {
            const content = await fetchResource(fullUrl);
            if (content) {
                for (const url of extractUrlsFromJs(content, whitelist)) {
                    if (checkedUrls.has(url)) {
                        continue;
                    }
                    checkedUrls.add(url);
                    if (!whitelist.some(domain => url.includes(domain)) && !url.includes('cdnjs.cloudflare.com')) {
                        push(results, 'warning', `⚠️ Ссылка в JS (${escapeHtml(fullUrl)}): <span class="value-highlight">"${escapeHtml(url)}"</span>`);
                    }
                }
            }
        }
    }

    const foundUrls = extractUrlsFromHtml(html, whitelist);
    for (const url of foundUrls) {
        if (checkedUrls.has(url)) {
            continue;
        }
        const isWhitelisted = whitelist.some(domain => url.includes(domain));
        if (!isWhitelisted && !url.includes('cdnjs.cloudflare.com') && !url.includes('localhost')) {
            push(results, 'warning', `⚠️ Ссылка в HTML: <span class="value-highlight">"${escapeHtml(url)}"</span>`, html, url);
        }
    }
}

/**
 * Полная проверка лендинга (паритет с Chrome checker.js) через jsdom.
 */
export async function runLandingCheck(html: string, options: CheckerOptions = {}): Promise<CheckResult[]> {
    const baseUrl = options.baseUrl || 'http://localhost/';
    const dom = new JSDOM(html, { url: baseUrl, contentType: 'text/html' });
    const { document, window } = dom.window;

    const baseWhitelist = options.whitelist?.length ? options.whitelist : DEFAULT_LINK_WHITELIST;
    const whitelist = buildWhitelist(document, baseWhitelist);

    let results: CheckResult[] = [];

    try {
        // В IDE файл всегда локальный — проверяем <base> как на localhost
        if (document.doctype && document.doctype.name === 'html') {
            push(results, true, '✅ DOCTYPE html присутствует');
        } else if (/<!doctype\s+html>/i.test(html)) {
            // jsdom иногда не выставляет doctype при фрагментах — fallback по тексту
            push(results, true, '✅ DOCTYPE html присутствует');
        } else {
            push(results, false, '❌ Отсутствует DOCTYPE html', html, '<!DOCTYPE');
        }

        const baseTag = document.querySelector('base');
        if (baseTag) {
            const baseHref = baseTag.getAttribute('href') || '';
            push(results, false, `❌ Обнаружен тег (base) с href=<span class="value-highlight">"${escapeHtml(baseHref)}"</span>. Удалите (base) с лендинга`, html, '<base');
        } else {
            push(results, true, '✅ Тег (base) отсутствует');
        }

        const jqueryScript = document.querySelector('head script[src*="jquery"][src*="3.6.0"]');
        if (jqueryScript) {
            push(results, true, '✅ jQuery 3.6.0 подключён в <head>');
        } else {
            push(results, false, '❌ jQuery 3.6.0 не найден в <head>. Добавьте: <span class="value-highlight">&lt;script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js" referrerpolicy="no-referrer"&gt;&lt;/script&gt;</span>', html, '<head');
        }

        const allScripts = Array.from(document.querySelectorAll('script'));
        const bodyScripts = allScripts.filter(script => document.body.contains(script));

        let foundLazy = false;
        let foundScroll = false;
        let foundValidation = false;

        bodyScripts.forEach(script => {
            let code = script.textContent || '';
            code = removeComments(code);
            if (code.includes('LAZY') && code.includes('querySelectorAll') &&
                code.includes('img') && code.includes('loading') && code.includes('lazy')) {
                foundLazy = true;
            }
            if ((code.includes('scrollTop') && code.includes('oneform')) ||
                (code.includes('animate') && code.includes('oneform'))) {
                foundScroll = true;
            }
            if ((code.includes('[name="name"]') && code.includes('.on(')) ||
                (code.includes("[name='name']") && code.includes('.on(')) ||
                (code.includes('[name="phone"]') && code.includes('.on('))) {
                foundValidation = true;
            }
        });

        if (foundLazy) {
            push(results, true, '✅ Скрипт lazy loading для изображений найден');
        } else {
            push(results, false, '❌ Не найден скрипт lazy loading для изображений');
        }

        const offerInfo = detectOfferType(document, html);
        const isCCOffer = offerInfo.isCCOffer;

        if (foundScroll) {
            push(results, true, '✅ Скрипт прокрутки к форме (#oneform) найден');
            const oneformElement = document.getElementById('oneform');
            if (!oneformElement) {
                push(results, false, '❌ Элемент с id="oneform" не найден. Скрипт прокрутки не будет работать', html, 'oneform');
            } else {
                push(results, true, '✅ Элемент с id="oneform" найден');
            }

            if (isCCOffer) {
                const offerLink = document.querySelector('a[href="{offer}"]');
                if (offerLink) {
                    const offerButtonId = offerLink.getAttribute('id');
                    let scrollScriptFound = false;
                    let scriptNotId: string | null = null;

                    bodyScripts.forEach(script => {
                        let code = script.textContent || '';
                        code = removeComments(code);
                        const hasAllLinksScroll = /\$\(['"]a['"]\).*?\.on\s*\(\s*['"]touchend,\s*click['"]/.test(code) ||
                            /\$("a").*?\.on\s*\(\s*['"]touchend,\s*click['"]/.test(code);
                        if (hasAllLinksScroll) {
                            scrollScriptFound = true;
                            const notMatch = code.match(/\.not\s*\(\s*['"]#([a-zA-Z0-9_-]+)['"]\s*\)/);
                            if (notMatch) {
                                scriptNotId = notMatch[1];
                            }
                        }
                    });

                    if (scrollScriptFound) {
                        if (!offerButtonId) {
                            push(results, false, '❌ CC оффер: нет id у кнопки {offer}. Скрипт скролла на все $("a") найден. У кнопки {offer} должен быть id и он должен быть в .not("#id") в скрипте скролла. Пример: <a href="{offer}" id="getOrder"> и $("a").not("#getOrder").on(...)', html, 'href="{offer}"');
                        } else if (!scriptNotId) {
                            push(results, false, `❌ CC оффер: кнопка {offer} не в исключении скролла. Скрипт скролла на все $("a") найден, но в нём нет .not("#id"). Добавьте .not("#${offerButtonId}") в скрипт скролла: $("a").not("#${offerButtonId}").on(...)`, html, 'oneform');
                        } else if (scriptNotId !== offerButtonId) {
                            push(results, false, `❌ CC оффер: кнопка {offer} не в исключении скролла. Скрипт скролла имеет .not(<span class="value-highlight">"#${scriptNotId}"</span>), но у кнопки {offer} id=<span class="value-highlight">"${offerButtonId}"</span>. Измените id кнопки на <span class="value-highlight">"${scriptNotId}"</span> или исправьте скрипт: <span class="value-highlight">$("a").not("#${offerButtonId}").on(...)</span>`, html, `id="${offerButtonId}"`);
                        } else {
                            push(results, true, `✅ CC оффер: кнопка {offer} с id=<span class="value-highlight">"${offerButtonId}"</span> в исключении скролла`);
                        }
                    }
                }
            }
        } else {
            push(results, false, '❌ Не найден скрипт прокрутки к форме (#oneform)');
        }

        if (foundValidation) {
            push(results, true, '✅ Скрипты валидации имени и телефона найдены');

            let nameValidatorCount = 0;
            let phoneValidatorCount = 0;
            let nameValidatorOldCount = 0;
            let phoneValidatorOldCount = 0;

            bodyScripts.forEach(script => {
                let code = script.textContent || '';
                code = removeComments(code);

                const hasNameSelector = code.includes('[name="name"]') || code.includes("[name='name']");
                if (hasNameSelector) {
                    const hasNameEvent = /\.\s*on\s*\(\s*["'](input|change|blur)/.test(code);
                    if (hasNameEvent) {
                        const isNewName = /\/\[\^\\p\{L\}\\s\]\/gu/.test(code) || code.includes('\\p{L}');
                        const isOldName = /\/\[\^a-zA-Zа-яА-ЯёЁіїіЇ\s\]\/g/.test(code);
                        if (isNewName) {
                            nameValidatorCount++;
                        } else if (isOldName) {
                            nameValidatorOldCount++;
                        }
                    }
                }

                const hasPhoneSelector = code.includes('[name="phone"]') || code.includes("[name='phone']");
                if (hasPhoneSelector) {
                    const hasPhoneEvent = /\.\s*on\s*\(\s*["'](input|change|input change|change input)/.test(code);
                    if (hasPhoneEvent) {
                        const hasDReplace = /\.\s*replace\s*\(\s*\/\\D\/g\s*,\s*["']{2}\s*\)/.test(code);
                        const hasPatternAttr = /\.\s*attr\s*\(\s*["']pattern["']\s*,\s*["']\[0-9\]\{6,\}["']\s*\)/.test(code);
                        if (hasDReplace && hasPatternAttr) {
                            phoneValidatorCount++;
                        } else {
                            phoneValidatorOldCount++;
                        }
                    }
                }
            });

            if (nameValidatorCount === 0 && nameValidatorOldCount === 0) {
                push(results, false, '❌ Валидатор имени не найден');
            } else if (nameValidatorCount === 0 && nameValidatorOldCount > 0) {
                push(results, false, '❌ Старый валидатор имени. Обновите валидатор имени');
            }

            if (phoneValidatorCount === 0 && phoneValidatorOldCount === 0) {
                push(results, false, '❌ Валидатор телефона не найден');
            } else if (phoneValidatorCount === 0 && phoneValidatorOldCount > 0) {
                push(results, false, '❌ Старый валидатор телефона. Обновите валидатор телефона');
            }

            if (nameValidatorCount === 0 && nameValidatorOldCount > 0 &&
                phoneValidatorCount === 0 && phoneValidatorOldCount > 0) {
                results = results.filter(r =>
                    !r.text.includes('Старый валидатор имени') &&
                    !r.text.includes('Старый валидатор телефона')
                );
                push(results, false, '❌ Старые валидаторы имени и телефона. Обновите валидаторы имени и телефона');
            }

            if ((nameValidatorCount > 0 && nameValidatorOldCount > 0) ||
                (phoneValidatorCount > 0 && phoneValidatorOldCount > 0)) {
                const mixed: string[] = [];
                if (nameValidatorCount > 0 && nameValidatorOldCount > 0) {
                    mixed.push('имени');
                }
                if (phoneValidatorCount > 0 && phoneValidatorOldCount > 0) {
                    mixed.push('телефона');
                }
                push(results, false, `❌ Смешанные валидаторы (${mixed.join(' и ')}). Найдены и новые и старые валидаторы. Удалите старые, оставьте только новые`);
            }

            if (nameValidatorCount > 1 || phoneValidatorCount > 1) {
                const duplicates: string[] = [];
                if (nameValidatorCount > 1) {
                    duplicates.push(`имени: ${nameValidatorCount}`);
                }
                if (phoneValidatorCount > 1) {
                    duplicates.push(`телефона: ${phoneValidatorCount}`);
                }
                push(results, false, `❌ Дублирование валидаторов (${duplicates.join(', ')}). Должен быть только один валидатор для каждого поля!`);
            } else {
                if (nameValidatorCount === 1) {
                    push(results, true, '✅ Валидатор имени соответствует новому шаблону');
                }
                if (phoneValidatorCount === 1) {
                    push(results, true, '✅ Валидатор телефона соответствует новому шаблону');
                }
            }
        } else {
            push(results, false, '❌ Не найдены скрипты валидации имени и телефона');
        }

        if (isCCOffer) {
            checkCCOffer(document, results, offerInfo, html);
        } else {
            checkOffer(document, results, html);
        }

        checkHrefAttributes(document, results, whitelist, html);
        await checkExternalResources(document, results, whitelist, html, baseUrl, options.fetchResource);

        if (options.checkUnusedScripts !== false) {
            checkUnusedScripts(document, results, html, push);
        }

        if (options.warnPictureSource !== false) {
            const pictures = Array.from(document.querySelectorAll('picture'));
            let withSource = 0;
            for (const pic of pictures) {
                if (pic.querySelector('source')) {
                    withSource += 1;
                }
            }
            if (withSource > 0) {
                push(
                    results,
                    'warning',
                    `⚠️ Найдено <span class="value-highlight">${withSource}</span> <picture> с <source>. Оставьте только <img src="…"> (Adway: Почистить лендинг)`,
                    html,
                    '<picture'
                );
            }
        }

        {
            const outside = countLinksOutsideHead(html);
            if (outside > 0) {
                push(
                    results,
                    'warning',
                    `⚠️ Найдено <span class="value-highlight">${outside}</span> тег(ов) &lt;link&gt; вне &lt;head&gt; — перенесите в head`,
                    html,
                    '<link'
                );
            }
        }

        if (options.checkLocalPaths !== false && options.htmlDir) {
            const scriptIssues = checkScriptAssets(html, options.htmlDir);
            const missingScriptKeys = new Set(
                scriptIssues
                    .filter(i => i.kind === 'missing')
                    .map(i => i.path.replace(/^\.\//, '').toLowerCase())
            );

            for (const issue of findMissingLocalPaths(html, options.htmlDir)) {
                if (missingScriptKeys.has(issue.url.replace(/^\.\//, '').toLowerCase())) {
                    continue;
                }
                const inCss = issue.cssFile
                    ? ` в <span class="value-highlight">${escapeHtml(issue.cssFile)}</span>`
                    : '';
                if (issue.suggestedUrl) {
                    push(
                        results,
                        false,
                        `❌ Неверный путь${inCss}: <span class="value-highlight">"${escapeHtml(issue.url)}"</span> — файл найден как <span class="value-highlight">"${escapeHtml(issue.suggestedUrl)}"</span>`,
                        html,
                        issue.cssFile ? issue.cssFile : issue.search
                    );
                } else {
                    push(
                        results,
                        false,
                        `❌ Файл не найден${inCss}: <span class="value-highlight">"${escapeHtml(issue.url)}"</span> (искали в корне, images/, css/, js/, media/ и вложенных)`,
                        html,
                        issue.cssFile ? issue.cssFile : issue.search
                    );
                }
            }

            const extless = findExtensionlessAssets(options.htmlDir);
            if (extless.length > 0) {
                const byKind = new Map<string, number>();
                for (const i of extless) {
                    byKind.set(i.kind, (byKind.get(i.kind) || 0) + 1);
                }
                const kindSummary = [...byKind.entries()]
                    .map(([k, n]) => `${k.toUpperCase()}×${n}`)
                    .join(', ');
                const samples = extless
                    .slice(0, 5)
                    .map(i => `${i.relPath}→${i.suggestedRel}`)
                    .join('; ');
                push(
                    results,
                    false,
                    `❌ Файлы без расширения: <span class="value-highlight">${extless.length}</span> (${escapeHtml(kindSummary)}) — пример: <span class="value-highlight">${escapeHtml(samples)}</span>. Adway: Восстановить расширения ассетов`,
                    html,
                    extless[0].relPath
                );
            }

            for (const issue of scriptIssues) {
                if (issue.kind === 'unconnected') {
                    push(
                        results,
                        'warning',
                        `⚠️ Скрипт не подключён в HTML: <span class="value-highlight">"${escapeHtml(issue.path)}"</span> — добавьте &lt;script src&gt; или удалите файл`,
                        html,
                        'script'
                    );
                } else {
                    push(
                        results,
                        false,
                        `❌ Скрипт не найден: <span class="value-highlight">"${escapeHtml(issue.path)}"</span> — удалите тег или положите файл`,
                        html,
                        issue.search || issue.path
                    );
                }
            }
        }

        if (options.htmlDir) {
            for (const issue of detectVideoLandingIssues(html, options.htmlDir)) {
                push(
                    results,
                    issue.severity === 'warning' ? 'warning' : false,
                    issue.message,
                    html,
                    issue.code.includes('hermes')
                        ? 'embedpvideo'
                        : issue.code.includes('videojs')
                          ? 'video-js'
                          : issue.code.includes('media')
                            ? '.mp4'
                            : 'video'
                );
            }
        }

        if (!isCCOffer && options.validateSidCountry) {
            const allFormsForSid = Array.from(document.querySelectorAll('form'));
            for (const [index, form] of allFormsForSid.entries()) {
                const hiddenInputs = form.querySelectorAll('input[type="hidden"]');
                const hasNamePhone = form.querySelector('input[name="name"], input[name="phone"]');
                if (hiddenInputs.length === 0 && !hasNamePhone) {
                    continue;
                }
                if (hiddenInputs.length === 0) {
                    continue;
                }
                const sidInput = form.querySelector('input[type="hidden"][name="sid"]') as HTMLInputElement | null;
                const countryInput = form.querySelector('input[type="hidden"][name="country"]') as HTMLInputElement | null;
                if (sidInput && countryInput && sidInput.value.trim() && countryInput.value.trim()) {
                    try {
                        const validation = await options.validateSidCountry(
                            sidInput.value.trim(),
                            countryInput.value.trim()
                        );
                        if (validation.ok) {
                            push(results, true, `✅ Форма #${index + 1}: SID/Country соответствуют таблице`);
                        } else {
                            const expected = validation.expectedCountry ? ` (ожидалось: ${validation.expectedCountry})` : '';
                            push(results, false, `❌ Форма #${index + 1}: ${validation.error || 'Ошибка валидации'}${expected}`, html, 'name="sid"');
                        }
                    } catch (e: unknown) {
                        const msg = e instanceof Error ? e.message : String(e);
                        push(results, false, `❌ Форма #${index + 1}: Ошибка проверки SID/Country - ${msg}`);
                    }
                }
            }
        }
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        push(results, false, `❌ Ошибка при проверке: ${msg}`);
    } finally {
        window.close();
    }

    return results;
}

/** Обёртка для VS Code TextDocument — читает буфер как есть, без save(). */
export class LandingChecker {
    private htmlContent: string;
    private options: CheckerOptions;

    constructor(document: vscode.TextDocument, options?: CheckerOptions) {
        this.htmlContent = document.getText();
        const config = vscode.workspace.getConfiguration('adway');
        const whitelist = config.get<string[]>('linkWhitelist', DEFAULT_LINK_WHITELIST);
        const sheets = readSheetsConfig();
        const htmlDir =
            document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : undefined;
        this.options = {
            whitelist,
            baseUrl: document.uri.scheme === 'file' ? document.uri.toString() : 'http://localhost/',
            validateSidCountry: sheets.enabled ? validateSidCountry : undefined,
            htmlDir,
            checkLocalPaths: config.get<boolean>('checkLocalPaths', true),
            warnPictureSource: config.get<boolean>('cleanup.removePictureSource', true),
            checkUnusedScripts: config.get<boolean>('checkUnusedScripts', true),
            ...options
        };
    }

    async check(): Promise<CheckResult[]> {
        return runLandingCheck(this.htmlContent, this.options);
    }
}
