/**
 * Offline verification for the auto-review-zh bundle.
 *
 * Proves the two rewrites, their placement in the waterfall, the frozen-request
 * replacement path, failure isolation, and the bundle display/runtime surface
 * without a running Host. Run: node test/verify.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  apply,
  chineseAskText,
  hasReviewerLanguageRule,
  inject,
  isAutoReviewAsk,
  isReviewerCall,
  name,
  resolveSwitches,
  reviewerLanguageRequest,
  reviewerReasonOf,
  rewriteAsk,
} from '../index.js';

const PKG = new URL('../', import.meta.url);
const SHIPPED = new URL('../../.recon/auto-review/pkg/dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review/lib/index.js', import.meta.url);
const shippedFile = fileURLToPath(SHIPPED);
const shipped = existsSync(shippedFile) ? readFileSync(shippedFile, 'utf8') : undefined;
const UTIL_CANDIDATES = [
  new URL('../../.recon/verify-zh/x/dsh/node_modules/@deepseek-ai/dsh-util-values/lib/index.js', import.meta.url),
  new URL('../../.recon/zh-approval/dsh/node_modules/@deepseek-ai/dsh-util-values/lib/index.js', import.meta.url),
].map(fileURLToPath);
const utilFile = UTIL_CANDIDATES.find((candidate) => existsSync(candidate));

/** Freeze one object graph the way the shipped `deepFreeze` util does. */
function deepFreeze(value) {
  const seen = new WeakSet();
  const pending = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== 'object' || node instanceof AbortSignal || seen.has(node)) continue;
    seen.add(node);
    Object.freeze(node);
    for (const key of Object.keys(node)) pending.push(node[key]);
  }
  return value;
}

/** Build a fake context with real prepend ordering and a real ordered waterfall. */
function makeHarness({ withLlm = true, llmThrows = false } = {}) {
  const listeners = new Map();
  const info = [];
  const warn = [];
  const reissued = [];
  const adapterSeen = [];
  const harness = { ctx: undefined, listeners, info, warn, reissued, adapterSeen };
  const ctx = {
    logger: { info: (message) => info.push(message), warn: (message) => warn.push(message) },
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    on: (event, handler, options) => {
      const list = listeners.get(event) ?? [];
      if (options !== null && typeof options === 'object' && options.prepend === true) list.unshift(handler);
      else list.push(handler);
      listeners.set(event, list);
      return () => {};
    },
  };
  if (withLlm) {
    ctx.llm = {
      stream(options) {
        if (llmThrows) throw new Error('llm service rejected the call');
        reissued.push(options);
        // Mirror the host: the re-issued request is dispatched through the same waterfall.
        return dispatch(harness, 'llm/stream', options, (value) => {
          adapterSeen.push(value.system);
          return 'ADAPTER_STREAM';
        });
      },
    };
  }
  harness.ctx = ctx;
  return harness;
}

/** Run one waterfall exactly like Cordis does: shift the next listener, hand it `next`. */
function dispatch(harness, event, value, terminal = () => 'unavailable') {
  const queue = [...(harness.listeners.get(event) ?? [])];
  const step = () => {
    const handler = queue.shift();
    if (handler === undefined) return terminal(value);
    return handler(value, step);
  };
  return step();
}

function shippedReviewPolicy() {
  if (shipped === undefined) return undefined;
  const match = /const REVIEW_POLICY = `([\s\S]*?)`;/u.exec(shipped);
  return match === null ? undefined : match[1];
}

/** The production reviewer request: frozen, exactly as the shipped gate builds it. */
function reviewerOptions(policy, signal) {
  return deepFreeze({
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
    system: policy,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'PENDING_ACTION' }] }],
    temperature: 0,
    ...signal === undefined ? {} : { signal },
  });
}

