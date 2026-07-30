import * as path from 'path';
import * as vscode from 'vscode';

const STRUCTURE_DIRS = ['images', 'css', 'js', 'other'] as const;

const KEEP_DIRS = new Set([
    'images',
    'css',
    'js',
    'other',
    '.git',
    '.svn',
    '.hg',
    '.vscode',
    '.cursor',
    '.idea',
    'node_modules'
]);

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif']);
const CSS_EXT = new Set(['.css']);
const JS_EXT = new Set(['.js', '.mjs', '.cjs']);
const HTML_EXT = new Set(['.html', '.htm']);

const INDEX_HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Landing</title>
  <link rel="stylesheet" href="css/style.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js" referrerpolicy="no-referrer"></script>
</head>
<body>
  <div id="oneform">
    <!-- форма заказа -->
  </div>
  <script src="js/main.js"></script>
</body>
</html>
`;

const STYLE_CSS_TEMPLATE = `/* styles */\n`;
const MAIN_JS_TEMPLATE = `// scripts\n`;

export interface StructureResult {
    created: string[];
    moved: string[];
    renamed: string[];
    skipped: string[];
}

type FileBucket = 'images' | 'css' | 'js' | 'other' | 'html';

function extOf(name: string): string {
    return path.extname(name).toLowerCase();
}

function classifyFile(name: string): FileBucket {
    const ext = extOf(name);
    if (HTML_EXT.has(ext)) {
        return 'html';
    }
    if (IMAGE_EXT.has(ext)) {
        return 'images';
    }
    if (CSS_EXT.has(ext)) {
        return 'css';
    }
    if (JS_EXT.has(ext)) {
        return 'js';
    }
    return 'other';
}

async function exists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

async function ensureDir(root: vscode.Uri, name: string, created: string[]): Promise<void> {
    const uri = vscode.Uri.joinPath(root, name);
    if (!(await exists(uri))) {
        await vscode.workspace.fs.createDirectory(uri);
        created.push(name + '/');
    }
}

async function ensureFile(
    root: vscode.Uri,
    relativePath: string,
    content: string,
    created: string[]
): Promise<void> {
    const uri = vscode.Uri.joinPath(root, ...relativePath.split('/'));
    if (!(await exists(uri))) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        created.push(relativePath);
    }
}

async function uniqueTarget(dir: vscode.Uri, name: string): Promise<vscode.Uri> {
    let candidate = vscode.Uri.joinPath(dir, name);
    if (!(await exists(candidate))) {
        return candidate;
    }
    const ext = path.extname(name);
    const base = ext ? name.slice(0, -ext.length) : name;
    let i = 1;
    while (await exists(candidate)) {
        candidate = vscode.Uri.joinPath(dir, `${base}_${i}${ext}`);
        i++;
    }
    return candidate;
}

/** rename, при неудаче — copy + delete */
async function moveUri(
    from: vscode.Uri,
    to: vscode.Uri,
    skipped: string[],
    label: string
): Promise<boolean> {
    try {
        await vscode.workspace.fs.rename(from, to, { overwrite: false });
        return true;
    } catch {
        try {
            const data = await vscode.workspace.fs.readFile(from);
            await vscode.workspace.fs.writeFile(to, data);
            await vscode.workspace.fs.delete(from, { recursive: true, useTrash: false });
            return true;
        } catch (e2: unknown) {
            const msg = e2 instanceof Error ? e2.message : String(e2);
            skipped.push(`${label} (${msg})`);
            return false;
        }
    }
}

async function moveFile(
    from: vscode.Uri,
    destFolderUri: vscode.Uri,
    destFolderName: string,
    fileName: string,
    moved: string[],
    skipped: string[],
    pathMap?: Map<string, string>
): Promise<void> {
    const to = await uniqueTarget(destFolderUri, fileName);
    const ok = await moveUri(from, to, skipped, `${fileName} → ${destFolderName}/`);
    if (!ok) {
        return;
    }
    const destName = path.posix.basename(to.path);
    const destPath = `${destFolderName}/${destName}`;
    moved.push(`${fileName} → ${destPath}`);
    if (pathMap && destFolderName !== 'other') {
        pathMap.set(fileName, destPath);
    }
}

