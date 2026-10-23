/**
 * Report the experimental Auto review gate in Simplified Chinese.
 *
 * `@deepseek-ai/dsh-experimental-auto-review` reviews every supported tool call
 * before its body runs and, under the `ask` approval policy, hands a denial to
 * the user for exactly one decision. Two surfaces of that prompt carry English:
 *
 *  1. the fixed prompt text is a two-language `displayReason` resolved against
 *     the current UI language, so an English UI shows English; and
 *  2. the optional reviewer `reason` is produced by a model call whose fixed
 *     `REVIEW_POLICY` system prompt is English, so it stays English even in a
 *     Chinese UI.
 *
 * This Host-only plugin closes both surfaces and touches nothing else:
 *
 *  - a prepended `approval/request` listener rewrites the auto-review ask's
 *    `displayReason` to Chinese in every language slot, so the prompt shown when
 *    the user is asked whether to allow the call is Chinese whatever the UI
 *    language is;
 *  - a prepended `llm/stream` listener replaces the reviewer's model call with
 *    the same call plus one language requirement, so the deny reason the user
 *    reads is written in Simplified Chinese.
 *
 * The reviewer call cannot be rewritten in place: the shipped gate builds it as
 * `deepFreeze({ provider, model, system: REVIEW_POLICY, messages, temperature })`
 * and hands that frozen object to the waterfall, and a waterfall listener cannot
 * substitute the reference the default `next` closes over. The instruction is
 * therefore appended to a fresh request object and re-issued through the same
 * `llm` service. That second dispatch re-enters this listener, finds the
 * requirement already present, and delegates, so every other `llm/stream`
 * listener (retry, stream invariant, routing) still runs exactly once with the
 * rewritten request. The model call itself happens once, and the shipped frozen
 * request is never mutated. The replacement is frozen again (its nested values
 * already come from the frozen original), so the immutable-input contract the
 * shipped gate established still holds downstream, and a small per-request
 * replacement counter bounds any re-dispatch so the chain cannot loop.
 *
 * Both listeners return `next()` for every request they do not own, and both
 * swallow and log their own failures, so this plugin can never fail an approval
 * or a model call.
 *
 * @module @local/dsh-auto-review-zh
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'auto-review-zh';

/** Host services whose seams this plugin listens on. */
export const inject = ['approval', 'llm'];

/** Opening marker of the shipped reviewer policy; the only reviewer fingerprint. */
const REVIEWER_POLICY_PREFIX = 'REVIEW_POLICY';

/** Language requirement appended to the reviewer's fixed system prompt. */
const REVIEWER_LANGUAGE_RULE = `
LANGUAGE REQUIREMENT (added by auto-review-zh): whenever you return a deny object, write the optional "reason" member in Simplified Chinese (简体中文), never in English. Every other rule above is unchanged: return exactly one JSON object and no other text, keep the risk and decision values exactly as listed, and never add a reason to an allow object.`;

/** Ceiling on replacements per original request object; bounds a re-dispatch loop. */
const MAX_REPLACEMENTS = 3;

/** Prefix of the audited reason the auto-review gate writes onto an ask decision. */
const AUTO_REVIEW_REASON_PREFIX = 'Auto review denied tool "';

/** Prefix of the English display prompt the auto-review gate writes onto an ask decision. */
const AUTO_REVIEW_DISPLAY_PREFIX = 'Auto review denied this call';

/** Opening of the Chinese ask prompt; the reviewer's own reason is appended after it. */
const ZH_ASK_PREFIX = '自动审查拒绝了此调用：';

/** Chinese ask prompt used when the reviewer recorded no reason. */
const ZH_ASK_FALLBACK = '自动审查拒绝了此调用。';

/**
 * Recover the reviewer's own reason from an auto-review ask's audited reason.
 *
 * The shipped ask reason is `Auto review denied tool "<name>"`, optionally
 * followed by `: <reviewer reason>`. Only the reviewer part belongs in the
 * user-facing prompt; the tool name and the surrounding English sentence do not.
 *
 * @param reason - the ask decision's audited reason.
 * @returns the reviewer's reason, or an empty string when there is none.
 */
export function reviewerReasonOf(reason) {
  if (typeof reason !== 'string' || !reason.startsWith(AUTO_REVIEW_REASON_PREFIX)) return '';
  const rest = reason.slice(AUTO_REVIEW_REASON_PREFIX.length);
  const closing = rest.indexOf('"');
  if (closing < 0) return '';
  return rest.slice(closing + 1).replace(/^:\s*/u, '').trim();
}

/**
 * Build the Chinese ask prompt shown for one auto-review denial.
 *
 * @param detail - the reviewer's own reason, when it recorded one.
 * @returns the complete prompt, Chinese either way.
 */
export function chineseAskText(detail) {
  const clean = typeof detail === 'string' ? detail.trim() : '';
  return clean.length === 0 ? ZH_ASK_FALLBACK : `${ZH_ASK_PREFIX}${clean}`;
}

