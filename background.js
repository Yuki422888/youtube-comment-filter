const ENV = {
  LOCAL: "local",
  PRODUCTION: "production",
};

// 開発時だけ LOCAL に切り替える
const CURRENT_ENV = ENV.PRODUCTION;

const CONFIG = {
  [ENV.LOCAL]: {
    API_BASE_URL: "http://localhost:3000",
    EXTENSION_SHARED_TOKEN: "local_dev_token_change_me",
    DEBUG: true,
  },
  [ENV.PRODUCTION]: {
    API_BASE_URL: "https://youtube-comment-filter-server.onrender.com",
    // 本番値は GitHub に載せないこと
    // ストア提出用ZIPを作る直前にローカルで差し込む運用を推奨
    EXTENSION_SHARED_TOKEN: "SET YOUR TOKEN",
    DEBUG: false,
  },
};

const REQUEST_TIMEOUT_MS = 45000;
const MAX_BATCH_SIZE = 20;
const MAX_COMMENT_LENGTH = 500;
const RESPONSE_CACHE_TTL_MS = 30 * 1000; // 30秒
const inFlightRequests = new Map();
const responseCache = new Map();

function getConfig() {
  return CONFIG[CURRENT_ENV];
}

function debugLog(...args) {
  const { DEBUG } = getConfig();
  if (DEBUG) {
    console.log("[YTCF background]", ...args);
  }
}

function debugWarn(...args) {
  const { DEBUG } = getConfig();
  if (DEBUG) {
    console.warn("[YTCF background]", ...args);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "ANALYZE_COMMENTS_BATCH") {
    return false;
  }

  (async () => {
    try {
      const rawComments = Array.isArray(message.comments) ? message.comments : [];
      const comments = sanitizeComments(rawComments);

      if (comments.length === 0) {
        sendResponse({
          success: false,
          error: "comments must be a non-empty array",
        });
        return;
      }

      const config = getConfig();
      validateConfig(config);

      debugLog("current env =", CURRENT_ENV);
      debugLog("API_BASE_URL =", config.API_BASE_URL);
      debugLog("received batch size =", comments.length);

      const data = await postAnalyzeBatchWithCache(comments);

      if (!data || data.success !== true || !Array.isArray(data.results)) {
        throw new Error("Invalid server response format");
      }

      sendResponse({ success: true, data });
    } catch (error) {
      console.error("[YTCF background] error:", error);
      sendResponse({
        success: false,
        error: toUserSafeErrorMessage(error),
      });
    }
  })();

  return true;
});

function sanitizeComments(rawComments) {
  if (!Array.isArray(rawComments)) return [];

  const cleaned = rawComments
    .map((item) => normalizeComment(item))
    .filter((text) => text.length > 0);

  // サーバー側の上限に合わせる
  return cleaned.slice(0, MAX_BATCH_SIZE);
}

function normalizeComment(value) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";

  if (text.length <= MAX_COMMENT_LENGTH) {
    return text;
  }

  return text.slice(0, MAX_COMMENT_LENGTH);
}

function validateConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("Invalid extension config");
  }

  if (!config.API_BASE_URL || typeof config.API_BASE_URL !== "string") {
    throw new Error("API_BASE_URL is not configured");
  }

  if (
    !config.EXTENSION_SHARED_TOKEN ||
    typeof config.EXTENSION_SHARED_TOKEN !== "string"
  ) {
    throw new Error("EXTENSION_SHARED_TOKEN is not configured");
  }

  if (
    CURRENT_ENV === ENV.PRODUCTION &&
    config.EXTENSION_SHARED_TOKEN === "__SET_PRODUCTION_TOKEN_LOCALLY__"
  ) {
    throw new Error("Production token is not set");
  }
}

async function postAnalyzeBatchWithCache(comments) {
  const cacheKey = createBatchKey(comments);
  const now = Date.now();

  const cached = responseCache.get(cacheKey);
  if (cached && now - cached.timestamp < RESPONSE_CACHE_TTL_MS) {
    debugLog("cache hit");
    return cached.data;
  }

  const inFlight = inFlightRequests.get(cacheKey);
  if (inFlight) {
    debugLog("reusing in-flight request");
    return inFlight;
  }

  const requestPromise = (async () => {
    try {
      const data = await postAnalyzeBatch(comments);

      responseCache.set(cacheKey, {
        timestamp: Date.now(),
        data,
      });

      cleanupExpiredCache();
      return data;
    } finally {
      inFlightRequests.delete(cacheKey);
    }
  })();

  inFlightRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

async function postAnalyzeBatch(comments) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const { API_BASE_URL, EXTENSION_SHARED_TOKEN } = getConfig();
    const url = `${API_BASE_URL}/analyze-batch`;

    const response = await fetch(url, {
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
    if (error?.name === "AbortError") {
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

    return {
      index,
      text,
      score: clampScore(item.score),
      source: typeof item.source === "string" ? item.source : "unknown",
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

function createBatchKey(comments) {
  return JSON.stringify(comments);
}

function cleanupExpiredCache() {
  const now = Date.now();

  for (const [key, value] of responseCache.entries()) {
    if (!value || now - value.timestamp >= RESPONSE_CACHE_TTL_MS) {
      responseCache.delete(key);
    }
  }
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function toUserSafeErrorMessage(error) {
  const message = error?.message || "Unknown background error";

  if (message.includes("Failed to fetch")) {
    return "Network error";
  }

  if (message.includes("Request timed out")) {
    return "Request timed out";
  }

  return message;
}