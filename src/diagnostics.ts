import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LandingChecker, stripHtml } from './checker';

export const AdwayDiagnosticCodes = {
    jquery: 'adway.jquery',
    lazy: 'adway.lazy',
    scroll: 'adway.scroll',
    validationMissing: 'adway.validation.missing',
    validationOld: 'adway.validation.old',
    hidden: 'adway.hidden',
    forms: 'adway.forms',
    doctype: 'adway.doctype',
    method: 'adway.method',
    action: 'adway.action',
    requiredName: 'adway.required.name',
    requiredPhone: 'adway.required.phone',
    oneform: 'adway.oneform',
    base: 'adway.base',
    href: 'adway.href',
    target: 'adway.target',
    picture: 'adway.picture',
    linkOutsideHead: 'adway.linkOutsideHead',
    localPath: 'adway.localPath',
    extensionless: 'adway.extensionless',
    externalImage: 'adway.externalImage',
    externalFont: 'adway.externalFont',
    externalCss: 'adway.externalCss',
    externalJs: 'adway.externalJs',
    scriptMissing: 'adway.script.missing',
    scriptUnconnected: 'adway.script.unconnected',
    videoHermes: 'adway.video.hermes',
    videoVideojs: 'adway.video.videojs',
    videoBlob: 'adway.video.blob',
    videoCss: 'adway.video.css',
    videoJs: 'adway.video.js',
    videoMediaPath: 'adway.video.mediaPath',
    videoFormInside: 'adway.video.formInside',
    dtimeDate: 'adway.dtimeDate'
} as const;

export type DiagnosticsUpdatedEvent = {
    uri: vscode.Uri;
    errorCount: number;
    warningCount: number;
};

export function detectCode(text: string): string | undefined {
    const t = text.toLowerCase();
    if (t.includes('dtime_nums') || t.includes('хардкод дат')) {
        return AdwayDiagnosticCodes.dtimeDate;
    }
    if (t.includes('скрипт не подключ') || t.includes('не подключён в html')) {
        return AdwayDiagnosticCodes.scriptUnconnected;
    }
    if (t.includes('скрипт не найден')) {
        return AdwayDiagnosticCodes.scriptMissing;
    }
    if (t.includes('hermes')) {
        return AdwayDiagnosticCodes.videoHermes;
    }
    if (t.includes('videojs') || t.includes('video-js')) {
        return AdwayDiagnosticCodes.videoVideojs;
    }
    if (t.includes('blob:') || t.includes('scrapbook')) {
        return AdwayDiagnosticCodes.videoBlob;
    }
    if (t.includes('css/video.css')) {
        return AdwayDiagnosticCodes.videoCss;
    }
    if (t.includes('js/video.js')) {
        return AdwayDiagnosticCodes.videoJs;
    }
    if (t.includes('не в media') || t.includes('видеофайл в корне') || t.includes('перенесите в media')) {
        return AdwayDiagnosticCodes.videoMediaPath;
    }
    if (t.includes('форма внутри #container_video')) {
        return AdwayDiagnosticCodes.videoFormInside;
    }
    if (t.includes('без расширения') || t.includes('восстановить расширения')) {
        return AdwayDiagnosticCodes.extensionless;
    }
    // пути/внешние ресурсы — раньше jquery (иначе «файл …jquery.min.js» ловится как jquery)
    if (t.includes('неверный путь') || t.includes('файл не найден')) {
        return AdwayDiagnosticCodes.localPath;
    }
    if (t.includes('внешнее изображение')) {
        return AdwayDiagnosticCodes.externalImage;
    }
    if (t.includes('внешний шрифт')) {
        return AdwayDiagnosticCodes.externalFont;
    }
    if (t.includes('внешний css')) {
        return AdwayDiagnosticCodes.externalCss;
    }
    if (t.includes('внешний js')) {
        return AdwayDiagnosticCodes.externalJs;
    }
    if (t.includes('внешний action') || t.includes('action=')) {
        return AdwayDiagnosticCodes.action;
    }
    if (t.includes('jquery') && !t.includes('файл не найден')) {
        return AdwayDiagnosticCodes.jquery;
    }
    if (t.includes('lazy loading')) {
        return AdwayDiagnosticCodes.lazy;
    }
    if (t.includes('элемент с id="oneform"') || (t.includes('id="oneform"') && t.includes('не найден'))) {
        return AdwayDiagnosticCodes.oneform;
    }
    if (t.includes('прокрутк')) {
        return AdwayDiagnosticCodes.scroll;
    }
    if (t.includes('старый валидатор') || t.includes('старые валидаторы') || t.includes('смешанные валидаторы')) {
        return AdwayDiagnosticCodes.validationOld;
    }
    if (t.includes('валидац') || t.includes('валидатор')) {
        return AdwayDiagnosticCodes.validationMissing;
    }
    if (t.includes('формы не найден') || t.includes('форма заказа не найден')) {
        return AdwayDiagnosticCodes.forms;
    }
    if (t.includes('скрытых инпут') || t.includes('отсутствует name=') || t.includes('name="sid" пустой') || t.includes('name="country" пустой')) {
        return AdwayDiagnosticCodes.hidden;
    }
    if (t.includes('doctype')) {
        return AdwayDiagnosticCodes.doctype;
    }
    if (t.includes('method')) {
        return AdwayDiagnosticCodes.method;
    }
    if (t.includes('name="name"') && t.includes('required')) {
        return AdwayDiagnosticCodes.requiredName;
    }
    if (t.includes('name="phone"') && t.includes('required')) {
        return AdwayDiagnosticCodes.requiredPhone;
    }
    if (t.includes('(base)') || t.includes('<base')) {
        return AdwayDiagnosticCodes.base;
    }
    if (t.includes('недопустимая ссылка') || (t.includes('должна быть строго') && t.includes('href'))) {
        return AdwayDiagnosticCodes.href;
    }
    if (t.includes('target=')) {
        return AdwayDiagnosticCodes.target;
    }
    if (t.includes('<picture') && t.includes('<source')) {
        return AdwayDiagnosticCodes.picture;
    }
    if (t.includes('<link') && (t.includes('вне <head') || t.includes('вне &lt;head') || t.includes('перенесите в head'))) {
        return AdwayDiagnosticCodes.linkOutsideHead;
    }
    return undefined;
}