async function isStubIndex(uri: vscode.Uri): Promise<boolean> {
    try {
        const buf = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(buf).toString('utf8');
        return (
            text.includes('<!-- форма заказа -->') &&
            text.includes('href="css/style.css"') &&
            text.includes('src="js/main.js"')
        );
    } catch {
        return false;
    }
}

interface HtmlCandidate {
    name: string;
    uri: vscode.Uri;
    fromOther: boolean;
}

async function collectHtmlCandidates(root: vscode.Uri): Promise<HtmlCandidate[]> {
    const result: HtmlCandidate[] = [];
    const rootEntries = await vscode.workspace.fs.readDirectory(root);
    for (const [name, type] of rootEntries) {
        if (type === vscode.FileType.File && HTML_EXT.has(extOf(name))) {
            result.push({ name, uri: vscode.Uri.joinPath(root, name), fromOther: false });
        }
    }
    const otherDir = vscode.Uri.joinPath(root, 'other');
    if (await exists(otherDir)) {
        const otherEntries = await vscode.workspace.fs.readDirectory(otherDir);
        for (const [name, type] of otherEntries) {
            if (type === vscode.FileType.File && HTML_EXT.has(extOf(name))) {
                result.push({
                    name,
                    uri: vscode.Uri.joinPath(otherDir, name),
                    fromOther: true
                });
            }
        }
    }
    return result;
}

async function promoteMainHtml(
    root: vscode.Uri,
    moved: string[],
    renamed: string[],
    skipped: string[],
    created: string[]
): Promise<void> {
    const indexUri = vscode.Uri.joinPath(root, 'index.html');
    const hasIndex = await exists(indexUri);
    const indexIsStub = hasIndex ? await isStubIndex(indexUri) : false;

    const candidates = await collectHtmlCandidates(root);
    const nonIndex = candidates.filter(c => c.name.toLowerCase() !== 'index.html');

    // Нормальный index уже есть — лишние HTML в other
    if (hasIndex && !indexIsStub) {
        for (const c of nonIndex) {
            if (c.fromOther) {
                continue; // уже в other
            }
            await moveFile(
                c.uri,
                vscode.Uri.joinPath(root, 'other'),
                'other',
                c.name,
                moved,
                skipped
            );
        }
        return;
    }

    let main: HtmlCandidate | undefined;
    if (nonIndex.length === 1) {
        main = nonIndex[0];
    } else if (nonIndex.length > 1) {
        const picked = await vscode.window.showQuickPick(
            nonIndex.map(c => ({
                label: c.name,
                description: c.fromOther ? 'сейчас в other/' : 'в корне',
                candidate: c
            })),
            {
                title: 'Adway: какой HTML сделать index.html?',
                placeHolder: 'Выберите основной лендинг'
            }
        );
        main = picked?.candidate;
        if (!main) {
            if (!hasIndex) {
                await ensureFile(root, 'index.html', INDEX_HTML_TEMPLATE, created);
            }
            return;
        }
    }

    if (main) {
        // Убрать stub
        if (hasIndex && indexIsStub) {
            try {
                await vscode.workspace.fs.delete(indexUri, { useTrash: false });
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                // Если не удалось удалить — уводим в other
                const backup = await uniqueTarget(vscode.Uri.joinPath(root, 'other'), 'index_stub.html');
                const ok = await moveUri(indexUri, backup, skipped, `index.html stub → other/`);
                if (!ok) {
                    skipped.push(`index.html stub (${msg})`);
                    return;
                }
            }
        } else if (hasIndex && (await exists(indexUri))) {
            await moveFile(
                indexUri,
                vscode.Uri.joinPath(root, 'other'),
                'other',
                'index.html',
                moved,
                skipped
            );
        }

        const ok = await moveUri(main.uri, indexUri, skipped, `${main.name} → index.html`);
        if (ok) {
            renamed.push(`${main.name} → index.html`);
        }

        for (const c of nonIndex) {
            if (c.name === main.name && c.fromOther === main.fromOther) {
                continue;
            }
            if (!(await exists(c.uri))) {
                continue;
            }
            if (c.fromOther) {
                continue;
            }
            await moveFile(
                c.uri,
                vscode.Uri.joinPath(root, 'other'),
                'other',
                c.name,
                moved,
                skipped
            );
        }
        return;
    }

    if (!hasIndex) {
        await ensureFile(root, 'index.html', INDEX_HTML_TEMPLATE, created);
    }
}

