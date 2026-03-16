const ENV = {
  LOCAL: "local",
  PRODUCTION: "production",
};

// 開発中は "local"
// Render公開後は "production"
const CURRENT_ENV = ENV.PRODUCTION;

const CONFIG = {
  [ENV.LOCAL]: {
    API_BASE_URL: "http://localhost:3000",
    EXTENSION_SHARED_TOKEN: "local_dev_token_change_me",
  },
  [ENV.PRODUCTION]: {
    API_BASE_URL: "https://youtube-comment-filter-server.onrender.com",
    // 本番用トークンをここに入れる
    // 例: "ytcf_prod_xxxxxxxxxxxxxxxxx"
    EXTENSION_SHARED_TOKEN: "ytcf_prod_4Kf8x2Lm9Qa7Zp3Rn6Uv1Ws5",
  },
};

function getConfig() {
  return CONFIG[CURRENT_ENV];
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "ANALYZE_COMMENTS_BATCH") {
    return false;
  }

  (async () => {
    try {
      const comments = Array.isArray(message.comments) ? message.comments : [];

      if (comments.length === 0) {
        sendResponse({
          success: false,
          error: "comments must be a non-empty array",
        });
        return;
      }

      const { API_BASE_URL } = getConfig();

      console.log("[YTCF background] current env =", CURRENT_ENV);
      console.log("[YTCF background] API_BASE_URL =", API_BASE_URL);
      console.log("[YTCF background] received batch:", comments);

      const data = await postAnalyzeBatch(comments);

      if (!data || data.success !== true || !Array.isArray(data.results)) {
        throw new Error("Invalid server response format");
      }

      sendResponse({ success: true, data });
    } catch (error) {
      console.error("[YTCF background] error:", error);
      sendResponse({
        success: false,
        error: error?.message || "Unknown background error",
      });
    }
  })();

  return true;
});

async function postAnalyzeBatch(comments) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const { API_BASE_URL, EXTENSION_SHARED_TOKEN } = getConfig();
    const analyzeBatchUrl = `${API_BASE_URL}/analyze-batch`;

    const response = await fetch(analyzeBatchUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-YTCF-Token": EXTENSION_SHARED_TOKEN,
      },
      body: JSON.stringify({ comments }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await safeReadText(response);
      throw new Error(
        `Server error: ${response.status}${errorText ? ` - ${errorText}` : ""}`
      );
    }

    const data = await response.json();
    return normalizeAnalyzeResponse(data, comments);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeAnalyzeResponse(data, comments) {
  if (!data || typeof data !== "object") {
    throw new Error("Server returned invalid JSON");
  }

  if (data.success !== true) {
    throw new Error(data.error || "Server returned success=false");
  }

  if (!Array.isArray(data.results)) {
    throw new Error("Server response missing results array");
  }

  const results = comments.map((text, index) => {
    const item = data.results[index] || {};
    const score = clampScore(item.score);

    return {
      index,
      text,
      score,
      source: item.source || "unknown",
    };
  });

  return {
    success: true,
    results,
  };
}

function clampScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}