export type ResultFixAction = {
    label: string;
    /** VS Code command id */
    command: string;
};

/** Команды исправления для кода диагностики / сообщения чекера. */
export function getFixesForCode(code: string | undefined): ResultFixAction[] {
    if (!code) {
        return [];
    }

    switch (code) {
        case AdwayDiagnosticCodes.jquery:
            return [{ label: 'Вставить jQuery 3.6.0', command: 'adway.insertJquery' }];
        case AdwayDiagnosticCodes.lazy:
            return [{ label: 'Вставить lazy loading', command: 'adway.insertLazy' }];
        case AdwayDiagnosticCodes.scroll:
            return [
                { label: 'Вставить скрипт прокрутки', command: 'adway.insertScroll' },
                { label: 'Добавить id="oneform" к форме', command: 'adway.addOneform' },
                { label: 'Вставить <span id="oneform">', command: 'adway.insertOneformSpan' }
            ];
        case AdwayDiagnosticCodes.oneform:
            return [
                { label: 'Добавить id="oneform" к форме', command: 'adway.addOneform' },
                { label: 'Вставить <span id="oneform">', command: 'adway.insertOneformSpan' }
            ];
        case AdwayDiagnosticCodes.validationMissing:
            return [
                { label: 'Вставить валидаторы', command: 'adway.insertValidation' },
                { label: 'Вставить все скрипты (lazy+scroll+validation)', command: 'adway.insertScripts' }
            ];
        case AdwayDiagnosticCodes.validationOld:
            return [
                { label: 'Заменить старый валидатор имени', command: 'adway.fixValidationName' },
                { label: 'Вставить новые валидаторы', command: 'adway.insertValidation' }
            ];
        case AdwayDiagnosticCodes.hidden:
        case AdwayDiagnosticCodes.forms:
        case AdwayDiagnosticCodes.method:
        case AdwayDiagnosticCodes.action:
        case AdwayDiagnosticCodes.requiredName:
        case AdwayDiagnosticCodes.requiredPhone:
            return [
                { label: 'Починить форму заказа', command: 'adway.fixOrderForm' },
                { label: 'Вставить 6 скрытых инпутов', command: 'adway.insertHiddenInputs' }
            ];
        case AdwayDiagnosticCodes.doctype:
            return [{ label: 'Вставить <!DOCTYPE html>', command: 'adway.insertDoctype' }];
        case AdwayDiagnosticCodes.base:
            return [{ label: 'Удалить <base>', command: 'adway.removeBase' }];
        case AdwayDiagnosticCodes.href:
            return [{ label: 'Заменить все href на "#" ', command: 'adway.normalizeHrefs' }];
        case AdwayDiagnosticCodes.target:
            return [
                { label: 'Удалить все target', command: 'adway.removeTarget' },
                { label: 'Починить форму', command: 'adway.fixOrderForm' }
            ];
        case AdwayDiagnosticCodes.picture:
            return [{ label: 'Убрать <source> из <picture>', command: 'adway.flattenPicture' }];
        case AdwayDiagnosticCodes.linkOutsideHead:
            return [
                { label: 'Перенести <link> в <head>', command: 'adway.moveLinksToHead' },
                { label: 'Почистить лендинг', command: 'adway.cleanupLanding' }
            ];
        case AdwayDiagnosticCodes.localPath:
            return [
                { label: 'Исправить путь (HTML + CSS url)', command: 'adway.fixLocalPath' },
                { label: 'Исправить все пути (HTML + CSS)', command: 'adway.fixAllLocalPaths' }
            ];
        case AdwayDiagnosticCodes.extensionless:
            return [
                {
                    label: 'Восстановить расширения ассетов (PNG/SVG/…)',
                    command: 'adway.fixExtensionlessAssets'
                }
            ];
        case AdwayDiagnosticCodes.externalImage:
            return [
                { label: 'Скачать изображение(я) в images/', command: 'adway.downloadExternalImages' },
                { label: 'Открыть в браузере (Save as)', command: 'adway.openExternalImages' }
            ];
        case AdwayDiagnosticCodes.externalFont:
            return [
                { label: 'Скачать шрифт(ы) в fonts/', command: 'adway.downloadExternalImages' },
                { label: 'Открыть в браузере (Save as)', command: 'adway.openExternalImages' }
            ];
        case AdwayDiagnosticCodes.externalCss:
        case AdwayDiagnosticCodes.externalJs:
            return [];
        case AdwayDiagnosticCodes.scriptUnconnected:
            return [
                { label: 'Подключить скрипт в HTML', command: 'adway.connectScriptFile' },
                { label: 'Удалить неподключённый файл', command: 'adway.deleteUnconnectedScript' }
            ];
        case AdwayDiagnosticCodes.scriptMissing:
            return [
                { label: 'Удалить тег <script src>', command: 'adway.removeMissingScriptTag' },
                { label: 'Исправить путь', command: 'adway.fixLocalPath' }
            ];
        case AdwayDiagnosticCodes.videoHermes:
        case AdwayDiagnosticCodes.videoVideojs:
        case AdwayDiagnosticCodes.videoBlob:
        case AdwayDiagnosticCodes.videoCss:
        case AdwayDiagnosticCodes.videoJs:
        case AdwayDiagnosticCodes.videoMediaPath:
        case AdwayDiagnosticCodes.videoFormInside:
            return [{ label: 'Установить Adway видео-плеер (бесплатный)', command: 'adway.setupVideoPlayer' }];
        case AdwayDiagnosticCodes.dtimeDate:
            return [{ label: 'dtime_nums: убрать дату текстом', command: 'adway.fixDtimeDates' }];
        default:
            return [];
    }
}

