import * as vscode from 'vscode';
import { stripHtml } from './checkTypes';
import { AdwayDiagnostics, DiagnosticsUpdatedEvent } from './diagnostics';

export type ResultGroupId = 'main' | 'forms' | 'sid' | 'links' | 'scripts';

const GROUP_ORDER: ResultGroupId[] = ['main', 'forms', 'sid', 'links', 'scripts'];

const GROUP_LABELS: Record<ResultGroupId, string> = {
    main: 'Основные',
    forms: 'Формы',
    sid: 'SID / Country',
    links: 'Ссылки и ресурсы',
    scripts: 'Скрипты'
};

export function classifyResultMessage(message: string): ResultGroupId {
    const t = message.toLowerCase();

    if (
        t.includes('sid') ||
        t.includes('country') ||
        (t.includes('таблиц') && (t.includes('sid') || t.includes('country')))
    ) {
        return 'sid';
    }

    if (
        t.includes('форм') ||
        t.includes('action=') ||
        t.includes('method') ||
        t.includes('скрыт') ||
        t.includes('hidden') ||
        t.includes('name="name"') ||
        t.includes('name="phone"') ||
        t.includes('required') ||
        t.includes('<select') ||
        t.includes('oneform') ||
        t.includes('fbpx') ||
        t.includes('utm_code')
    ) {
        return 'forms';
    }

    if (
        t.includes('href') ||
        t.includes('ссылк') ||
        t.includes('target=') ||
        t.includes('внешн') ||
        t.includes('изображен') ||
        t.includes('файл не найден') ||
        t.includes('неверный путь') ||
        t.includes('<picture') ||
        t.includes('css:') ||
        t.includes(' img ')
    ) {
        return 'links';
    }

    if (
        t.includes('скрипт') ||
        t.includes('jquery') ||
        t.includes('валидатор') ||
        t.includes('валидац') ||
        t.includes('lazy') ||
        t.includes('прокрутк') ||
        t.includes('неиспользуем') ||
        t.includes('дублирующ') ||
        t.includes('не подключ') ||
        t.includes('пустой <script')
    ) {
        return 'scripts';
    }

    return 'main';
}

type TreeNode =
    | { kind: 'group'; groupId: ResultGroupId; label: string; count: number }
    | {
          kind: 'issue';
          groupId: ResultGroupId;
          message: string;
          severity: vscode.DiagnosticSeverity;
          uri: vscode.Uri;
          line: number;
      }
    | { kind: 'empty'; label: string };

export class AdwayResultsTreeProvider implements vscode.TreeDataProvider<TreeNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private currentUri: vscode.Uri | undefined;

    constructor(private diagnostics: AdwayDiagnostics) {}

    refresh(uri?: vscode.Uri) {
        if (uri) {
            this.currentUri = uri;
        }
        this._onDidChangeTreeData.fire();
    }

    onDiagnosticsUpdated(event: DiagnosticsUpdatedEvent) {
        this.currentUri = event.uri;
        this.refresh();
    }

    onActiveEditorChanged(editor: vscode.TextEditor | undefined) {
        if (editor && editor.document.languageId === 'html') {
            this.currentUri = editor.document.uri;
            this.refresh();
        } else if (!editor || editor.document.languageId !== 'html') {
            // keep last uri so tree still shows last HTML check
            this.refresh();
        }
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        try {
            return this.buildTreeItem(element);
        } catch (e: unknown) {
            console.error('Adway Checker: дерево результатов', e);
            return new vscode.TreeItem('Adway: ошибка панели', vscode.TreeItemCollapsibleState.None);
        }
    }

    private buildTreeItem(element: TreeNode): vscode.TreeItem {
        if (element.kind === 'empty') {
            const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('info');
            return item;
        }

        if (element.kind === 'group') {
            const item = new vscode.TreeItem(
                `${element.label} (${element.count})`,
                element.count > 0
                    ? vscode.TreeItemCollapsibleState.Expanded
                    : vscode.TreeItemCollapsibleState.Collapsed
            );
            item.contextValue = 'adwayGroup';
            item.iconPath = new vscode.ThemeIcon(iconForGroup(element.groupId));
            return item;
        }

        const item = new vscode.TreeItem(element.message, vscode.TreeItemCollapsibleState.None);
        item.description = `стр. ${element.line + 1}`;
        item.tooltip = `${element.message}\n${element.uri.fsPath}:${element.line + 1}`;
        item.iconPath = new vscode.ThemeIcon(
            element.severity === vscode.DiagnosticSeverity.Warning ? 'warning' : 'error'
        );
        // Не ставить resourceUri — иначе клик открывает файл без команды/строки
        item.command = {
            command: 'adway.openTreeIssue',
            title: 'Открыть',
            arguments: [element.uri.toString(), element.line]
        };
        return item;
    }

    getChildren(element?: TreeNode): TreeNode[] {
        try {
            return this.buildChildren(element);
        } catch (e: unknown) {
            console.error('Adway Checker: дерево результатов', e);
            return [{ kind: 'empty', label: 'Adway: ошибка панели' }];
        }
    }

    private buildChildren(element?: TreeNode): TreeNode[] {
        const uri = this.currentUri ?? vscode.window.activeTextEditor?.document.uri;
        if (!uri) {
            return [{ kind: 'empty', label: 'Откройте HTML-файл' }];
        }

        const all = this.diagnostics.getIssueEntries(uri);
        if (!element) {
            if (all.length === 0) {
                return [{ kind: 'empty', label: 'Adway: OK — проблем нет' }];
            }

            const counts = new Map<ResultGroupId, number>();
            for (const id of GROUP_ORDER) {
                counts.set(id, 0);
            }
            for (const { diagnostic: d } of all) {
                const id = classifyResultMessage(d.message);
                counts.set(id, (counts.get(id) || 0) + 1);
            }

            return GROUP_ORDER.filter(id => (counts.get(id) || 0) > 0).map(id => ({
                kind: 'group' as const,
                groupId: id,
                label: GROUP_LABELS[id],
                count: counts.get(id) || 0
            }));
        }

        if (element.kind !== 'group') {
            return [];
        }

        return all
            .filter(({ diagnostic: d }) => classifyResultMessage(d.message) === element.groupId)
            .map(({ uri: issueUri, diagnostic: d }) => ({
                kind: 'issue' as const,
                groupId: element.groupId,
                message: stripHtml(d.message).replace(/[✅❌⚠️]/g, '').trim() || d.message,
                severity: d.severity,
                uri: issueUri,
                line: d.range.start.line
            }));
    }
}

function iconForGroup(id: ResultGroupId): string {
    switch (id) {
        case 'forms':
            return 'list-ordered';
        case 'sid':
            return 'key';
        case 'links':
            return 'link';
        case 'scripts':
            return 'file-code';
        default:
            return 'checklist';
    }
}
