import * as vscode from 'vscode';

export type AdwayCommandDef = {
    label: string;
    command: string;
    description?: string;
    detail?: string;
    icon?: string;
};

export type AdwayCommandGroup = {
    id: string;
    label: string;
    items: AdwayCommandDef[];
};

/** Общий список команд для меню и постоянной панели. */
export const ADWAY_COMMAND_GROUPS: AdwayCommandGroup[] = [
    {
        id: 'check',
        label: 'Проверка',
        items: [
            {
                label: 'Проверить лендинг',
                command: 'adway.checkLanding',
                description: 'Ctrl+Alt+A',
                icon: 'checklist'
            },
            {
                label: 'Мастер правок (Compare)',
                command: 'adway.fixWizard',
                icon: 'diff'
            },
            {
                label: 'Почистить лендинг',
                command: 'adway.cleanupLanding',
                description: 'Ctrl+Alt+C',
                icon: 'clear-all'
            },
            {
                label: 'Результаты',
                command: 'adway.focusResultsTree',
                icon: 'browser'
            }
        ]
    },
    {
        id: 'fix',
        label: 'Правки',
        items: [
            {
                label: 'Починить форму заказа',
                command: 'adway.fixOrderForm',
                icon: 'tools'
            },
            {
                label: 'dtime_nums — убрать дату текстом',
                command: 'adway.fixDtimeDates',
                icon: 'calendar'
            },
            {
                label: 'Исправить все пути',
                command: 'adway.fixAllLocalPaths',
                icon: 'file-symlink-file'
            },
            {
                label: 'Файлы без расширений',
                command: 'adway.fixExtensionlessAssets',
                icon: 'file-binary'
            },
            {
                label: 'Скачать внешние изображения и шрифты',
                command: 'adway.downloadExternalImages',
                icon: 'cloud-download'
            },
            {
                label: 'Удалить дубли images/css/js',
                command: 'adway.dedupeImages',
                icon: 'group-by-ref-type'
            },
            {
                label: 'Перенести link в head',
                command: 'adway.moveLinksToHead',
                icon: 'arrow-up'
            }
        ]
    },
    {
        id: 'media',
        label: 'Видео и шапка',
        items: [
            {
                label: 'Установить видео-плеер',
                command: 'adway.setupVideoPlayer',
                icon: 'device-camera-video'
            },
            {
                label: 'Шапка / подвал по ссылке',
                command: 'adway.importHeaderFooter',
                icon: 'window'
            }
        ]
    },
    {
        id: 'insert',
        label: 'Вставки',
        items: [
            {
                label: 'Сниппеты…',
                command: 'adway.openSnippets',
                icon: 'symbol-snippet'
            },
            {
                label: 'Вставить jQuery',
                command: 'adway.insertJquery',
                icon: 'code'
            },
            {
                label: 'Обязательные скрипты',
                command: 'adway.insertScripts',
                icon: 'file-code'
            },
            {
                label: 'Скрытые инпуты',
                command: 'adway.insertHiddenInputs',
                icon: 'symbol-field'
            },
            {
                label: 'Форма заказа',
                command: 'adway.insertForm',
                icon: 'editor-layout'
            }
        ]
    },
    {
        id: 'project',
        label: 'Проект',
        items: [
            {
                label: 'Создать структуру проекта',
                command: 'adway.initProjectStructure',
                icon: 'folder-opened'
            },
            {
                label: 'Обновить кэш SID/Country',
                command: 'adway.refreshSheets',
                icon: 'refresh'
            }
        ]
    }
];

export async function showAdwayCommandMenu(): Promise<void> {
    const items: Array<vscode.QuickPickItem & { command?: string }> = [];
    for (const group of ADWAY_COMMAND_GROUPS) {
        items.push({ label: group.label, kind: vscode.QuickPickItemKind.Separator });
        for (const it of group.items) {
            items.push({
                label: it.icon ? `$(${it.icon}) ${it.label}` : it.label,
                description: it.description,
                detail: it.detail,
                command: it.command
            });
        }
    }

    const pick = await vscode.window.showQuickPick(items, {
        title: 'Adway — команды',
        placeHolder: 'Выбери действие…',
        matchOnDescription: true,
        matchOnDetail: true
    });

    if (pick?.command) {
        await vscode.commands.executeCommand(pick.command);
    }
}