/**
 * Раскладывает файлы из корня и из other/ по images/css/js/other.
 */
async function redistributeAssets(
    root: vscode.Uri,
    moved: string[],
    skipped: string[],
    pathMap: Map<string, string>
): Promise<void> {
    const imagesDir = vscode.Uri.joinPath(root, 'images');
    const cssDir = vscode.Uri.joinPath(root, 'css');
    const jsDir = vscode.Uri.joinPath(root, 'js');
    const otherDir = vscode.Uri.joinPath(root, 'other');

    type Item = { name: string; uri: vscode.Uri; source: 'root' | 'other' };
    const items: Item[] = [];

    const rootEntries = await vscode.workspace.fs.readDirectory(root);
    for (const [name, type] of rootEntries) {
        if (KEEP_DIRS.has(name) || name.startsWith('.')) {
            continue;
        }
        if (type === vscode.FileType.Directory) {
            // неизвестная папка → other
            await moveFile(vscode.Uri.joinPath(root, name), otherDir, 'other', name, moved, skipped);
            continue;
        }
        if (HTML_EXT.has(extOf(name))) {
            continue; // HTML уже обработан
        }
        items.push({ name, uri: vscode.Uri.joinPath(root, name), source: 'root' });
    }

    if (await exists(otherDir)) {
        const otherEntries = await vscode.workspace.fs.readDirectory(otherDir);
        for (const [name, type] of otherEntries) {
            if (type !== vscode.FileType.File) {
                continue;
            }
            if (HTML_EXT.has(extOf(name))) {
                continue; // лишние html остаются в other
            }
            const bucket = classifyFile(name);
            if (bucket === 'other') {
                continue; // уже на месте
            }
            items.push({ name, uri: vscode.Uri.joinPath(otherDir, name), source: 'other' });
        }
    }

    for (const item of items) {
        if (!(await exists(item.uri))) {
            continue;
        }
        const bucket = classifyFile(item.name);
        if (bucket === 'html') {
            continue;
        }
        if (bucket === 'other') {
            if (item.source === 'root') {
                await moveFile(item.uri, otherDir, 'other', item.name, moved, skipped);
            }
            continue;
        }
        const destDir = bucket === 'images' ? imagesDir : bucket === 'css' ? cssDir : jsDir;
        await moveFile(item.uri, destDir, bucket, item.name, moved, skipped, pathMap);
    }
}