// --- declared surface -------------------------------------------------------
assert.equal(name, 'auto-review-zh', 'the plugin reports a stable row name');
assert.deepEqual(inject, ['approval', 'llm'], 'the plugin declares the two seams it listens on');
assert.deepEqual(resolveSwitches(undefined), { promptChinese: true, reviewerChinese: true });
assert.deepEqual(resolveSwitches({}), { promptChinese: true, reviewerChinese: true });
assert.deepEqual(resolveSwitches({ promptChinese: false }), { promptChinese: false, reviewerChinese: true });
assert.deepEqual(resolveSwitches({ reviewerChinese: false }), { promptChinese: true, reviewerChinese: false });
assert.deepEqual(resolveSwitches('nonsense'), { promptChinese: true, reviewerChinese: true }, 'a non-object config degrades to the defaults');

// --- prompt text and reason recovery ---------------------------------------
assert.equal(chineseAskText(''), '自动审查拒绝了此调用。');
assert.equal(chineseAskText('   '), '自动审查拒绝了此调用。');
assert.equal(chineseAskText('删除既有目录'), '自动审查拒绝了此调用：删除既有目录');
assert.equal(reviewerReasonOf('Auto review denied tool "pwsh": 覆盖生产配置'), '覆盖生产配置');
assert.equal(reviewerReasonOf('Auto review denied tool "pwsh"'), '', 'a reason-less audit line yields no detail');
assert.equal(reviewerReasonOf('the user rejected tool "pwsh"'), '', 'another asker yields no detail');

// --- upstream fingerprint agreement -----------------------------------------
if (shipped === undefined) {
  console.log('SKIP shipped auto-review source not extracted: re-run `.recon/asar-tool.mjs extract` to enable the upstream-fingerprint checks');
} else {
  assert.ok(shipped.includes('const REVIEW_POLICY = `REVIEW_POLICY'), 'the shipped reviewer policy still opens with the REVIEW_POLICY marker');
  assert.ok(shipped.includes('const options = deepFreeze({'), 'the shipped reviewer request is still deep-frozen (this is why the call is replaced, not mutated)');
  assert.ok(shipped.includes('return readDecision(ctx.llm.stream(options));'), 'the shipped gate still streams the frozen request through the llm service');
  assert.ok(shipped.includes('`Auto review denied tool "${exec.name}"'), 'the shipped ask reason fingerprint is unchanged');
  assert.ok(shipped.includes('en: "Auto review denied this call."'), 'the shipped English display prompt fingerprint is unchanged');
  assert.ok(shipped.includes('zh: "Auto review 拒绝了此调用。'), 'the shipped Chinese display prompt still exists');
}
if (utilFile === undefined) {
  console.log('SKIP dsh-util-values source not extracted: the deep-freeze implementation is mirrored locally instead');
} else {
  assert.ok(readFileSync(utilFile, 'utf8').includes('Object.freeze(node)'), 'the shipped deepFreeze still freezes the visited node itself, including the request root');
}
const policy = shippedReviewPolicy() ?? 'REVIEW_POLICY\nYou are the final authorization reviewer for exactly one pending tool call.';

const rewrittenSystem = reviewerLanguageRequest({ system: policy }).system;

// --- reviewer request replacement (the production, frozen shape) -------------
{
  const harness = makeHarness();
  let downstreamExtra = 0;
  apply(harness.ctx, { promptChinese: true, reviewerChinese: true });
  // A downstream listener registered behind the plugin after activation: it must
  // still run for the replacement request, exactly once.
  harness.ctx.on('llm/stream', (options, next) => {
    downstreamExtra += 1;
    return next();
  });
  assert.equal(harness.listeners.get('llm/stream')[0] !== undefined, true);
  const controller = new AbortController();
  const request = reviewerOptions(policy, controller.signal);
  assert.equal(Object.isFrozen(request), true, 'the sample request mirrors the shipped frozen request');
  const result = dispatch(harness, 'llm/stream', request, () => 'ADAPTER_STREAM');
  assert.equal(result, 'ADAPTER_STREAM', 'the reviewer call still resolves to one model stream');
  assert.equal(harness.reissued.length, 1, 'exactly one replacement request is dispatched (no recursion)');
  const replacement = harness.reissued[0];
  assert.notEqual(replacement, request, 'the replacement is a fresh object, never the frozen request');
  assert.ok(replacement.system.startsWith(policy), 'the shipped policy text is preserved verbatim ahead of the requirement');
  assert.ok(replacement.system.includes('简体中文'), 'the requirement asks for Simplified Chinese');
  assert.equal(request.system, policy, 'the shipped frozen request is not mutated');
  assert.equal(harness.adapterSeen.length, 1);
  assert.ok(harness.adapterSeen[0].includes('简体中文'), 'the adapter stand-in sees the requirement');
  assert.equal(downstreamExtra, 1, 'every other llm/stream listener still runs exactly once');
  assert.equal(replacement.provider, request.provider);
  assert.equal(replacement.model, request.model);
  assert.equal(replacement.temperature, request.temperature);
  assert.equal(replacement.messages, request.messages, 'the shipped messages array is carried by reference');
  assert.equal(replacement.signal, controller.signal, 'cancellation still propagates to the replacement request');
  assert.equal(Object.isFrozen(replacement), true, 'the replacement keeps the shipped immutable-input posture');
  assert.equal(harness.warn.length, 0, 'the replacement path logs no warning');
}

