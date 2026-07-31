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
    localPath: 'adway.localPath',
    externalImage: 'adway.externalImage',
    externalCss: 'adway.externalCss',
    externalJs: 'adway.externalJs'
} as const;

export type DiagnosticsUpdatedEvent = {
    uri: vscode.Uri;
    errorCount: number;
    warningCount: number;
};

export function detectCode(text: string): string | undefined {
    const t = text.toLowerCase();
    // пути/внешние ресурсы — раньше jquery (иначе «файл …jquery.min.js» ловится как jquery)
    if (t.includes('неверный путь') || t.includes('файл не найден')) {
        return AdwayDiagnosticCodes.localPath;
    }
    if (t.includes('внешнее изображение')) {
        return AdwayDiagnosticCodes.externalImage;
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
                { label: 'Добавить id="oneform"', command: 'adway.addOneform' }
            ];
        case AdwayDiagnosticCodes.oneform:
            return [{ label: 'Добавить id="oneform"', command: 'adway.addOneform' }];
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
        case AdwayDiagnosticCodes.localPath:
            return [
                { label: 'Исправить путь (images/css/js)', command: 'adway.fixLocalPath' },
                { label: 'Исправить все пути', command: 'adway.fixAllLocalPaths' }
            ];
        case AdwayDiagnosticCodes.externalImage:
            return [
                { label: 'Скачать изображение(я) в images/', command: 'adway.downloadExternalImages' },
                { label: 'Открыть в браузере (Save as)', command: 'adway.openExternalImages' }
            ];
        case AdwayDiagnosticCodes.externalCss:
        case AdwayDiagnosticCodes.externalJs:
            return [];
        default:
            return [];
    }
}

/** Команды исправления для сообщения чекера (ПКМ в панели результатов). */
export function getFixesForMessage(message: string): ResultFixAction[] {
    return getFixesForCode(detectCode(stripHtml(message).replace(/[✅❌⚠️]/g, '').trim()));
}

export class AdwayDiagnostics {
    private diagnosticCollection: vscode.DiagnosticCollection;
    private timers = new Map<string, NodeJS.Timeout>();
    private readonly _onDidUpdate = new vscode.EventEmitter<DiagnosticsUpdatedEvent>();
    readonly onDidUpdate = this._onDidUpdate.event;
    private generation = 0;

    constructor() {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('adway');
    }

    /** Отложенное обновление — для набора текста */
    scheduleUpdate(document: vscode.TextDocument, delayMs?: number) {
        if (document.languageId !== 'html') {
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
        }, delay);
        this.timers.set(key, timer);
    }

    /** Сразу (open / save / ручная команда) */
    async updateDiagnostics(document: vscode.TextDocument) {
        if (document.languageId !== 'html') {
            return;
        }

        const config = vscode.workspace.getConfiguration('adway');
        const enabled = config.get<boolean>('enableDiagnostics', true);

        if (!enabled) {
            this.diagnosticCollection.delete(document.uri);
            this._onDidUpdate.fire({ uri: document.uri, errorCount: 0, warningCount: 0 });
            return;
        }

        const gen = ++this.generation;
        const checker = new LandingChecker(document);
        const results = await checker.check();

        // Устаревший результат после более нового запуска
        if (gen !== this.generation) {
            return;
        }

        const diagnostics: vscode.Diagnostic[] = [];
        let errorCount = 0;
        let warningCount = 0;

        results.forEach(result => {
            if (result.success === true) {
                return;
            }

            const line = result.line ?? 0;
            const maxLine = Math.max(0, document.lineCount - 1);
            const safeLine = Math.min(line, maxLine);
            const range = new vscode.Range(
                new vscode.Position(safeLine, 0),
                new vscode.Position(safeLine, document.lineAt(safeLine).text.length)
            );

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
            const diagnostic = new vscode.Diagnostic(range, message, severity);
            diagnostic.source = 'Adway Checker';
            const code = detectCode(message);
            if (code) {
                diagnostic.code = code;
            }
            diagnostics.push(diagnostic);
        });

        this.diagnosticCollection.set(document.uri, diagnostics);
        this._onDidUpdate.fire({ uri: document.uri, errorCount, warningCount });
    }

    getDiagnostics(uri: vscode.Uri): readonly vscode.Diagnostic[] {
        return this.diagnosticCollection.get(uri) || [];
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
