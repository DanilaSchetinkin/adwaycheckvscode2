const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'vscode') {
        return 'vscode-mock';
    }
    return orig.call(this, request, parent, isMain, options);
};
require.cache['vscode-mock'] = {
    id: 'vscode-mock',
    filename: 'vscode-mock',
    loaded: true,
    exports: {
        workspace: {
            getConfiguration: () => ({
                get: (_k, d) => d
            })
        }
    }
};

const { detectPlayerByRules } = require('../out/ai/aiPlayer');

const samples = {
    nestedHermes: `<!DOCTYPE html><html><body>
<section class="other"><h1>Hi</h1></section>
<section class="section-video">
  <div class="embedpvideo" data-hermes-video>
    <div class="lv-wrapper"><div class="lv-overlay"></div><video></video></div>
  </div>
</section>
<form></form>
</body></html>`,
    deepNest: `<div><section id="s">
  <div class="wrap"><div class="embedpvideo" data-hermes-video>
    <div><div><span>x</span></div></div>
  </div></div>
</section></div>`,
    vjs: `<section class="hero"><div class="video-js vjs-default" id="video"><video></video></div></section>`,
    noPlayer: `<section><p>no video here</p></section>`,
    earlyClose: `<section class="section-video"><div class="embedpvideo"><div class="a"><div class="b">inner</div></div></div><p>after player still in section</p></section>`
};

let failed = false;
for (const [name, html] of Object.entries(samples)) {
    const r = detectPlayerByRules(html);
    console.log('---', name);
    if (!r) {
        console.log('NULL');
        if (name !== 'noPlayer') {
            failed = true;
            console.log('FAIL: expected match');
        }
        continue;
    }
    if (name === 'noPlayer') {
        failed = true;
        console.log('FAIL: should be null, got', r.reason);
        continue;
    }
    console.log('reason:', r.reason);
    console.log('wrap:', r.wrapTag, 'expanded:', r.expanded, 'len:', r.snippet.length);
    console.log('starts:', r.snippet.slice(0, 70).replace(/\n/g, ' '));
    console.log('ends:', r.snippet.slice(-50).replace(/\n/g, ' '));
    const full =
        /^<section/i.test(r.snippet.trim()) && /<\/section>\s*$/i.test(r.snippet.trim());
    console.log('isFullSection:', full);
    if (name === 'vjs' && !full) {
        failed = true;
        console.log('FAIL: vjs should expand to full section');
    }
    if (name === 'earlyClose' && !/after player still in section/.test(r.snippet)) {
        failed = true;
        console.log('FAIL: truncated section');
    }
    if ((name === 'nestedHermes' || name === 'deepNest' || name === 'earlyClose') && !full) {
        failed = true;
        console.log('FAIL: expected full section');
    }
}
process.exit(failed ? 1 : 0);
