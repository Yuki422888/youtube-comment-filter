import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
const PORT = Number(process.env.PORT || 3000);

// ===== 環境変数 =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const EXTENSION_SHARED_TOKEN = process.env.EXTENSION_SHARED_TOKEN || "";

// ===== OpenAI =====
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// ===== ミドルウェア =====
app.use(cors());
app.use(express.json());

// ===== 認証 =====
function requireExtensionToken(req, res, next) {
  const token = req.header("X-YTCF-Token");

  if (!token || token !== EXTENSION_SHARED_TOKEN) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized request",
    });
  }

  next();
}

// ===== ヘルスチェック =====
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "YTCF server running",
  });
});

// ===== メイン処理 =====
app.post("/analyze-batch", requireExtensionToken, async (req, res) => {
  try {
    const comments = normalizeComments(req.body.comments);

    if (!comments.length) {
      return res.status(400).json({
        success: false,
        error: "No comments",
      });
    }

    const prompt = buildPrompt(comments);

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      temperature: 0,
    });

    const parsed = parseAIResponse(response.output_text);

    const results = comments.map((text, index) => {
      const found = parsed.find((r) => r.index === index);
      return {
        index,
        text,
        score: clampScore(found?.score),
      };
    });

    res.json({
      success: true,
      results,
    });
  } catch (err) {
    console.error(err);

    res.json({
      success: true,
      degraded: true,
      results: req.body.comments.map((text, index) => ({
        index,
        text,
        score: 0,
      })),
    });
  }
});

// ===== ユーティリティ =====

function normalizeComments(input) {
  if (!Array.isArray(input)) return [];

  return input
    .filter((t) => typeof t === "string")
    .map((t) => normalizeText(t))
    .slice(0, 20);
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function buildPrompt(comments) {
  return `
You are an AI that evaluates toxicity of comments.

Return JSON only.

Format:
[
  { "index": 0, "score": 0.1 }
]

Comments:
${JSON.stringify(comments)}
`;
}

function parseAIResponse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// ===== 起動 =====
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});