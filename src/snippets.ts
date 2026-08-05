import * as vscode from 'vscode';
import { buildFixEdit } from './codeActions';
import {
    DATE_SNIPPET,
    FORM_SNIPPET,
    HIDDEN_INPUTS,
    JQUERY_SNIPPET,
    ONEFORM_SPAN,
    REQUIRED_SCRIPTS,
    TIMER_SNIPPET,
    VIDEO_SNIPPET,
    VIEWPORT_VIETNAM
} from './snippetTexts';

export class SnippetProvider {
    private async insertText(text: string) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        await editor.edit(editBuilder => {
            editBuilder.insert(editor.selection.active, text);
        });
    }

    async insertJquery() {
        await this.insertText(JQUERY_SNIPPET);
    }

    async insertScripts() {
        await this.insertText('\n' + REQUIRED_SCRIPTS);
    }

    async insertHiddenInputs() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        const line = editor.selection.active.line;
        const edit = buildFixEdit(editor.document, 'hidden', line);
        if (edit) {
            await vscode.workspace.applyEdit(edit);
            return;
        }
        await this.insertText(HIDDEN_INPUTS);
    }

    async insertForm() {
        await this.insertText(FORM_SNIPPET);
    }

    async insertDate() {
        await this.insertText(DATE_SNIPPET);
    }

    async insertVideoScript() {
        await this.insertText(VIDEO_SNIPPET);
    }

    async insertViewportVietnam() {
        await this.insertText(VIEWPORT_VIETNAM);
    }

    async insertOneformSpan() {
        await this.insertText(ONEFORM_SPAN);
    }

    async insertTimer() {
        await this.insertText(TIMER_SNIPPET);
    }

    async showSnippetsPicker() {
        const items = [
            { label: '$(file-code) jQuery 3.6.0', description: 'Вставить jQuery скрипт', value: 'jquery' },
            { label: '$(file-code) Обязательные скрипты', description: 'Lazy loading, scroll, validation', value: 'scripts' },
            { label: '$(symbol-ruler) <span id="oneform">', description: 'Якорь для скрипта прокрутки', value: 'oneform' },
            { label: '$(file-code) Скрытые инпуты', description: 'fbpx, utm_code, cid, sid, hash, country', value: 'hidden' },
            { label: '$(file-code) Полная форма', description: 'Форма с инпутами и кнопкой', value: 'form' },
            { label: '$(calendar) Дата', description: 'Скрипт для вывода даты', value: 'date' },
            { label: '$(device-camera-video) HLS Video', description: 'Скрипт для HLS видео', value: 'video' },
            { label: '$(tag) Viewport для Вьетнама', description: 'Meta viewport для вьетнамских лендингов', value: 'viewport' },
            { label: '$(symbol-color) Таймер', description: 'Таймер обратного отсчёта', value: 'timer' }
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Выберите сниппет для вставки'
        });

        if (!selected) {
            return;
        }

        switch (selected.value) {
            case 'jquery':
                await this.insertJquery();
                break;
            case 'scripts':
                await this.insertScripts();
                break;
            case 'oneform':
                await this.insertOneformSpan();
                break;
            case 'hidden':
                await this.insertHiddenInputs();
                break;
            case 'form':
                await this.insertForm();
                break;
            case 'date':
                await this.insertDate();
                break;
            case 'video':
                await this.insertVideoScript();
                break;
            case 'viewport':
                await this.insertViewportVietnam();
                break;
            case 'timer':
                await this.insertTimer();
                break;
        }
    }
}
