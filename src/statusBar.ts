import * as vscode from 'vscode';
import { DiagnosticsUpdatedEvent } from './diagnostics';

export class AdwayStatusBar {
    private item: vscode.StatusBarItem;
    private lastByUri = new Map<string, { errors: number; warnings: number }>();

    constructor() {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
        this.item.command = 'adway.focusResultsTree';
        this.item.tooltip = 'Adway Checker — клик: панель результатов';
        this.item.text = 'Adway: —';
        this.item.show();
    }

    onDiagnosticsUpdated(event: DiagnosticsUpdatedEvent) {
        this.lastByUri.set(event.uri.toString(), {
            errors: event.errorCount,
            warnings: event.warningCount
        });
        this.refreshForActiveEditor();
    }

    refreshForActiveEditor() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'html') {
            this.item.hide();
            return;
        }

        this.item.show();
        const stats = this.lastByUri.get(editor.document.uri.toString());
        if (!stats) {
            this.item.text = 'Adway: …';
            this.item.backgroundColor = undefined;
            return;
        }

        if (stats.errors === 0 && stats.warnings === 0) {
            this.item.text = '$(check) Adway: OK';
            this.item.backgroundColor = undefined;
            return;
        }

        const parts: string[] = [];
        if (stats.errors > 0) {
            parts.push(`${stats.errors} ошиб${pluralRu(stats.errors, 'ка', 'ки', 'ок')}`);
        }
        if (stats.warnings > 0) {
            parts.push(`${stats.warnings} предупр.`);
        }

        this.item.text = `$(warning) Adway: ${parts.join(', ')}`;
        this.item.backgroundColor =
            stats.errors > 0
                ? new vscode.ThemeColor('statusBarItem.errorBackground')
                : new vscode.ThemeColor('statusBarItem.warningBackground');
    }

    dispose() {
        this.item.dispose();
    }
}

function pluralRu(n: number, one: string, few: string, many: string): string {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) {
        return one;
    }
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
        return few;
    }
    return many;
}