/** Команды исправления для сообщения чекера (ПКМ в панели результатов). */
export function getFixesForMessage(message: string): ResultFixAction[] {
    return getFixesForCode(detectCode(stripHtml(message).replace(/[✅❌⚠️]/g, '').trim()));
}

const MAX_HTML_CHARS = 4 * 1024 * 1024;

function isCheckableHtml(document: vscode.TextDocument): boolean {
    if (document.languageId !== 'html' && !/\.html?$/i.test(document.fileName)) {
        return false;
    }
    if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
        return false;
    }
    return !document.isClosed;
}

function lineExtent(text: string, line: number): { safeLine: number; endCol: number } {
    const lines = text.split(/\r?\n/);
    const maxLine = Math.max(0, lines.length - 1);
    const safeLine = Math.min(Math.max(0, Number(line) || 0), maxLine);
    return { safeLine, endCol: (lines[safeLine] || '').length };
}

export class AdwayDiagnostics {
    private diagnosticCollection: vscode.DiagnosticCollection;
    private timers = new Map<string, NodeJS.Timeout>();
    private readonly _onDidUpdate = new vscode.EventEmitter<DiagnosticsUpdatedEvent>();
    readonly onDidUpdate = this._onDidUpdate.event;
    private generation = 0;
    /** HTML → доп. URI (CSS и т.п.), куда писали диагностики этой проверки */
    private relatedUris = new Map<string, vscode.Uri[]>();
    /** Одна проверка за раз — иначе jsdom + обход диска валят Extension Host */
    private queue: Promise<void> = Promise.resolve();
    private latest = new Map<string, vscode.TextDocument>();
    private cssTextCache = new Map<string, { mtime: number; text: string }>();

