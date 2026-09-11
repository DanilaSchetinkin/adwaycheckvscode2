/**
 * Smoke-тесты логики чекера и Quick Fix (без Extension Host).
 * Запуск: node test/smoke.js
 */
const Module = require('module');
const path = require('path');
const assert = require('assert');

// Минимальный mock vscode до загрузки наших модулей
const vscodeMock = {
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    CodeActionKind: { QuickFix: { value: 'quickfix' } },
    workspace: {
        getConfiguration: () => ({
            get: (_key, defaultValue) => defaultValue
        })
    },
    Uri: {
        file: (p) => ({ fsPath: p, scheme: 'file', toString: () => 'file://' + p }),
        parse: (s) => ({ toString: () => s, scheme: 'file' })
    },
    Position: class {
        constructor(line, character) {
            this.line = line;
            this.character = character;
        }
    },
    Range: class {
        constructor(a, b) {
            this.start = a;
            this.end = b;
        }
    },
    WorkspaceEdit: class {
        constructor() {
            this._inserts = [];
            this._replaces = [];
            this._deletes = [];
        }
        insert(uri, position, text) {
            this._inserts.push({ uri, position, text });
        }
        replace(uri, range, text) {
            this._replaces.push({ uri, range, text });
        }
        delete(uri, range) {
            this._deletes.push({ uri, range });
        }
    },
    CodeAction: class {
        constructor(title, kind) {
            this.title = title;
            this.kind = kind;
        }
    }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return vscodeMock;
    }
    return originalLoad.apply(this, arguments);
};

const { runLandingCheck } = require('../out/checker');
const { buildFixEdit, fixOrderFormHtml } = require('../out/codeActions');
const { JQUERY_SNIPPET } = require('../out/snippetTexts');

function hasError(results, substr) {
    return results.some(r => r.success === false && r.text.includes(substr));
}

function hasOk(results, substr) {
    return results.some(r => r.success === true && r.text.includes(substr));
}

/** Применяет mock WorkspaceEdit к строке HTML */
function applyEdit(html, edit) {
    if (!edit) {
        return html;
    }
    // Для простоты: только inserts по offset, вычисленному из Position через разбивку строк
    const lines = html.split('\n');
    const ops = [...(edit._inserts || [])].sort((a, b) => {
        if (a.position.line !== b.position.line) {
            return b.position.line - a.position.line;
        }
        return b.position.character - a.position.character;
    });
    for (const op of ops) {
        const line = lines[op.position.line] ?? '';
        const ch = Math.min(op.position.character, line.length);
        lines[op.position.line] = line.slice(0, ch) + op.text + line.slice(ch);
    }
    for (const op of edit._replaces || []) {
        // full-doc replace
        if (op.range.start.line === 0 && op.range.start.character === 0) {
            return op.text;
        }
        const startLine = op.range.start.line;
        const endLine = op.range.end.line;
        if (startLine === endLine) {
            const line = lines[startLine];
            lines[startLine] =
                line.slice(0, op.range.start.character) +
                op.text +
                line.slice(op.range.end.character);
        }
    }
    for (const op of [...(edit._deletes || [])].reverse()) {
        const startLine = op.range.start.line;
        const endLine = op.range.end.line;
        if (startLine === endLine) {
            const line = lines[startLine];
            lines[startLine] =
                line.slice(0, op.range.start.character) + line.slice(op.range.end.character);
        }
    }
    return lines.join('\n');
}

const MINIMAL_HEAD = `<!DOCTYPE html>
<html>
<head>
<title>t</title>
</head>
<body>
</body>
</html>`;

const WITH_JQUERY = `<!DOCTYPE html>
<html>
<head>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js" referrerpolicy="no-referrer"></script>
<title>t</title>
</head>
<body>
</body>
</html>`;

const WITH_ORDER_FORM = `<!DOCTYPE html>
<html>
<head>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js" referrerpolicy="no-referrer"></script>
</head>
<body>
<form action="/order.php" method="post" id="oneform">
  <input type="hidden" name="fbpx" value="{fbpx}">
  <input type="hidden" name="utm_code" value="{subid}">
  <input type="hidden" name="cid" value="{campaign_id}">
  <input type="hidden" name="sid" value="123">
  <input type="hidden" name="hash" value="{hash}">
  <input type="hidden" name="country" value="HU">
  <input name="name" required>
  <input name="phone" required>
</form>
<script>
  const LAZY = document.querySelectorAll('img');
  for (let i = 0; i < LAZY.length; i++) {
    LAZY[i].setAttribute('loading', 'lazy');
  }
</script>
<script>
  $("a").on("touchend, click", function (e) {
    e.preventDefault();
    $('body,html').animate({ scrollTop: $('#oneform').offset().top }, 400);
  });
</script>
<script>
  $('[name="name"]').on("input", function () {
    var val = $(this).val();
    var cleaned = val.replace(/[^\\p{L}\\s]/gu, "");
    $(this).val(cleaned);
  });
  $('[name="phone"]').on("input change", function (e) {
    var val = $(this).val();
    $(this).val(val.replace(/\\D/g, ""));
    $(e.currentTarget).attr("pattern", "[0-9]{6,}");
  });
</script>
<a href="#">x</a>
</body>
</html>`;

