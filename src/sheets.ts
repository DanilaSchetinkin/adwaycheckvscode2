import * as vscode from 'vscode';

const CACHE_KEY = 'adway.sidCountryMapping';
const LETTER_RE = /^[A-Z]+$/;

export interface SheetsConfig {
    sheetUrl: string;
    cacheTtlMs: number;
    requestTimeoutMs: number;
    sidColumn: string;
    countryColumn: string;
    enabled: boolean;
}

export interface SidCountryCache {
    mapping: Record<string, string>;
    timestamp: number;
    sheetUrl: string;
}

export const DEFAULT_SHEETS_URL =
    'https://docs.google.com/spreadsheets/d/1c0SNeKpeZF4osjHEd2_x5EnVSV3eA_mTXOypwMWQSFY/export?format=csv&gid=1768774196';

/**
 * Принимает и edit-ссылку, и export CSV — приводит к export?format=csv&gid=...
 */
export function toCsvExportUrl(url: string): string {
    const trimmed = url.trim();
    if (!trimmed) {
        return trimmed;
    }
    if (/\/export\?/.test(trimmed) && /format=csv/.test(trimmed)) {
        return trimmed;
    }

    const idMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!idMatch) {
        return trimmed;
    }

    const gidMatch = trimmed.match(/[?&#]gid=(\d+)/);
    const gid = gidMatch ? gidMatch[1] : '0';
    return `https://docs.google.com/spreadsheets/d/${idMatch[1]}/export?format=csv&gid=${gid}`;
}

export function readSheetsConfig(): SheetsConfig {
    const config = vscode.workspace.getConfiguration('adway');
    return {
        enabled: config.get<boolean>('sheetsEnabled', true),
        sheetUrl: toCsvExportUrl(config.get<string>('sheetsUrl', DEFAULT_SHEETS_URL)),
        cacheTtlMs: config.get<number>('sheetsCacheTtlMs', 60000),
        requestTimeoutMs: config.get<number>('sheetsTimeoutMs', 8000),
        sidColumn: (config.get<string>('sheetsSidColumn', 'C') || 'C').trim().toUpperCase(),
        countryColumn: (config.get<string>('sheetsCountryColumn', 'B') || 'B').trim().toUpperCase()
    };
}

export class SheetsDirectory {
    private mapping: Record<string, string> | null = null;
    private lastLoadedAt = 0;
    private lastSheetUrl = '';
    private inflight: Promise<void> | null = null;

    constructor(private readonly globalState: vscode.Memento) {}

    async validatePair(sid: string, country: string): Promise<{
        valid: boolean;
        reason?: string;
        expectedCountry?: string;
    }> {
        if (!sid || !country) {
            return { valid: false, reason: 'sid или country отсутствуют' };
        }

        const mapping = await this.getMapping();
        const expectedCountry = mapping[sid];
        if (!expectedCountry) {
            return { valid: false, reason: 'sid отсутствует в таблице' };
        }
        if (expectedCountry.toUpperCase() !== country.toUpperCase()) {
            return {
                valid: false,
                reason: `country должно быть ${expectedCountry}`,
                expectedCountry
            };
        }
        return { valid: true };
    }

    async getMapping(): Promise<Record<string, string>> {
        await this.ensureLoaded();
        return this.mapping || {};
    }

    async refresh(): Promise<number> {
        await this.refreshFromSheet();
        return Object.keys(this.mapping || {}).length;
    }

    getLastLoadedAt(): number {
        return this.lastLoadedAt;
    }

    private async ensureLoaded(): Promise<void> {
        const config = readSheetsConfig();

        if (this.mapping && this.lastSheetUrl === config.sheetUrl &&
            Date.now() - this.lastLoadedAt < config.cacheTtlMs) {
            return;
        }

        if (!this.mapping || this.lastSheetUrl !== config.sheetUrl) {
            const cached = this.readCache();
            if (
                cached &&
                cached.sheetUrl === config.sheetUrl &&
                Date.now() - cached.timestamp < config.cacheTtlMs
            ) {
                this.mapping = cached.mapping;
                this.lastLoadedAt = cached.timestamp;
                this.lastSheetUrl = cached.sheetUrl;
                return;
            }
        }

        if (this.inflight) {
            await this.inflight;
            return;
        }

        this.inflight = this.refreshFromSheet().finally(() => {
            this.inflight = null;
        });
        await this.inflight;
    }

    private async refreshFromSheet(): Promise<void> {
        const config = readSheetsConfig();
        if (!config.sheetUrl) {
            throw new Error('URL таблицы Google Sheets не задан (adway.sheetsUrl)');
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

        let text: string;
        try {
            const response = await fetch(config.sheetUrl, {
                signal: controller.signal,
                cache: 'no-store'
            });
            if (!response.ok) {
                throw new Error(`Sheets responded with status ${response.status}`);
            }
            text = await response.text();
        } catch (e: unknown) {
            if (e instanceof Error && e.name === 'AbortError') {
                throw new Error(`Таймаут загрузки Sheets (${config.requestTimeoutMs} мс)`);
            }
            throw e;
        } finally {
            clearTimeout(timeout);
        }

        // Google иногда отдаёт HTML login page вместо CSV
        if (/^\s*<(!DOCTYPE|html)/i.test(text)) {
            throw new Error(
                'Google вернул HTML вместо CSV. Таблица должна быть доступна по ссылке (export?format=csv), без обязательного логина'
            );
        }

        const mapping = this.parseCsv(text, config.sidColumn, config.countryColumn);
        this.mapping = mapping;
        this.lastLoadedAt = Date.now();
        this.lastSheetUrl = config.sheetUrl;

        const cache: SidCountryCache = {
            mapping,
            timestamp: this.lastLoadedAt,
            sheetUrl: config.sheetUrl
        };
        await this.globalState.update(CACHE_KEY, cache);
    }

    private readCache(): SidCountryCache | undefined {
        return this.globalState.get<SidCountryCache>(CACHE_KEY);
    }

    parseCsv(csvText: string, sidColumn: string, countryColumn: string): Record<string, string> {
        const lines = csvText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (!lines.length) {
            throw new Error('Sheets data is empty');
        }

        const parseCsvLine = (line: string): string[] => {
            const fields: string[] = [];
            let currentField = '';
            let insideQuotes = false;

            for (let i = 0; i < line.length; i++) {
                const char = line[i];
                const nextChar = line[i + 1];

                if (char === '"') {
                    if (insideQuotes && nextChar === '"') {
                        currentField += '"';
                        i++;
                    } else {
                        insideQuotes = !insideQuotes;
                    }
                } else if (char === ',' && !insideQuotes) {
                    fields.push(currentField.trim());
                    currentField = '';
                } else {
                    currentField += char;
                }
            }

            fields.push(currentField.trim());
            return fields;
        };

        const rows = lines.map((line) =>
            parseCsvLine(line).map((value) => {
                if (value.startsWith('"') && value.endsWith('"')) {
                    return value.slice(1, -1).replace(/""/g, '"').trim();
                }
                return value.trim();
            })
        );

        let headerRow = rows[0].map((value) => value.toLowerCase());
        const hasHeader = headerRow.includes('sid') || headerRow.includes('country');
        if (!hasHeader) {
            headerRow = [];
        } else {
            rows.shift();
        }

        let sidIndex = headerRow.indexOf('sid');
        let countryIndex = headerRow.indexOf('country');
        if (sidIndex === -1 && sidColumn) {
            sidIndex = columnLetterToIndex(sidColumn);
        }
        if (countryIndex === -1 && countryColumn) {
            countryIndex = columnLetterToIndex(countryColumn);
        }

        if (sidIndex === -1 || countryIndex === -1) {
            throw new Error('CSV must contain sid and country headers или указанные колонки');
        }

        const map: Record<string, string> = {};
        for (const parts of rows) {
            if (parts.length <= Math.max(sidIndex, countryIndex)) {
                continue;
            }
            const sid = parts[sidIndex];
            const country = parts[countryIndex];
            if (sid && sid.trim()) {
                map[sid.trim()] = (country || '').trim();
            }
        }
        return map;
    }
}

function columnLetterToIndex(letter: string): number {
    if (!letter || !LETTER_RE.test(letter)) {
        throw new Error(`Некорректное имя колонки: ${letter || 'пусто'}`);
    }
    let result = 0;
    for (const char of letter) {
        result = result * 26 + (char.charCodeAt(0) - 64);
    }
    return result - 1;
}

let sheetsDirectory: SheetsDirectory | null = null;

export function initSheets(context: vscode.ExtensionContext): SheetsDirectory {
    sheetsDirectory = new SheetsDirectory(context.globalState);
    return sheetsDirectory;
}

export function getSheetsDirectory(): SheetsDirectory | null {
    return sheetsDirectory;
}

export async function validateSidCountry(
    sid: string,
    country: string
): Promise<{ ok: boolean; error?: string; expectedCountry?: string }> {
    const config = readSheetsConfig();
    if (!config.enabled) {
        return { ok: true };
    }

    const directory = getSheetsDirectory();
    if (!directory) {
        return { ok: false, error: 'Sheets не инициализирован' };
    }

    try {
        const result = await directory.validatePair(sid, country);
        return {
            ok: result.valid,
            error: result.valid ? undefined : result.reason,
            expectedCountry: result.expectedCountry
        };
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
    }
}