    constructor() {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('adway');
    }

    /** Отложенное обновление — для набора текста и открытия файла */
    scheduleUpdate(document: vscode.TextDocument, delayMs?: number) {
        if (!isCheckableHtml(document)) {
            return;
        }
        const config = vscode.workspace.getConfiguration('adway');
        const delay = delayMs ?? config.get<number>('diagnosticsDebounceMs', 400);
        const key = document.uri.toString();

        const existing = this.timers.get(key);
        if (existing) {
            clearTimeout(existing);
        }

        const timer = setTimeout(() => {
            this.timers.delete(key);
            void this.updateDiagnostics(document);
        }, Math.max(0, delay));
        this.timers.set(key, timer);
    }

    /** Сразу (save / ручная команда) или в очереди (open) */
    async updateDiagnostics(document: vscode.TextDocument) {
        if (!isCheckableHtml(document)) {
            return;
        }
        const key = document.uri.toString();
        this.latest.set(key, document);
        const job = this.queue.then(() => this.drain(key));
        this.queue = job.then(
            () => undefined,
            () => undefined
        );
        try {
            await job;
        } catch (e: unknown) {
            console.error('Adway Checker: диагностика', e);
        }
    }

    private async drain(key: string): Promise<void> {
        const document = this.latest.get(key);
        if (!document) {
            return;
        }
        this.latest.delete(key);
        await this.runDiagnosticsOnce(document);
    }

    private readCssText(absPath: string): string | undefined {
        try {
            const st = fs.statSync(absPath);
            const cached = this.cssTextCache.get(absPath);
            if (cached && cached.mtime === st.mtimeMs) {
                return cached.text;
            }
            const text = fs.readFileSync(absPath, 'utf8');
            this.cssTextCache.set(absPath, { mtime: st.mtimeMs, text });
            if (this.cssTextCache.size > 40) {
                const first = this.cssTextCache.keys().next().value;
                if (first) {
                    this.cssTextCache.delete(first);
                }
            }
            return text;
        } catch {
            return undefined;
        }
    }

    private async runDiagnosticsOnce(document: vscode.TextDocument) {
        try {
            await this.runDiagnosticsOnceUnsafe(document);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error('Adway Checker: диагностика упала', e);
            try {
                this.diagnosticCollection.set(document.uri, [
                    new vscode.Diagnostic(
                        new vscode.Range(0, 0, 0, 0),
                        `Adway: ошибка проверки — ${msg}`,
                        vscode.DiagnosticSeverity.Error
                    )
                ]);
                this._onDidUpdate.fire({ uri: document.uri, errorCount: 1, warningCount: 0 });
            } catch {
                // ignore
            }
        }
    }

