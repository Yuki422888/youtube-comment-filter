import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";
import crypto from "crypto";

console.log("===== YTCF SECURE SERVER LOADED =====");

const app = express();
const PORT = Number(process.env.PORT || 3000);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const EXTENSION_SHARED_TOKEN = process.env.EXTENSION_SHARED_TOKEN || "";
const EXTENSION_SHARED_TOKEN_PREVIOUS =
  process.env.EXTENSION_SHARED_TOKEN_PREVIOUS || "";

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

const MAX_BATCH_SIZE = Number(process.env.MAX_BATCH_SIZE || 20);
const MAX_COMMENT_LENGTH = Number(process.env.MAX_COMMENT_LENGTH || 500);
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "1mb";
const SHORT_COMMENT_LENGTH = 6;

const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX_PER_WINDOW = Number(
  process.env.RATE_LIMIT_MAX_PER_WINDOW || 40
);

const DAILY_COMMENT_BUDGET = Number(process.env.DAILY_COMMENT_BUDGET || 12000);
const DAILY_REQUEST_BUDGET = Number(process.env.DAILY_REQUEST_BUDGET || 2500);

const SCORING_MODE = String(process.env.SCORING_MODE || "gpt_only").toLowerCase();
const ENABLE_GPT_FALLBACK =
  String(process.env.ENABLE_GPT_FALLBACK || "true").toLowerCase() === "true";
const GPT_MODEL = process.env.GPT_MODEL || "gpt-4.1-mini";
const GPT_FALLBACK_MODEL = process.env.GPT_FALLBACK_MODEL || GPT_MODEL;
const MODERATION_MODEL = process.env.MODERATION_MODEL || "omni-moderation-latest";

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

if (!OPENAI_API_KEY) {
  console.warn("[WARN] OPENAI_API_KEY is missing.");
}
if (!EXTENSION_SHARED_TOKEN) {
  console.warn("[WARN] EXTENSION_SHARED_TOKEN is missing.");
}

