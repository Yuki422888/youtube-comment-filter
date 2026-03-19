/**
 * =========================
 * Existing helpers
 * ここから下は今のあなたの既存ロジックを基本そのまま使う
 * =========================
 */
function getEffectiveScoringMode() {
  return ["gpt_only", "hybrid"].includes(SCORING_MODE)
    ? SCORING_MODE
    : "gpt_only";
}



function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clampScore(value) {
  const n = num(value);
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ---- ここから下はあなたの既存実装をそのまま残す ----
// analyzeByModeration
// moderationToToxicScore
// shouldEscalateToGPT
// analyzeByGPT
// buildPrompt
// parseAIResponse
// getRuleBasedScore
// containsSecondPersonAttack
// containsNegativeEvaluation
// containsSarcasticAttackPattern
// ...など

async function analyzeByModeration(aiTargets) {
  const inputs = aiTargets.map((item) => item.text);

  const response = await client.moderations.create({
    model: MODERATION_MODEL,
    input: inputs,
  });

  const results = Array.isArray(response?.results) ? response.results : [];

  if (results.length !== aiTargets.length) {
    throw new Error("Moderation response count mismatch");
  }

  return aiTargets.map((target, localIndex) => {
    const moderation = results[localIndex] || {};
    const score = moderationToToxicScore(moderation, target.text);

    return {
      index: target.index,
      text: target.text,
      score,
      source: "moderation",
      moderation,
    };
  });
}

function moderationToToxicScore(moderation, text) {
  const scores = moderation?.category_scores || {};
  const categories = moderation?.categories || {};

  const harassment = num(scores.harassment);
  const harassmentThreat = num(scores["harassment/threatening"]);
  const hate = num(scores.hate);
  const hateThreat = num(scores["hate/threatening"]);
  const violence = num(scores.violence);
  const violenceGraphic = num(scores["violence/graphic"]);

  let score = 0;

  score = Math.max(score, harassment * 1.0);
  score = Math.max(score, harassmentThreat * 1.0);
  score = Math.max(score, hate * 1.0);
  score = Math.max(score, hateThreat * 1.0);
  score = Math.max(score, violence * 0.8);
  score = Math.max(score, violenceGraphic * 0.9);

  if (categories["harassment/threatening"]) {
    score = Math.max(score, 0.92);
  }

  if (categories["hate/threatening"]) {
    score = Math.max(score, 0.95);
  }

  if (categories.harassment && score < 0.62) {
    score = Math.max(score, 0.62);
  }

  if (categories.hate && score < 0.75) {
    score = Math.max(score, 0.75);
  }

  if (containsSecondPersonAttack(text) && score >= 0.08) {
    score = Math.min(1, score + 0.08);
  }

  if (containsNegativeEvaluation(text) && score >= 0.1) {
    score = Math.min(1, score + 0.1);
  }

  if (containsSarcasticAttackPattern(text) && score >= 0.1) {
    score = Math.min(1, score + 0.12);
  }

  return clampScore(score);
}

function shouldEscalateToGPT(item) {
  const score = clampScore(item?.score);
  const text = item?.text || "";
  const moderation = item?.moderation || {};
  const categories = moderation?.categories || {};
  const scores = moderation?.category_scores || {};

  if (!text) return false;
  if (text.length <= 3) return false;
  if (score < 0.08) return false;
  if (score >= 0.9) return false;

  const harassment = num(scores.harassment);
  const hate = num(scores.hate);

  if (categories.harassment || categories.hate) return true;
  if (harassment >= 0.08 || hate >= 0.06) return true;
  if (containsSecondPersonAttack(text)) return true;
  if (containsSarcasticAttackPattern(text)) return true;
  if (containsNegativeEvaluation(text)) return true;

  return false;
}

async function analyzeByGPT(targets, modelName) {
  const localComments = targets.map((item) => item.text);
  const prompt = buildPrompt(localComments);

  const response = await client.responses.create({
    model: modelName,
    input: prompt,
    temperature: 0,
  });

  const raw = String(response.output_text || "").trim();
  console.log(`[GPT ${modelName}] raw response:`, raw);

  const parsed = parseAIResponse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("GPT response is not an array");
  }

  return targets.map((target, localIndex) => {
    const matched = parsed.find((item) => Number(item?.index) === localIndex);

    return {
      index: target.index,
      text: target.text,
      score: clampScore(matched?.score),
      source: modelName === GPT_MODEL ? "gpt" : "gpt_fallback",
    };
  });
}

function buildPrompt(comments) {
  return `
あなたはYouTubeコメントの攻撃性を評価するAIです。

各コメントについて、攻撃性を 0.0〜1.0 の数値で評価してください。

評価基準:
0.0 = 無害
0.3 = やや否定的
0.5 = 不快・攻撃的
0.8 = 強い侮辱
1.0 = 非常に攻撃的

重要なルール:
- 入力コメント数と同じ件数の結果を返してください
- index は入力配列の添字と必ず一致させてください
- 必ず JSON のみ返してください
- 説明文は不要です
- markdown は使わないでください
- \`\`\`json や \`\`\` で囲まないでください
- score は 0.0 以上 1.0 以下の数値にしてください
- 皮肉、遠回しな侮辱、人格攻撃も考慮してください
- 単なる意見や批判と、個人攻撃を区別してください
- 日本語の嫌味、見下し、嘲笑、馬鹿にするニュアンスも考慮してください

返却形式:
[
  { "index": 0, "score": 0.1 },
  { "index": 1, "score": 0.9 }
]

コメント一覧:
${JSON.stringify(comments, null, 2)}
`.trim();
}

function parseAIResponse(rawText) {
  if (!rawText || typeof rawText !== "string") {
    throw new Error("Empty GPT response");
  }

  let cleaned = rawText.trim();
  cleaned = cleaned.replace(/^```json\s*/i, "");
  cleaned = cleaned.replace(/^```\s*/i, "");
  cleaned = cleaned.replace(/\s*```$/i, "");
  cleaned = cleaned.trim();

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    console.error("JSON parse failed. Raw response was:");
    console.error(rawText);
    console.error("Cleaned response was:");
    console.error(cleaned);
    throw new Error("GPT response JSON parse failed");
  }
}
