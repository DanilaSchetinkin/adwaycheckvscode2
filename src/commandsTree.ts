import * as vscode from 'vscode';
import { ADWAY_COMMAND_GROUPS, AdwayCommandDef, AdwayCommandGroup } from './commandMenu';

type CmdNode =
    | { kind: 'group'; group: AdwayCommandGroup }
    | { kind: 'cmd'; item: AdwayCommandDef };

/**
 * Постоянное дерево команд в сайдбаре Adway.
 */
export class AdwayCommandsTreeProvider implements vscode.TreeDataProvider<CmdNode> {
    getTreeItem(element: CmdNode): vscode.TreeItem {
        if (element.kind === 'group') {
            const item = new vscode.TreeItem(
                element.group.label,
                vscode.TreeItemCollapsibleState.Expanded
            );
            item.contextValue = 'adwayCmdGroup';
            item.iconPath = new vscode.ThemeIcon('folder');
            return item;
        }

        const item = new vscode.TreeItem(element.item.label, vscode.TreeItemCollapsibleState.None);
        item.description = element.item.description;
        item.tooltip = element.item.detail || element.item.label;
        item.contextValue = 'adwayCmd';
        if (element.item.icon) {
            item.iconPath = new vscode.ThemeIcon(element.item.icon);
        }
        item.command = {
            command: element.item.command,
            title: element.item.label
        };
        return item;
    }

    getChildren(element?: CmdNode): CmdNode[] {
        if (!element) {
            return ADWAY_COMMAND_GROUPS.map(group => ({ kind: 'group' as const, group }));
        }
        if (element.kind === 'group') {
            return element.group.items.map(item => ({ kind: 'cmd' as const, item }));
        }
        return [];
    }
}