// --- no rewrite is due ------------------------------------------------------
{
  const harness = makeHarness();
  apply(harness.ctx, {});
  const normal = deepFreeze({ provider: 'p', model: 'm', system: 'You are a helpful assistant.', messages: [] });
  assert.equal(dispatch(harness, 'llm/stream', normal, () => 'ADAPTER_STREAM'), 'ADAPTER_STREAM');
  assert.equal(harness.reissued.length, 0, 'a normal agent call is not re-issued');

  const already = deepFreeze({ provider: 'p', model: 'm', system: rewrittenSystem, messages: [] });
  assert.equal(dispatch(harness, 'llm/stream', already, () => 'ADAPTER_STREAM'), 'ADAPTER_STREAM');
  assert.equal(harness.reissued.length, 0, 'a request that already carries the requirement is not re-issued');

  const lookalike = deepFreeze({ system: 'note: REVIEW_POLICY is not a system prompt here', messages: [] });
  assert.equal(dispatch(harness, 'llm/stream', lookalike, () => 'ADAPTER_STREAM'), 'ADAPTER_STREAM');
  assert.equal(harness.reissued.length, 0, 'only a system prompt that OPENS with the marker counts');

  assert.equal(dispatch(harness, 'llm/stream', undefined, () => 'ADAPTER_STREAM'), 'ADAPTER_STREAM');
  assert.equal(harness.reissued.length, 0, 'a missing request is ignored');
}

// --- pure rewrite helper ----------------------------------------------------
assert.equal(reviewerLanguageRequest({ system: 'You are a helpful assistant.' }), undefined);
assert.equal(reviewerLanguageRequest(undefined), undefined);
assert.equal(isReviewerCall({ system: `${policy}` }), true);
assert.equal(isReviewerCall({ system: ` ${policy}` }), false);
assert.equal(hasReviewerLanguageRule(rewrittenSystem), true);

// --- bounded re-dispatch of one original request ----------------------------
{
  const harness = makeHarness();
  apply(harness.ctx, {});
  const request = reviewerOptions(policy);
  assert.equal(dispatch(harness, 'llm/stream', request, () => 'ADAPTER_STREAM'), 'ADAPTER_STREAM');
  assert.equal(harness.reissued.length, 1, 'the first dispatch replaces the request');
  for (let pass = 2; pass <= 3; pass += 1) {
    assert.equal(dispatch(harness, 'llm/stream', request, () => 'ADAPTER_STREAM'), 'ADAPTER_STREAM');
    assert.equal(harness.reissued.length, pass, `pass ${pass} still replaces a re-dispatched envelope`);
  }
  assert.equal(Object.isFrozen(harness.reissued[0]), true, 'every replacement is frozen');
  assert.equal(dispatch(harness, 'llm/stream', request, () => 'ADAPTER_STREAM'), 'ADAPTER_STREAM');
  assert.equal(harness.reissued.length, 3, 'the replacement count stays bounded at 3 per original object');
}