async function rewriteIndexPaths(root: vscode.Uri, pathMap: Map<string, string>): Promise<void> {
    if (pathMap.size === 0) {
        return;
    }
    const indexUri = vscode.Uri.joinPath(root, 'index.html');
    if (!(await exists(indexUri))) {
        return;
    }

    const buf = await vscode.workspace.fs.readFile(indexUri);
    let html = Buffer.from(buf).toString('utf8');
    let changed = false;

    for (const [oldName, newPath] of pathMap) {
        const patterns = [
            new RegExp(`(src|href)\\s*=\\s*(['"])(?:\\./)?${escapeRegExp(oldName)}\\2`, 'gi'),
            new RegExp(`url\\(\\s*(['"]?)(?:\\./)?${escapeRegExp(oldName)}\\1\\s*\\)`, 'gi')
        ];
        for (const re of patterns) {
            html = html.replace(re, (match, g1, g2) => {
                changed = true;
                if (g1 === 'src' || g1 === 'href') {
                    return `${g1}=${g2}${newPath}${g2}`;
                }
                const q = g1 || '';
                return `url(${q}${newPath}${q})`;
            });
        }
    }

    if (changed) {
        await vscode.workspace.fs.writeFile(indexUri, Buffer.from(html, 'utf8'));
    }
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function applyProjectStructure(root: vscode.Uri): Promise<StructureResult> {
    const created: string[] = [];
    const moved: string[] = [];
    const renamed: string[] = [];
    const skipped: string[] = [];
    const pathMap = new Map<string, string>();

    for (const dir of STRUCTURE_DIRS) {
        await ensureDir(root, dir, created);
    }

    // 1) HTML → index.html (ищет и в корне, и в other/)
    await promoteMainHtml(root, moved, renamed, skipped, created);

    // 2) Картинки/css/js из корня и other/
    await redistributeAssets(root, moved, skipped, pathMap);

    // 3) Заготовки, если нет
    await ensureFile(root, 'css/style.css', STYLE_CSS_TEMPLATE, created);
    await ensureFile(root, 'js/main.js', MAIN_JS_TEMPLATE, created);

    // 4) Пути в index.html
    await rewriteIndexPaths(root, pathMap);

    return { created, moved, renamed, skipped };
}

function resolveTargetRoot(): vscode.Uri | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const wf = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (wf) {
            return wf.uri;
        }
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri;
}

export async function initProjectStructureCommand(): Promise<void> {
    const root = resolveTargetRoot();
    if (!root) {
        vscode.window.showErrorMessage('Adway: откройте папку проекта (File → Open Folder)');
        return;
    }

    const folderName = path.basename(root.fsPath);
    const confirm = await vscode.window.showWarningMessage(
        `Adway: привести «${folderName}» к структуре?\n\n` +
            `• основной HTML → index.html (в т.ч. из other/)\n` +
            `• картинки → images/\n` +
            `• стили → css/\n` +
            `• скрипты → js/\n` +
            `• остальное → other/\n\n` +
            `Закройте открытые файлы лендинга перед продолжением.`,
        { modal: true },
        'Создать структуру'
    );

    if (confirm !== 'Создать структуру') {
        return;
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Adway: создаём структуру…',
            cancellable: false
        },
        async () => {
            try {
                // Сохранить всё, чтобы снять блокировки Windows
                await vscode.workspace.saveAll(false);

                const result = await applyProjectStructure(root);

                const lines: string[] = [];
                if (result.renamed.length) {
                    lines.push(`Переименовано:\n  ${result.renamed.join('\n  ')}`);
                }
                if (result.moved.length) {
                    lines.push(`Перенесено (${result.moved.length}):\n  ${result.moved.slice(0, 15).join('\n  ')}${result.moved.length > 15 ? `\n  … +${result.moved.length - 15}` : ''}`);
                }
                if (result.created.length) {
                    lines.push(`Создано: ${result.created.join(', ')}`);
                }
                if (result.skipped.length) {
                    lines.push(`Пропущено:\n  ${result.skipped.join('\n  ')}`);
                }

                if (result.skipped.length) {
                    vscode.window.showWarningMessage(
                        `Adway: готово с ошибками (перенесено ${result.moved.length}, пропущено ${result.skipped.length}). См. детали.`,
                        'Детали'
                    ).then(choice => {
                        if (choice === 'Детали') {
                            const doc = lines.join('\n\n') || 'Нет деталей';
                            vscode.workspace.openTextDocument({ content: doc, language: 'markdown' }).then(d => {
                                void vscode.window.showTextDocument(d, { preview: true });
                            });
                        }
                    });
                } else {
                    vscode.window.showInformationMessage(
                        `Adway: структура готова (переименовано ${result.renamed.length}, перенесено ${result.moved.length})`
                    );
                }

                const indexUri = vscode.Uri.joinPath(root, 'index.html');
                if (await exists(indexUri)) {
                    const doc = await vscode.workspace.openTextDocument(indexUri);
                    await vscode.window.showTextDocument(doc);
                }
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                vscode.window.showErrorMessage(`Adway: не удалось создать структуру — ${msg}`);
            }
        }
    );
}