/** Read the first usable string out of a localized text value. */
function displayTextOf(displayReason) {
  if (typeof displayReason === 'string') return displayReason;
  if (displayReason === null || typeof displayReason !== 'object') return undefined;
  for (const key of ['en', 'zh']) {
    const value = displayReason[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Decide whether one approval request is an auto-review ask.
 *
 * Both fingerprints come from the shipped gate: the audited reason it writes onto
 * the ask decision, and the English display prompt it supplies with it. Any other
 * approval request, from any plugin, is left untouched.
 *
 * @param request - the pending approval request.
 * @returns true when the auto-review gate asked for this decision.
 */
export function isAutoReviewAsk(request) {
  if (request === null || request === undefined || typeof request !== 'object') return false;
  if (typeof request.reason === 'string' && request.reason.startsWith(AUTO_REVIEW_REASON_PREFIX)) return true;
  const shown = displayTextOf(request.displayReason);
  return shown !== undefined && shown.startsWith(AUTO_REVIEW_DISPLAY_PREFIX);
}

/**
 * Put the Chinese prompt into every language slot of one auto-review ask.
 *
 * Both slots carry the same Chinese string, because the prompt's requirement is
 * the language itself rather than the reader's UI language; the audit reason is
 * deliberately not rewritten, so the durable log keeps the gate's own words.
 *
 * @param request - a pending auto-review ask; mutated in place.
 * @returns the same request for convenience.
 */
export function rewriteAsk(request) {
  const text = chineseAskText(reviewerReasonOf(request.reason));
  request.displayReason = { en: text, zh: text };
  return request;
}

/**
 * Report whether one system prompt already carries the language requirement.
 *
 * @param system - the outgoing request's system text.
 * @returns true when this plugin's rule is present.
 */
export function hasReviewerLanguageRule(system) {
  return typeof system === 'string' && system.includes(REVIEWER_LANGUAGE_RULE);
}

/**
 * Decide whether one outgoing model call is the shipped reviewer call.
 *
 * The fixed `REVIEW_POLICY` system prompt is the gate's own marker; no other
 * caller in this Harness opens a system prompt with it.
 *
 * @param options - the outgoing model call options.
 * @returns true for the auto-review gate's reviewer call.
 */
export function isReviewerCall(options) {
  return options !== null && options !== undefined && typeof options === 'object'
    && typeof options.system === 'string'
    && options.system.startsWith(REVIEWER_POLICY_PREFIX);
}

/**
 * Build the replacement reviewer request, or nothing when no rewrite is due.
 *
 * The shipped gate deep-freezes its request, so this always returns a fresh
 * object carrying every shipped field unchanged plus the language requirement,
 * frozen again so the shipped immutable-input posture survives the rewrite; an
 * object that already carries the requirement, or any non-reviewer call, yields
 * `undefined` so the caller delegates untouched.
 *
 * @param options - the outgoing model call options.
 * @returns a fresh options object, or `undefined` when no rewrite is due.
 */
export function reviewerLanguageRequest(options) {
  if (!isReviewerCall(options)) return undefined;
  if (hasReviewerLanguageRule(options.system)) return undefined;
  return Object.freeze({ ...options, system: `${options.system}${REVIEWER_LANGUAGE_RULE}` });
}

/**
 * Resolve the row config.
 *
 * Both surfaces are on by default so an omitted or empty `config` still delivers
 * the requested result; only an explicit `false` turns one off.
 *
 * @param config - the row config, when the patch declares one.
 * @returns the resolved switches.
 */
export function resolveSwitches(config) {
  const row = config !== null && config !== undefined && typeof config === 'object' ? config : {};
  return {
    promptChinese: row.promptChinese !== false,
    reviewerChinese: row.reviewerChinese !== false,
  };
}

/** Log one contained failure without naming internals the user cannot act on. */
function warn(ctx, seam, error) {
  const message = error instanceof Error ? error.message : String(error);
  ctx.logger.warn(`auto-review-zh: left one ${seam} request unchanged: ${message}`);
}

/**
 * Install both listeners.
 *
 * @param ctx - plugin context carrying the approval and llm services.
 * @param config - row config; see {@link resolveSwitches}.
 * @returns nothing; both listeners are registered as named effects.
 */
export function apply(ctx, config) {
  const switches = resolveSwitches(config);
  /** Replacements already issued per original reviewer request object. */
  const replaced = new WeakMap();

  if (switches.reviewerChinese) {
    ctx.effect(() => ctx.on('llm/stream', (options, next) => {
      let rewritten;
      try {
        if (options !== null && typeof options === 'object' && (replaced.get(options) ?? 0) < MAX_REPLACEMENTS) {
          rewritten = reviewerLanguageRequest(options);
          if (rewritten !== undefined) replaced.set(options, (replaced.get(options) ?? 0) + 1);
        }
      } catch (error) {
        warn(ctx, 'llm/stream', error);
        return next();
      }
      if (rewritten === undefined) return next();
      const service = ctx.llm;
      if (service === null || service === undefined || typeof service.stream !== 'function') return next();
      try {
        return service.stream(rewritten);
      } catch (error) {
        warn(ctx, 'llm/stream', error);
        return next();
      }
    }, { prepend: true }), 'auto-review-zh: reviewer reason language');
  }

  if (switches.promptChinese) {
    ctx.effect(() => ctx.on('approval/request', (request, next) => {
      try {
        if (isAutoReviewAsk(request)) rewriteAsk(request);
      } catch (error) {
        warn(ctx, 'approval/request', error);
      }
      return next();
    }, { prepend: true }), 'auto-review-zh: Chinese ask prompt');
  }

  ctx.logger.info(`auto-review-zh: active (promptChinese=${switches.promptChinese}, reviewerChinese=${switches.reviewerChinese})`);
}
