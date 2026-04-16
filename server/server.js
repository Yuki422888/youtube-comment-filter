import express from "express";
import cors from "cors";
import OpenAI from "openai";
import rateLimit from "express-rate-limit";

const app = express();
const PORT = Number(process.env.PORT || 3000);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const EXTENSION_SHARED_TOKEN = process.env.EXTENSION_SHARED_TOKEN || "";
const EXTENSION_SHARED_TOKEN_PREVIOUS =
    process.env.EXTENSION_SHARED_TOKEN_PREVIOUS || "";

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

const MAX_BATCH_SIZE = 20;
const MAX_COMMENT_LENGTH = 500;
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "1mb";

// 公開版 extension の ID から確定した Origin
const PUBLIC_EXTENSION_ORIGIN =
    "chrome-extension://dhbpeapnaoeibclpccaancdfillbdhdm";

const envAllowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

const allowedOrigins = Array.from(
    new Set([PUBLIC_EXTENSION_ORIGIN, ...envAllowedOrigins])
);

// --- CORS -------------------------------------------------------------

function isAllowedOrigin(origin) {
    if (!origin) return true; // health check, curl など
    return allowedOrigins.includes(origin);
}

const corsOptions = {
    origin(origin, callback) {
        if (isAllowedOrigin(origin)) {
            return callback(null, true);
        }
        console.error("[cors] blocked origin:", origin);
        return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-YTCF-Token"],
    optionsSuccessStatus: 204,
};

app.use((req, _res, next) => {
    console.log("[req]", {
        method: req.method,
        path: req.path,
        origin: req.headers.origin || "",
        hasToken: Boolean(req.get("X-YTCF-Token")),
        contentType: req.get("Content-Type") || "",
    });
    next();
});

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

app.use(express.json({ limit: JSON_BODY_LIMIT }));

// --- Rate limit -------------------------------------------------------

const analyzeBatchLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: "Too many requests. Please try again shortly.",
    },
});

// --- Common headers ---------------------------------------------------

app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
});

// --- Health -----------------------------------------------------------

app.get("/", (_req, res) => {
    res.json({
        success: true,
        message: "YTCF server is running",
    });
});

app.get("/health", (_req, res) => {
    res.json({
        success: true,
        status: "ok",
        service: "ytcf-server",
        hasOpenAIKey: Boolean(OPENAI_API_KEY),
        timestamp: new Date().toISOString(),
    });
});

app.get("/healthz", (_req, res) => {
    res.json({
        success: true,
        status: "ok",
        service: "ytcf-server",
        hasOpenAIKey: Boolean(OPENAI_API_KEY),
        timestamp: new Date().toISOString(),
    });
});

// --- Auth -------------------------------------------------------------

function isValidExtensionToken(token) {
    if (!token) return false;

    if (EXTENSION_SHARED_TOKEN && token === EXTENSION_SHARED_TOKEN) {
        return true;
    }

    if (
        EXTENSION_SHARED_TOKEN_PREVIOUS &&
        token === EXTENSION_SHARED_TOKEN_PREVIOUS
    ) {
        return true;
    }

    return false;
}

// --- Main route -------------------------------------------------------

app.post("/analyze-batch", analyzeBatchLimiter, async (req, res) => {
    const token = req.get("X-YTCF-Token");

    if (!isValidExtensionToken(token)) {
        console.error("[auth] invalid token");
        return res.status(401).json({
            success: false,
            error: "Unauthorized",
        });
    }

    const comments = normalizeComments(req.body?.comments);

    if (!comments.length) {
        return res.status(400).json({
            success: false,
            error: "comments must be a non-empty array of strings",
        });
    }

    try {
        const finalResults = new Array(comments.length).fill(null);
        const aiTargets = [];

        comments.forEach((text, index) => {
            const ruleScore = getRuleBasedScore(text);

            if (ruleScore !== null) {
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
            if (!OPENAI_API_KEY) {
                throw new Error("OPENAI_API_KEY is not configured");
            }

            const gptResults = await analyzeByGPT(aiTargets);

            gptResults.forEach((item) => {
                finalResults[item.index] = item;
            });
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

        return res.json({
            success: true,
            degraded: false,
            results,
        });
    } catch (error) {
        console.error("[server] analyze-batch error:", error?.message || error);

        return res.json({
            success: true,
            degraded: true,
            results: comments.map((text, index) => ({
                index,
                text,
                score: 0,
                source: "fail_open",
            })),
        });
    }
});

// --- Helpers ----------------------------------------------------------

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

async function analyzeByGPT(targets) {
    const localComments = targets.map((item) => item.text);
    const prompt = buildPrompt(localComments);

    const response = await client.responses.create({
        model: "gpt-4.1-mini",
        input: prompt,
        temperature: 0,
    });

    const raw = String(response.output_text || "").trim();
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
            source: "gpt",
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
    } catch {
        console.error("[server] GPT JSON parse failed");
        throw new Error("GPT response JSON parse failed");
    }
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
        if (normalized.includes(word)) return 1.0;
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

    if (isClearlyHarmlessShortText(normalized)) return 0.0;
    if (containsSecondPersonAttack(text)) return 0.72;
    if (containsSarcasticAttackPattern(text)) return 0.62;
    if (containsNegativeEvaluation(text)) return 0.52;
    if (normalized.length <= 6) return 0.1;

    return null;
}

function normalizeRuleText(text) {
    return String(text || "").replace(/\s+/g, "").trim();
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

    if (harmlessSet.has(text)) return true;

    const emojiOnlyRegex = /^[\p{Emoji}\p{Extended_Pictographic}\uFE0F]+$/u;
    if (emojiOnlyRegex.test(text)) return true;

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

// CORS エラーを JSON で返す
app.use((err, _req, res, _next) => {
    if (err && err.message === "Not allowed by CORS") {
        return res.status(403).json({
            success: false,
            error: "Not allowed by CORS",
        });
    }

    console.error("[server] unexpected error:", err);
    return res.status(500).json({
        success: false,
        error: "Internal server error",
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log("=== YTCF SERVER NEW BUILD ===");
    console.log(`Server running on port ${PORT}`);
    console.log("[config] allowed origins:", allowedOrigins);
});