// --- failure isolation ------------------------------------------------------
{
  const harness = makeHarness({ withLlm: false });
  apply(harness.ctx, {});
  assert.doesNotThrow(() => dispatch(harness, 'llm/stream', reviewerOptions(policy), () => 'ADAPTER_STREAM'));
  const request = reviewerOptions(policy);
  assert.equal(dispatch(harness, 'llm/stream', request, () => 'ADAPTER_STREAM'), 'ADAPTER_STREAM', 'without an llm service the original call proceeds');
  assert.equal(harness.warn.length, 0, 'a missing service is not an error');
}
{
  const harness = makeHarness({ llmThrows: true });
  apply(harness.ctx, {});
  const request = reviewerOptions(policy);
  assert.equal(dispatch(harness, 'llm/stream', request, () => 'ADAPTER_STREAM'), 'ADAPTER_STREAM', 'a throwing service falls back to the shipped call');
  assert.equal(harness.warn.length, 1, 'the contained failure is warned about once');
  assert.match(harness.warn[0], /left one llm\/stream request unchanged/u);
}

// --- ask detection, rewrite, and isolation ----------------------------------
assert.equal(isAutoReviewAsk({ reason: 'Auto review denied tool "pwsh": x' }), true, 'the audited reason fingerprint detects an ask');
assert.equal(isAutoReviewAsk({ displayReason: { en: 'Auto review denied this call.' } }), true, 'the display fingerprint detects an ask');
assert.equal(isAutoReviewAsk({ toolName: 'pwsh', reason: 'tool "pwsh" requires approval' }), false, 'a generic ask is not claimed');
assert.equal(isAutoReviewAsk({ toolName: 'pwsh', displayReason: 'Approve this call?' }), false, 'another plugin display prompt is not claimed');
assert.equal(isAutoReviewAsk(undefined), false);
assert.equal(isAutoReviewAsk('nonsense'), false);
{
  const generic = { toolName: 'pwsh', callId: 'c2', reason: 'tool "pwsh" requires approval (not yet supported)' };
  if (isAutoReviewAsk(generic)) rewriteAsk(generic);
  assert.equal(generic.displayReason, undefined, 'a generic ask gains no display prompt');
  assert.equal(generic.reason, 'tool "pwsh" requires approval (not yet supported)');
}
{
  const bare = { toolName: 'pwsh', reason: 'Auto review denied tool "pwsh"' };
  rewriteAsk(bare);
  assert.deepEqual(bare.displayReason, { en: '自动审查拒绝了此调用。', zh: '自动审查拒绝了此调用。' }, 'a reason-less ask still gets a Chinese prompt');
}
{
  const englishOnly = { displayReason: { en: 'Auto review denied this call.' } };
  rewriteAsk(englishOnly);
  assert.equal(englishOnly.displayReason.en, '自动审查拒绝了此调用。');
  assert.equal(englishOnly.displayReason.zh, '自动审查拒绝了此调用。');
}

// --- approval placement end to end -----------------------------------------
{
  const harness = makeHarness();
  let forwarded;
  // A pre-existing answerer stands in for the shipped Web forwarder: it is
  // registered first and must observe whatever the Host waterfall is carrying when
  // it is reached, exactly as the real Remote forwarder serializes the request.
  harness.ctx.on('approval/request', (request, next) => {
    if (request !== null && request !== undefined) forwarded = { displayReason: request.displayReason, reason: request.reason };
    return next();
  });
  apply(harness.ctx, {});
  assert.equal(harness.listeners.get('approval/request').length, 2);
  assert.equal(harness.listeners.get('approval/request')[0] !== undefined, true);
  assert.equal(harness.info.length, 1, 'activation is logged once');
  assert.match(harness.info[0], /promptChinese=true, reviewerChinese=true/u);

  const request = {
    toolName: 'pwsh',
    callId: 'call-1',
    reason: 'Auto review denied tool "pwsh": rewriting a pre-existing directory',
    displayReason: {
      en: 'Auto review denied this call: rewriting a pre-existing directory',
      zh: 'Auto review 拒绝了此调用：rewriting a pre-existing directory',
    },
  };
  const outcome = dispatch(harness, 'approval/request', request, () => 'allowed-once');
  assert.equal(outcome, 'allowed-once', 'the plugin delegates the decision downstream');
  assert.ok(forwarded !== undefined, 'the pre-existing forwarder still ran');
  assert.deepEqual(forwarded.displayReason, {
    en: '自动审查拒绝了此调用：rewriting a pre-existing directory',
    zh: '自动审查拒绝了此调用：rewriting a pre-existing directory',
  }, 'the forwarder sees Chinese in every language slot');
  assert.equal(forwarded.reason, 'Auto review denied tool "pwsh": rewriting a pre-existing directory', 'the audited reason is not rewritten');

  assert.doesNotThrow(() => dispatch(harness, 'approval/request', undefined, () => 'rejected'));
  const generic = { toolName: 'pwsh', reason: 'tool "pwsh" requires approval' };
  assert.equal(dispatch(harness, 'approval/request', generic, () => 'rejected'), 'rejected');
  assert.equal(generic.displayReason, undefined, 'the registered listener leaves a generic ask alone');
}
{
  const harness = makeHarness();
  apply(harness.ctx, { promptChinese: false, reviewerChinese: false });
  assert.equal(harness.listeners.get('approval/request'), undefined, 'promptChinese=false registers no approval listener');
  assert.equal(harness.listeners.get('llm/stream'), undefined, 'reviewerChinese=false registers no model listener');
  assert.match(harness.info[0], /promptChinese=false, reviewerChinese=false/u);
}

