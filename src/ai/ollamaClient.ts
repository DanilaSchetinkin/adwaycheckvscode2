import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import * as vscode from 'vscode';

export type OllamaConfig = {
    enabled: boolean;
    host: string;
    model: string;
    timeoutMs: number;
};

export function getOllamaConfig(): OllamaConfig {
    const cfg = vscode.workspace.getConfiguration('adway');
    return {
        enabled: cfg.get<boolean>('ai.enabled', true),
        host: (cfg.get<string>('ai.host', 'http://127.0.0.1:11434') || 'http://127.0.0.1:11434').replace(
            /\/$/,
            ''
        ),
        model: cfg.get<string>('ai.model', 'qwen2.5-coder:3b') || 'qwen2.5-coder:3b',
        timeoutMs: cfg.get<number>('ai.timeoutMs', 120000) || 120000
    };
}

export async function checkOllamaAvailable(
    config = getOllamaConfig()
): Promise<{ ok: boolean; message: string }> {
    if (!config.enabled) {
        return { ok: false, message: 'AI выключен (adway.ai.enabled = false)' };
    }
    try {
        const data = await httpJson(`${config.host}/api/tags`, 'GET', undefined, 5000);
        const models = (data as { models?: Array<{ name?: string }> })?.models || [];
        const names = models.map(m => m.name || '').filter(Boolean);
        if (names.length === 0) {
            return {
                ok: false,
                message: `Ollama запущена, но моделей нет. Выполните: ollama pull ${config.model}`
            };
        }
        const hasModel = names.some(
            n => n === config.model || n.startsWith(config.model + ':') || n.startsWith(config.model)
        );
        if (!hasModel) {
            return {
                ok: false,
                message: `Модель «${config.model}» не найдена. Есть: ${names.slice(0, 5).join(', ')}. ollama pull ${config.model}`
            };
        }
        return { ok: true, message: `Ollama OK · ${config.model}` };
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
            ok: false,
            message: `Ollama недоступна (${config.host}). Запустите Ollama. ${msg}`
        };
    }
}

export type OllamaMessage = {
    role: 'system' | 'user' | 'assistant';
    content: string;
};

export type OllamaChatOptions = {
    /** Принудительный JSON (для команд с парсингом). */
    formatJson?: boolean;
    temperature?: number;
    numPredict?: number;
};

/**
 * Чат с Ollama (не stream). Возвращает текст ответа ассистента.
 * По умолчанию format=json (совместимо с aiPlayer).
 */
export async function ollamaChat(
    userPrompt: string,
    systemPrompt: string,
    config = getOllamaConfig(),
    options: OllamaChatOptions = {}
): Promise<string> {
    return ollamaChatMessages(
        [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        config,
        { formatJson: true, temperature: 0.1, numPredict: 1024, ...options }
    );
}

/**
 * Многоходовый чат без обязательного JSON (для Adway AI Chat).
 */
export async function ollamaChatMessages(
    messages: OllamaMessage[],
    config = getOllamaConfig(),
    options: OllamaChatOptions = {}
): Promise<string> {
    const body: Record<string, unknown> = {
        model: config.model,
        stream: false,
        options: {
            temperature: options.temperature ?? 0.2,
            num_predict: options.numPredict ?? 2048
        },
        messages
    };
    if (options.formatJson) {
        body.format = 'json';
    }

    const data = await httpJson(
        `${config.host}/api/chat`,
        'POST',
        body,
        config.timeoutMs
    );
    const content = (data as { message?: { content?: string } })?.message?.content;
    if (!content || typeof content !== 'string') {
        throw new Error('Пустой ответ от Ollama');
    }
    return content.trim();
}

function httpJson(
    urlStr: string,
    method: 'GET' | 'POST',
    body?: unknown,
    timeoutMs = 30000
): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let url: URL;
        try {
            url = new URL(urlStr);
        } catch {
            reject(new Error(`Неверный URL: ${urlStr}`));
            return;
        }
        const lib = url.protocol === 'https:' ? https : http;
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
        const req = lib.request(
            {
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method,
                headers: {
                    'Content-Type': 'application/json',
                    ...(payload ? { 'Content-Length': payload.length } : {})
                },
                timeout: timeoutMs
            },
            res => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    if ((res.statusCode || 0) >= 400) {
                        reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(text));
                    } catch {
                        reject(new Error(`Не JSON от Ollama: ${text.slice(0, 200)}`));
                    }
                });
            }
        );
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Таймаут ${timeoutMs} мс`));
        });
        req.on('error', reject);
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}
