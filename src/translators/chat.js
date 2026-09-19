import OpenAI from "openai";

import { config } from "../config.js";
import { createLogger } from "../logger.js";
import { logApiCall } from "../apiLog.js";
import { buildSystemPrompt, buildUserPrompt, glossaryFlags, LINE_PROTOCOL_RULES, speakerRules } from "./openai.js";
import { JSON_RESPONSE_FORMAT, jsonOutputRules, parseTranslations, toNumbered } from "./jsonOutput.js";

/**
 * Thân chung cho các provider dịch bằng LLM qua API tương thích OpenAI.
 *
 * DeepSeek và Qwen (DashScope compatible-mode) đều nói đúng giao thức
 * /chat/completions của OpenAI, nên chỉ khác `baseURL` + `apiKey` + tên model —
 * không đáng để chép lại toàn bộ prompt và phần xử lý speaker cho từng cái.
 *
 * Prompt dùng chung với provider `openai` (import từ openai.js) là có chủ ý: đem so
 * chất lượng giữa các model thì phải cùng một prompt, khác prompt là so nhầm thứ.
 *
 * `json` — bật JSON Mode (`response_format: {type:"json_object"}`) cho endpoint đã
 * KIỂM CHỨNG là hỗ trợ. DeepSeek có (doc chính thức); Qwen qua compatible-mode thì
 * chưa đo, để tắt: endpoint tương thích OpenAI có thể lặng lẽ BỎ QUA tham số lạ,
 * lúc đó `parseTranslations` sẽ trả null cho mọi cụm và bước dịch tự chia đôi tới
 * đáy — hỏng đắt hơn hẳn việc cứ đi đường đánh số như cũ.
 */
export function createChatTranslator({ name, baseURL, apiKey, model, keyHint, temperature = 0.3, json = false }) {
  const log = createLogger(`TR/${name}`);

  const client = () => {
    if (!apiKey) throw new Error(`thiếu ${keyHint} — thêm vào .env (xem .env.example)`);
    return new OpenAI({
      apiKey,
      baseURL,
      maxRetries: config.sttMaxRetries,
      timeout: config.sttTimeoutMs,
    });
  };

  return async function translateText(text, { to, speakerHint, surrounding, glossaryDict, hasPlaceholders, expectLines }) {
    const flags = glossaryFlags({ glossaryDict, hasPlaceholders });
    const systemPrompt = buildSystemPrompt({
      ...flags,
      outputRules: json ? jsonOutputRules() : LINE_PROTOCOL_RULES,
    });
    const messages = [
      {
        role: "system",
        content: [systemPrompt, speakerRules(speakerHint)].filter(Boolean).join("\n"),
      },
      { role: "user", content: buildUserPrompt(text, to, surrounding, glossaryDict, flags.hasPlaceholders) },
    ];

    const params = {
      model,
      temperature,
      messages,
      // Doc DeepSeek dặn đặt max_tokens đủ rộng để JSON không bị cắt giữa chừng —
      // cắt giữa chừng là JSON hỏng, mất trắng cả cụm chứ không phải mất 1 dòng.
      ...(json ? { response_format: JSON_RESPONSE_FORMAT, max_tokens: config.translateMaxTokens } : {}),
    };
    const t0 = Date.now();
    const res = await logApiCall(log, { url: `${baseURL}/chat/completions`, body: params }, () =>
      client().chat.completions.create(params),
    );

    const content = res.choices[0]?.message?.content ?? "";
    if (!json) {
      const out = content.trim();
      log.debug(`${model}: ${text.length} → ${out.length} ký tự (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      return out;
    }

    // Hỏng thì trả "" — parsePayload() của translate.js coi là hỏng và tự chia đôi
    // cụm thử lại, cùng đường xử lý với provider openai.
    const translations = parseTranslations(content, name, expectLines ?? null);
    if (!translations) return "";
    const out = toNumbered(translations);
    log.debug(
      `${model}: ${text.length} → ${translations.length} dòng, ${out.length} ký tự (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );
    return out;
  };
}
