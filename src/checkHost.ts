import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    CheckResult,
    CheckerOptions,
    DEFAULT_LINK_WHITELIST
} from './checkTypes';
import { getSheetsDirectory, readSheetsConfig } from './sheets';

const WORKER_PATH = path.join(__dirname, 'checkWorker.js');
const WORKER_TIMEOUT_MS = 45_000;

type WorkerResponse = { ok: true; results: CheckResult[] } | { ok: false; error: string };

let cachedNodePath: string | undefined;

/**
 * Системный node, не process.execPath (Cursor/Electron).
 * Spawn Electron как Node при F5-отладке часто вешает Extension Host.
 */
function resolveNodeBinary(): string {
    if (cachedNodePath) {
        return cachedNodePath;
    }

    const candidates: string[] = [];
    if (process.env.ADWAY_NODE) {
        candidates.push(process.env.ADWAY_NODE);
    }
    if (process.env.NODE_BINARY) {
        candidates.push(process.env.NODE_BINARY);
    }

    try {
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        const out = execFileSync(cmd, ['node'], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 3000
        });
        for (const line of out.split(/\r?\n/)) {
            const p = line.trim();
            if (p) {
                candidates.push(p);
            }
        }
    } catch {
        /* PATH без node */
    }

    if (process.platform === 'win32') {
        candidates.push('C:\\Program Files\\nodejs\\node.exe');
        candidates.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'));
    } else {
        candidates.push('/usr/local/bin/node', '/usr/bin/node');
    }

    for (const c of candidates) {
        try {
            if (c && fs.existsSync(c) && !/electron|cursor|code\.exe/i.test(c)) {
                cachedNodePath = c;
                return c;
            }
        } catch {
            /* next */
        }
    }

    // последний шанс — Electron as Node (хуже при F5)
    cachedNodePath = process.execPath;
    return cachedNodePath;
}

/**
 * jsdom в Extension Host (Electron) после F5 валит процесс.
 * Проверка идёт в отдельном Node-процессе: падение worker не закрывает окно.
 */
export async function runLandingCheckIsolated(
    html: string,
    options: CheckerOptions
): Promise<CheckResult[]> {
    const payload = JSON.stringify({
        html,
        options: {
            whitelist: options.whitelist,
            sidCountryMap: options.sidCountryMap,
            baseUrl: options.baseUrl,
            htmlDir: options.htmlDir,
            checkLocalPaths: options.checkLocalPaths,
            warnPictureSource: options.warnPictureSource,
            checkUnusedScripts: options.checkUnusedScripts
        }
    });

    const nodeBin = resolveNodeBinary();
    const useElectronAsNode = /electron|cursor|code/i.test(nodeBin) || nodeBin === process.execPath;

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            fn();
        };

        const env: NodeJS.ProcessEnv = { ...process.env };
        delete env.VSCODE_INSPECTOR_OPTIONS;
        delete env.NODE_OPTIONS;
        delete env.ELECTRON_RUN_AS_NODE;
        if (useElectronAsNode) {
            env.ELECTRON_RUN_AS_NODE = '1';
        }

        const child = spawn(nodeBin, [WORKER_PATH], {
            cwd: path.join(__dirname, '..'),
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            // не цеплять к дереву отладчика Extension Host
            detached: false
        });

        const timer = setTimeout(() => {
            finish(() => {
                try {
                    child.kill();
                } catch {
                    /* ignore */
                }
                reject(new Error(`проверка зависла (${WORKER_TIMEOUT_MS} мс)`));
            });
        }, WORKER_TIMEOUT_MS);

        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });

        child.on('error', (err: Error) => {
            finish(() => reject(err));
        });

        child.on('close', (code, signal) => {
            finish(() => {
                if (stderr.trim()) {
                    console.error('Adway check worker:', stderr.trim());
                }
                if (!stdout.trim()) {
                    reject(
                        new Error(
                            stderr.trim() ||
                                `check worker завершился (${signal || code || 'unknown'})`
                        )
                    );
                    return;
                }
                try {
                    const msg = JSON.parse(stdout) as WorkerResponse;
                    if (msg && msg.ok) {
                        resolve(msg.results);
                        return;
                    }
                    reject(new Error(msg?.error || 'worker вернул ошибку'));
                } catch {
                    reject(new Error(stderr.trim() || `некорректный ответ worker (код ${code})`));
                }
            });
        });

        child.stdin.on('error', (err: Error) => {
            finish(() => reject(err));
        });
        child.stdin.end(payload, 'utf8');
    });
}

/** Обёртка для VS Code TextDocument — jsdom в child process, без save(). */
export class LandingChecker {
    private htmlContent: string;
    private options: CheckerOptions;

    constructor(document: vscode.TextDocument, options?: CheckerOptions) {
        this.htmlContent = document.getText();
        const config = vscode.workspace.getConfiguration('adway');
        const whitelist = config.get<string[]>('linkWhitelist', DEFAULT_LINK_WHITELIST);
        const htmlDir =
            document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : undefined;
        this.options = {
            whitelist,
            baseUrl: 'http://localhost/',
            htmlDir,
            checkLocalPaths: config.get<boolean>('checkLocalPaths', true),
            warnPictureSource: config.get<boolean>('cleanup.removePictureSource', true),
            checkUnusedScripts: config.get<boolean>('checkUnusedScripts', true),
            ...options
        };
    }

    async check(): Promise<CheckResult[]> {
        const options: CheckerOptions = { ...this.options };
        delete options.validateSidCountry;
        delete options.fetchResource;

        const sheets = readSheetsConfig();
        if (sheets.enabled) {
            try {
                const dir = getSheetsDirectory();
                if (dir) {
                    options.sidCountryMap = await dir.getMapping();
                }
            } catch (e: unknown) {
                console.error('Adway Checker: не удалось загрузить Sheets', e);
            }
        }

        try {
            return await runLandingCheckIsolated(this.htmlContent, options);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return [
                {
                    success: false,
                    text: `❌ Ошибка при разборе HTML: ${msg}`
                }
            ];
        }
    }
}