app.set("trust proxy", 1);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.length === 0) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS blocked origin: ${origin}`));
    },
  })
);

app.use(express.json({ limit: JSON_BODY_LIMIT }));

/**
 * =========================
 * Logging helpers
 * =========================
 */
function makeReqId() {
  return crypto.randomBytes(6).toString("hex");
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || "unknown";
}

function maskToken(token) {
  if (!token) return "none";
  if (token.length <= 8) return "***";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function logInfo(req, message, extra = {}) {
  console.log(
    JSON.stringify({
      level: "info",
      time: new Date().toISOString(),
      reqId: req.reqId,
      ip: getClientIp(req),
      path: req.path,
      message,
      ...extra,
    })
  );
}

function logWarn(req, message, extra = {}) {
  console.warn(
    JSON.stringify({
      level: "warn",
      time: new Date().toISOString(),
      reqId: req.reqId,
      ip: getClientIp(req),
      path: req.path,
      message,
      ...extra,
    })
  );
}

function logError(req, message, extra = {}) {
  console.error(
    JSON.stringify({
      level: "error",
      time: new Date().toISOString(),
      reqId: req.reqId,
      ip: getClientIp(req),
      path: req.path,
      message,
      ...extra,
    })
  );
}

app.use((req, _res, next) => {
  req.reqId = makeReqId();
  next();
});

/**
 * =========================
 * Simple in-memory daily budget
 * Render Free ならまずこれで十分
 * （再起動でリセットされる）
 * =========================
 */
const dailyBudget = {
  date: getTodayKey(),
  requests: 0,
  comments: 0,
};

function getTodayKey() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function resetDailyBudgetIfNeeded() {
  const today = getTodayKey();
  if (dailyBudget.date !== today) {
    dailyBudget.date = today;
    dailyBudget.requests = 0;
    dailyBudget.comments = 0;
  }
}

function canSpendBudget(commentCount) {
  resetDailyBudgetIfNeeded();
  if (dailyBudget.requests + 1 > DAILY_REQUEST_BUDGET) return false;
  if (dailyBudget.comments + commentCount > DAILY_COMMENT_BUDGET) return false;
  return true;
}

function spendBudget(commentCount) {
  resetDailyBudgetIfNeeded();
  dailyBudget.requests += 1;
  dailyBudget.comments += commentCount;
}

function getBudgetSnapshot() {
  resetDailyBudgetIfNeeded();
  return {
    date: dailyBudget.date,
    requests: dailyBudget.requests,
    comments: dailyBudget.comments,
    requestBudget: DAILY_REQUEST_BUDGET,
    commentBudget: DAILY_COMMENT_BUDGET,
  };
}

/**
 * =========================
 * Fail-open response
 * 判定できない時はコメントを見せる
 * =========================
 */
function buildFailOpenResults(comments, source = "fail_open") {
  return comments.map((text, index) => ({
    index,
    text,
    score: 0,
    source,
  }));
}

function failOpen(res, comments, reason, extra = {}) {
  return res.status(200).json({
    success: true,
    degraded: true,
    failOpen: true,
    reason,
    results: buildFailOpenResults(comments, reason),
    ...extra,
  });
}

/**
 * =========================
 * Auth
 * current / previous token 両対応
 * =========================
 */
function isValidExtensionToken(requestToken) {
  if (!requestToken) return false;
  if (requestToken === EXTENSION_SHARED_TOKEN) return true;
  if (
    EXTENSION_SHARED_TOKEN_PREVIOUS &&
    requestToken === EXTENSION_SHARED_TOKEN_PREVIOUS
  ) {
    return true;
  }
  return false;
}

function requireExtensionToken(req, res, next) {
  const requestToken = req.header("X-YTCF-Token");

  if (!EXTENSION_SHARED_TOKEN) {
    return res.status(500).json({
      success: false,
      error: "Server misconfiguration: missing EXTENSION_SHARED_TOKEN",
    });
  }

  if (!isValidExtensionToken(requestToken)) {
    logWarn(req, "Unauthorized request", {
      tokenPreview: maskToken(requestToken),
    });
    return res.status(401).json({
      success: false,
      error: "Unauthorized request",
    });
  }

  next();
}

/**
 * =========================
 * Analyze route limiter
 * IP + token 単位で制限
 * 制限時も fail-open
 * =========================
 */
const analyzeLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX_PER_WINDOW,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const ip = getClientIp(req);
    const token = req.header("X-YTCF-Token") || "no-token";
    return `${ip}:${token}`;
  },
  handler: (req, res) => {
    const comments = normalizeComments(req.body?.comments);
    logWarn(req, "Rate limit triggered", {
      commentCount: comments.length,
    });
    return failOpen(res, comments, "rate_limited");
  },
});

/**
 * =========================
 * Health
 * =========================
 */
app.get("/", (_req, res) => {
  return res.json({
    success: true,
    message: "YTCF secure server is running",
  });
});

app.get("/health", (_req, res) => {
  return res.json({
    success: true,
    status: "ok",
    scoringMode: getEffectiveScoringMode(),
    moderationModel: MODERATION_MODEL,
    gptModel: GPT_MODEL,
    gptFallbackEnabled: ENABLE_GPT_FALLBACK,
    gptFallbackModel: GPT_FALLBACK_MODEL,
    budget: getBudgetSnapshot(),
  });
});

/**
 * =========================
 * Main endpoint
 * =========================
 */
app.post(
  "/analyze-batch",
  requireExtensionToken,
  analyzeLimiter,
  async (req, res) => {
    const startedAt = Date.now();

    try {
      const comments = normalizeComments(req.body?.comments);

      if (!Array.isArray(comments) || comments.length === 0) {
        return res.status(400).json({
          success: false,
          error: "comments must be a non-empty array of strings",
        });
      }

      if (comments.length > MAX_BATCH_SIZE) {
        return res.status(400).json({
          success: false,
          error: `Too many comments. Maximum batch size is ${MAX_BATCH_SIZE}`,
        });
      }

      const totalChars = comments.reduce((sum, text) => sum + text.length, 0);
      if (totalChars > MAX_BATCH_SIZE * MAX_COMMENT_LENGTH) {
        return res.status(400).json({
          success: false,
          error: "Payload text is too large",
        });
      }

      if (!canSpendBudget(comments.length)) {
        logWarn(req, "Daily budget guard triggered", {
          commentCount: comments.length,
          budget: getBudgetSnapshot(),
        });
        return failOpen(res, comments, "budget_guard", {
          budget: getBudgetSnapshot(),
        });
      }

      spendBudget(comments.length);

      const scoringMode = getEffectiveScoringMode();

      logInfo(req, "Analyze request accepted", {
        commentCount: comments.length,
        totalChars,
        scoringMode,
        budget: getBudgetSnapshot(),
      });

      const finalResults = new Array(comments.length).fill(null);
      const aiTargets = [];

      comments.forEach((text, index) => {
        const ruleScore = getRuleBasedScore(text);
        if (ruleScore != null) {
          finalResults[index] = {
            index,
            text,
            score: clampScore(ruleScore),
            source: "rule",
          };
        } else {
          aiTargets.push({ index, text });
        }
      });

      if (aiTargets.length > 0) {
        if (scoringMode === "gpt_only") {
          const gptResults = await analyzeByGPT(aiTargets, GPT_MODEL);
          gptResults.forEach((item) => {
            finalResults[item.index] = item;
          });
        } else if (scoringMode === "hybrid") {
          const moderationResults = await analyzeByModeration(aiTargets);
          moderationResults.forEach((item) => {
            finalResults[item.index] = item;
          });

          const fallbackTargets = moderationResults.filter(shouldEscalateToGPT);

          if (ENABLE_GPT_FALLBACK && fallbackTargets.length > 0) {
            const gptResults = await analyzeByGPT(
              fallbackTargets,
              GPT_FALLBACK_MODEL
            );
            gptResults.forEach((item) => {
              finalResults[item.index] = item;
            });
          }
        }
      }

      const results = comments.map((text, index) => {
        const item = finalResults[index];
        return {
          index,
          text,
          score: clampScore(item?.score),
          source: item?.source || "unknown",
        };
      });

      logInfo(req, "Analyze request completed", {
        elapsedMs: Date.now() - startedAt,
        commentCount: comments.length,
      });

      return res.json({
        success: true,
        degraded: false,
        scoringMode,
        results,
      });
    } catch (error) {
      const comments = normalizeComments(req.body?.comments);

      logError(req, "Analyze batch error", {
        error: error?.message || "unknown error",
      });

      // OpenAIや一時エラーでもYouTube利用自体は止めない
      return failOpen(res, comments, "server_error");
    }
  }
);

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

function normalizeComments(input) {
  if (!Array.isArray(input)) return [];
  const normalized = [];

  for (const item of input) {
    if (typeof item !== "string") continue;
    const text = normalizeText(item).slice(0, MAX_COMMENT_LENGTH);
    if (!text) continue;
    normalized.push(text);
    if (normalized.length >= MAX_BATCH_SIZE) break;
  }

  return normalized;
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

function normalizeComments(input) {
  if (!Array.isArray(input)) return [];

  const normalized = [];

  for (const item of input) {
    if (typeof item !== "string") continue;

    const text = normalizeText(item).slice(0, MAX_COMMENT_LENGTH);
    if (!text) continue;

    normalized.push(text);

    if (normalized.length >= MAX_BATCH_SIZE) break;
  }

  return normalized;
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
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

function clampScore(value) {
  const numValue = Number(value);
  if (!Number.isFinite(numValue)) return 0;
  if (numValue < 0) return 0;
  if (numValue > 1) return 1;
  return numValue;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function getRuleBasedScore(text) {
  const normalized = normalizeRuleText(text);

  if (!normalized) return 0;

  const exactHigh = new Map([
    ["死ね", 1.0],
    ["しね", 1.0],
    ["殺す", 1.0],
    ["ころす", 1.0],
    ["消えろ", 0.95],
    ["失せろ", 0.95],
    ["くたばれ", 0.95],
    ["バカ", 0.8],
    ["ばか", 0.8],
    ["馬鹿", 0.8],
    ["アホ", 0.8],
    ["あほ", 0.8],
    ["キモい", 0.7],
    ["きもい", 0.7],
    ["ゴミ", 0.8],
    ["ごみ", 0.8],
    ["カス", 0.8],
    ["かす", 0.8],
    ["うざい", 0.7],
    ["最悪", 0.65],
  ]);

  if (exactHigh.has(normalized)) {
    return exactHigh.get(normalized);
  }

  const containsVeryHigh = [
    "死ね",
    "しね",
    "殺す",
    "ころす",
    "消えろ",
    "失せろ",
    "くたばれ",
  ];

  for (const word of containsVeryHigh) {
    if (normalized.includes(word)) {
      return 1.0;
    }
  }

  const containsHigh = [
    "バカ",
    "ばか",
    "馬鹿",
    "アホ",
    "あほ",
    "キモい",
    "きもい",
    "ゴミ",
    "ごみ",
    "カス",
    "かす",
    "うざい",
    "最悪",
  ];

  for (const word of containsHigh) {
    if (normalized.includes(word) && normalized.length <= 12) {
      return 0.8;
    }
  }

  if (isClearlyHarmlessShortText(normalized)) {
    return 0.0;
  }

  if (normalized.length <= SHORT_COMMENT_LENGTH) {
    return 0.1;
  }

  return null;
}

function normalizeRuleText(text) {
  return text.replace(/\s+/g, "").trim();
}

function isClearlyHarmlessShortText(text) {
  if (!text) return true;

  const harmlessSet = new Set([
    "w",
    "ww",
    "www",
    "草",
    "笑",
    "えらい",
    "すごい",
    "最高",
    "天才",
    "いいね",
    "ありがとう",
  ]);

  if (harmlessSet.has(text)) {
    return true;
  }

  const emojiOnlyRegex = /^[\p{Emoji}\p{Extended_Pictographic}\uFE0F]+$/u;
  if (emojiOnlyRegex.test(text)) {
    return true;
  }

  return false;
}

function containsSecondPersonAttack(text) {
  const normalized = normalizeText(text);

  const patterns = [
    /お前/,
    /おまえ/,
    /てめえ/,
    /お前さ/,
    /お前は/,
    /おまえは/,
    /お前ほんと/,
    /お前マジ/,
    /お前きも/,
    /お前バカ/,
    /お前アホ/,
    /お前下手/,
    /お前終わってる/,
  ];

  return patterns.some((re) => re.test(normalized));
}

function containsSarcasticAttackPattern(text) {
  const normalized = normalizeText(text);

  const patterns = [
    /才能ない/,
    /向いてない/,
    /センスない/,
    /消えたほうが/,
    /やめたほうが/,
    /恥ずかしくないの/,
    /よくこれで/,
    /頭悪/,
    /きしょ/,
    /きもすぎ/,
    /終わってる/,
    /その程度/,
    /よくこれで出せたな/,
    /誰が見るんだよ/,
    /よくそんな自信あるな/,
  ];

  return patterns.some((re) => re.test(normalized));
}

function containsNegativeEvaluation(text) {
  const normalized = normalizeText(text);

  const patterns = [
    /つまらない/,
    /下手/,
    /ひどい/,
    /微妙/,
    /寒い/,
    /痛い/,
    /ださい/,
    /気持ち悪い/,
    /うざい/,
    /最悪/,
    /終わってる/,
    /レベル低/,
    /見てられない/,
    /何が面白いの/,
    /意味わからん/,
    /イライラする/,
    /しょぼい/,
    /きつい/,
    /残念すぎる/,
    /無理だわ/,
    /見苦しい/,
    /黒歴史/,
    /しょうもない/,
  ];

  return patterns.some((re) => re.test(normalized));
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