    private async runDiagnosticsOnceUnsafe(document: vscode.TextDocument) {
        if (document.isClosed || !isCheckableHtml(document)) {
            return;
        }

        const config = vscode.workspace.getConfiguration('adway');
        const enabled = config.get<boolean>('enableDiagnostics', true);
        const htmlKey = document.uri.toString();

        // сбросить прошлые CSS-диагностики этой HTML-проверки
        for (const u of this.relatedUris.get(htmlKey) || []) {
            this.diagnosticCollection.delete(u);
        }
        this.relatedUris.delete(htmlKey);

        if (!enabled) {
            this.diagnosticCollection.delete(document.uri);
            this._onDidUpdate.fire({ uri: document.uri, errorCount: 0, warningCount: 0 });
            return;
        }

        if (document.getText().length > MAX_HTML_CHARS) {
            this.diagnosticCollection.set(document.uri, [
                new vscode.Diagnostic(
                    new vscode.Range(0, 0, 0, 0),
                    'Adway: файл слишком большой для автопроверки — откройте команду «Проверить лендинг»',
                    vscode.DiagnosticSeverity.Warning
                )
            ]);
            this._onDidUpdate.fire({ uri: document.uri, errorCount: 0, warningCount: 1 });
            return;
        }

        const gen = ++this.generation;
        let results;
        try {
            results = await new LandingChecker(document).check();
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error('Adway Checker: диагностика упала', e);
            this.diagnosticCollection.set(document.uri, [
                new vscode.Diagnostic(
                    new vscode.Range(0, 0, 0, 0),
                    `Adway: ошибка проверки — ${msg}`,
                    vscode.DiagnosticSeverity.Error
                )
            ]);
            this._onDidUpdate.fire({ uri: document.uri, errorCount: 1, warningCount: 0 });
            return;
        }

        // Устаревший результат после более нового запуска
        if (gen !== this.generation) {
            return;
        }

        const htmlDir =
            document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : undefined;
        const byUri = new Map<string, { uri: vscode.Uri; diags: vscode.Diagnostic[] }>();
        const ensure = (uri: vscode.Uri) => {
            const k = uri.toString();
            let entry = byUri.get(k);
            if (!entry) {
                entry = { uri, diags: [] };
                byUri.set(k, entry);
            }
            return entry;
        };
        ensure(document.uri);

        let errorCount = 0;
        let warningCount = 0;

        for (const result of results) {
            if (result.success === true) {
                continue;
            }

            const isWarning = result.success === 'warning';
            const severity =
                result.severity ??
                (isWarning ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);

            if (isWarning) {
                warningCount++;
            } else {
                errorCount++;
            }

            const message = stripHtml(result.text).replace(/[✅❌⚠️]/g, '').trim();
            let targetUri = document.uri;
            let extent = lineExtent(document.getText(), result.line ?? 0);

            if (result.file && htmlDir) {
                const abs = path.resolve(htmlDir, result.file);
                const cssText = this.readCssText(abs);
                if (cssText !== undefined) {
                    targetUri = vscode.Uri.file(abs);
                    extent = lineExtent(cssText, result.line ?? 0);
                }
            }

            const range = new vscode.Range(
                new vscode.Position(extent.safeLine, 0),
                new vscode.Position(extent.safeLine, extent.endCol)
            );

            const diagnostic = new vscode.Diagnostic(range, message, severity);
            diagnostic.source = 'Adway Checker';
            const code = detectCode(message);
            if (code) {
                diagnostic.code = code;
            }
            ensure(targetUri).diags.push(diagnostic);
        }

        const related: vscode.Uri[] = [];
        for (const { uri, diags } of byUri.values()) {
            this.diagnosticCollection.set(uri, diags);
            if (uri.toString() !== htmlKey) {
                related.push(uri);
            }
        }
        this.relatedUris.set(htmlKey, related);
        this._onDidUpdate.fire({ uri: document.uri, errorCount, warningCount });
    }

    getDiagnostics(uri: vscode.Uri): readonly vscode.Diagnostic[] {
        return this.diagnosticCollection.get(uri) || [];
    }

    /** Диагностики HTML + связанных CSS (для дерева результатов). */
    getIssueEntries(htmlUri: vscode.Uri): Array<{ uri: vscode.Uri; diagnostic: vscode.Diagnostic }> {
        const out: Array<{ uri: vscode.Uri; diagnostic: vscode.Diagnostic }> = [];
        for (const d of this.getDiagnostics(htmlUri)) {
            out.push({ uri: htmlUri, diagnostic: d });
        }
        for (const u of this.relatedUris.get(htmlUri.toString()) || []) {
            for (const d of this.getDiagnostics(u)) {
                out.push({ uri: u, diagnostic: d });
            }
        }
        return out;
    }

    dispose() {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
        this._onDidUpdate.dispose();
        this.diagnosticCollection.dispose();
    }
}
