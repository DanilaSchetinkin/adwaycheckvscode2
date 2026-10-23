import { CheckerOptions, CheckResult, runLandingCheck } from './checker';

type Request = {
    html: string;
    options: CheckerOptions;
};

type Response = { ok: true; results: CheckResult[] } | { ok: false; error: string };

function serializableOptions(options: CheckerOptions): CheckerOptions {
    return {
        whitelist: options.whitelist,
        sidCountryMap: options.sidCountryMap,
        baseUrl: options.baseUrl,
        htmlDir: options.htmlDir,
        checkLocalPaths: options.checkLocalPaths,
        warnPictureSource: options.warnPictureSource,
        checkUnusedScripts: options.checkUnusedScripts
    };
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
    const raw = await readStdin();
    const req = JSON.parse(raw) as Request;
    const results = await runLandingCheck(req.html, serializableOptions(req.options || {}));
    const res: Response = { ok: true, results };
    process.stdout.write(JSON.stringify(res));
}

main().catch((e: unknown) => {
    const error = e instanceof Error ? e.message : String(e);
    process.stdout.write(JSON.stringify({ ok: false, error }));
    process.exitCode = 1;
});