const EMPTY_FORM_ONLY = `<!DOCTYPE html>
<html>
<head></head>
<body>
<form></form>
</body>
</html>`;

const CC_OFFER = `<!DOCTYPE html>
<html>
<head>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js"></script>
</head>
<body>
<a href="{offer}" id="getOrder">Buy</a>
<div id="oneform"></div>
<script>
  const LAZY = document.querySelectorAll('img');
  for (let i = 0; i < LAZY.length; i++) {
    LAZY[i].setAttribute('loading', 'lazy');
  }
</script>
<script>
  $("a").not("#getOrder").on("touchend, click", function (e) {
    e.preventDefault();
    $('body,html').animate({ scrollTop: $('#oneform').offset().top }, 400);
  });
</script>
</body>
</html>`;

async function main() {
    let failed = 0;
    const check = async (name, fn) => {
        try {
            await fn();
            console.log(`  OK  ${name}`);
        } catch (e) {
            failed++;
            console.error(`  FAIL ${name}`);
            console.error('      ', e.message || e);
        }
    };

    console.log('1) Checker: нет jQuery');
    await check('ошибка jQuery на минимальном HTML', async () => {
        const results = await runLandingCheck(MINIMAL_HEAD);
        assert.ok(hasError(results, 'jQuery'), 'ожидалась ошибка jQuery');
    });

    console.log('2) Checker: нет формы заказа');
    await check('ошибка «Формы не найдены» без form', async () => {
        const results = await runLandingCheck(WITH_JQUERY);
        assert.ok(hasError(results, 'Формы не найден'), 'ожидалась ошибка про формы');
    });

    await check('ошибка при пустой <form></form>', async () => {
        const results = await runLandingCheck(EMPTY_FORM_ONLY);
        assert.ok(
            hasError(results, 'Форма заказа не найден') || hasError(results, 'Формы не найден'),
            'ожидалась ошибка про форму заказа'
        );
    });

    console.log('3) Checker: обычный оффер с формой');
    await check('есть форма и 6 hidden', async () => {
        const results = await runLandingCheck(WITH_ORDER_FORM);
        assert.ok(hasOk(results, 'jQuery'), 'jQuery должен быть OK');
        assert.ok(hasOk(results, '6 скрытых'), '6 hidden должны быть OK');
        assert.ok(!hasError(results, 'Формы не найден'), 'не должно быть ошибки про отсутствие форм');
        assert.ok(!hasError(results, 'Форма заказа не найден'), 'не должно быть ошибки про форму заказа');
    });

    console.log('4) Checker: CC оффер');
    await check('CC без формы — не требует order form', async () => {
        const results = await runLandingCheck(CC_OFFER);
        assert.ok(!hasError(results, 'Формы не найден'), 'CC не требует формы');
        assert.ok(hasOk(results, '{offer}') || hasOk(results, 'Ссылка href'), 'должен найти {offer}');
    });

    console.log('5) Quick Fix: вставка jQuery');
    await check('buildFixEdit(jquery) вставляет в <head>', async () => {
        const doc = {
            uri: vscodeMock.Uri.file('/tmp/test.html'),
            getText: () => MINIMAL_HEAD,
            lineCount: MINIMAL_HEAD.split('\n').length,
            lineAt: (i) => {
                const lines = MINIMAL_HEAD.split('\n');
                return { text: lines[i] || '', range: { start: { line: i, character: 0 }, end: { line: i, character: (lines[i] || '').length } } };
            },
            positionAt: (offset) => {
                const before = MINIMAL_HEAD.slice(0, offset);
                const lines = before.split('\n');
                return {
                    line: lines.length - 1,
                    character: lines[lines.length - 1].length
                };
            }
        };

        const edit = buildFixEdit(doc, 'jquery', 0);
        assert.ok(edit, 'edit должен быть создан');
        assert.ok(edit._inserts && edit._inserts.length > 0, 'должен быть insert');

        const next = applyEdit(MINIMAL_HEAD, edit);
        assert.ok(next.includes(JQUERY_SNIPPET) || next.includes('jquery/3.6.0'), 'в HTML должен появиться jQuery');
        assert.ok(/<head[^>]*>[\s\S]*jquery[\s\S]*<\/head>/i.test(next), 'jQuery должен быть внутри <head>');

        const resultsAfter = await runLandingCheck(next);
        assert.ok(hasOk(resultsAfter, 'jQuery'), 'после фикса ошибка jQuery должна уйти');
        assert.ok(!hasError(resultsAfter, 'jQuery'), 'не должно остаться ошибки jQuery');
    });

    console.log('6) Quick Fix: вставка формы');
    await check('buildFixEdit(form) + повторная проверка', async () => {
        const html = WITH_JQUERY;
        const doc = {
            uri: vscodeMock.Uri.file('/tmp/test2.html'),
            getText: () => html,
            lineCount: html.split('\n').length,
            lineAt: (i) => {
                const lines = html.split('\n');
                return { text: lines[i] || '', range: { start: { line: i, character: 0 }, end: { line: i, character: (lines[i] || '').length } } };
            },
            positionAt: (offset) => {
                const before = html.slice(0, offset);
                const lines = before.split('\n');
                return { line: lines.length - 1, character: lines[lines.length - 1].length };
            }
        };
        const edit = buildFixEdit(doc, 'form', 0);
        assert.ok(edit, 'edit формы должен быть');
        const next = applyEdit(html, edit);
        assert.ok(next.includes('action="/order.php"'), 'должна появиться форма');
        const resultsAfter = await runLandingCheck(next);
        assert.ok(!hasError(resultsAfter, 'Формы не найден'), 'ошибка отсутствия форм должна уйти');
        assert.ok(!hasError(resultsAfter, 'Форма заказа не найден'), 'ошибка формы заказа должна уйти');
    });

    console.log('7) Hidden: сразу после <form>, не перед </form>');
    await check('fixOrderFormHtml вставляет hidden под открывающий тег', async () => {
        const form = `<form action="/order.php" method="post">
  <input name="name" required>
  <input name="phone" required>
</form>`;
        const { html: next, changed } = fixOrderFormHtml(form);
        assert.ok(changed, 'форма должна измениться');
        const inner = next.match(/<form\b[^>]*>([\s\S]*)<\/form>/i)[1];
        const hiddenIdx = inner.indexOf('type="hidden"');
        const nameIdx = inner.indexOf('name="name"');
        assert.ok(hiddenIdx >= 0, 'должны появиться hidden');
        assert.ok(hiddenIdx < nameIdx, 'hidden должны быть до полей name/phone, сразу после <form>');
        assert.ok(!/required>[\s\S]*type="hidden"[\s\S]*<\/form>/i.test(next) || hiddenIdx < nameIdx, 'hidden не в конце формы');
    });

    await check('buildFixEdit(hidden) вставляет после <form>', async () => {
        const html = `<!DOCTYPE html>
<html>
<body>
<form action="/order.php" method="post">
  <input name="name" required>
  <input name="phone" required>
</form>
</body>
</html>`;
        const lines = html.split('\n');
        const doc = {
            uri: vscodeMock.Uri.file('/tmp/hidden.html'),
            getText: () => html,
            lineCount: lines.length,
            lineAt: (i) => ({
                text: lines[i] || '',
                range: {
                    start: { line: i, character: 0 },
                    end: { line: i, character: (lines[i] || '').length }
                }
            }),
            positionAt: (offset) => {
                const before = html.slice(0, offset);
                const parts = before.split('\n');
                return { line: parts.length - 1, character: parts[parts.length - 1].length };
            },
            offsetAt: (pos) => {
                let off = 0;
                for (let i = 0; i < pos.line; i++) {
                    off += (lines[i] || '').length + 1;
                }
                return off + pos.character;
            }
        };
        const edit = buildFixEdit(doc, 'hidden', 3);
        assert.ok(edit, 'edit hidden должен быть');
        const next = applyEdit(html, edit);
        const inner = next.match(/<form\b[^>]*>([\s\S]*)<\/form>/i)[1];
        const hiddenIdx = inner.indexOf('type="hidden"');
        const nameIdx = inner.indexOf('name="name"');
        assert.ok(hiddenIdx >= 0 && hiddenIdx < nameIdx, 'hidden сразу после <form>, до name');
    });

    console.log('8) Checker: битый HTML не должен бросать');
    await check('jsdom переживает сломанную разметку', async () => {
        const messy = `<!DOCTYPE html><html><head></head><body>
<form><input name="name"><div><span><p>unclosed
<style>body{background:url(https://evil.example/x.png)}</style>
<script>const u = "https://cdn.example/a.js"; /* https://skip.me/x */</script>
<img src="https://img.example/a.jpg">
<a href="https://x.com">x</a>
</body>`;
        const results = await runLandingCheck(messy);
        assert.ok(Array.isArray(results) && results.length > 0, 'должны быть результаты');
        assert.ok(!results.some(r => String(r.text).includes('Ошибка при разборе HTML')), 'разбор не должен падать');
    });

    console.log('');
    if (failed > 0) {
        console.error(`Итого: ${failed} провал(ов)`);
        process.exit(1);
    }
    console.log('Итого: все проверки прошли');
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