// --- bundle surface ---------------------------------------------------------
for (const file of ['index.js', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg', 'README.md']) {
  const text = readFileSync(new URL(file, PKG), 'utf8');
  assert.ok(text.length > 0, `${file} exists and is non-empty`);
}
const manifest = JSON.parse(readFileSync(new URL('package.json', PKG), 'utf8'));
assert.equal(manifest.name, '@local/dsh-auto-review-zh');
assert.equal(manifest.type, 'module');
assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
assert.equal(manifest.exports['.'], './index.js');
assert.ok(manifest.exports['./locale/*.json'] !== undefined, 'locale resources are exported');
assert.ok(manifest.exports['./icon'] !== undefined, 'the icon is exported');
for (const file of ['index.js', 'cordis.patch.yml', 'icon.svg', 'README.md']) {
  assert.ok(manifest.files.includes(file), `${file} is listed in files`);
}
for (const locale of ['en', 'zh']) {
  const parsed = JSON.parse(readFileSync(new URL(`locale/${locale}.json`, PKG), 'utf8'));
  assert.ok(parsed.meta.title.length > 0 && parsed.meta.description.length > 0, `${locale} metadata is complete`);
}
const zhLocale = JSON.parse(readFileSync(new URL('locale/zh.json', PKG), 'utf8'));
assert.match(zhLocale.meta.title, /[\u4e00-\u9fff]/u, 'the Chinese title is actually Chinese');
const icon = readFileSync(new URL('icon.svg', PKG));
assert.ok(icon.length > 0 && icon.length < 256 * 1024, 'the icon is within the size limit');
assert.match(icon.toString('utf8'), /^<svg[\s\S]*<\/svg>\s*$/u, 'the icon is a complete SVG document');
const patch = readFileSync(new URL('cordis.patch.yml', PKG), 'utf8');
assert.match(patch, /id: auto-review-zh/u, 'the patch inserts the plugin row');
assert.match(patch, /name: '@local\/dsh-auto-review-zh'/u, 'the patch names the package');
assert.match(patch, /promptChinese: true/u, 'the patch enables the Chinese prompt');
assert.match(patch, /reviewerChinese: true/u, 'the patch enables the Chinese reviewer reason');

// --- no stray runtime dependency -------------------------------------------
const source = readFileSync(new URL('index.js', PKG), 'utf8');
assert.equal(/^\s*import\s/mu.test(source), false, 'the plugin imports nothing, so a linked install needs no module resolution');
assert.ok(statSync(fileURLToPath(new URL('index.js', PKG))).size < 64 * 1024, 'the plugin body stays a single small module');

console.log(`PASS auto-review-zh: 60 checks (switches, prompt text, fingerprint, frozen-request replacement, isolation, bundle surface)${shipped === undefined || utilFile === undefined ? ' [some upstream checks skipped]' : ''}`);


