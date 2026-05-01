const ENV = {
    LOCAL: "local",
    DEV: "dev",
    PRODUCTION: "production",
};

// ==============================
// 重要:
// - 開発版拡張をローカル読み込みで試す間は DEV にする
// - 本番パッケージを作る直前だけ PRODUCTION にする
// ==============================
const CURRENT_ENV = ENV.PRODUCTION;;

const CONFIG = {
    [ENV.LOCAL]: {
        API_BASE_URL: "http://localhost:3000",
        DEBUG: true,
        ENV_NAME: "LOCAL",
    },
    [ENV.DEV]: {
        API_BASE_URL: "https://youtube-comment-filter-server-dev.onrender.com",
        DEBUG: true,
        ENV_NAME: "DEV",
    },
    [ENV.PRODUCTION]: {
        API_BASE_URL: "https://youtube-comment-filter-server.onrender.com",
        DEBUG: false,
        ENV_NAME: "PRODUCTION",
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

            debugLog("current env =", config.ENV_NAME);
            debugLog("API_BASE_URL =", config.API_BASE_URL);
            debugLog("received batch size =", comments.length);

            const data = await postAnalyzeBatch(comments);

            sendResponse({
                success: true,
                data,
            });
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

    /*if (
        !config.EXTENSION_SHARED_TOKEN ||
        typeof config.EXTENSION_SHARED_TOKEN !== "string"
    ) {
        throw new Error("EXTENSION_SHARED_TOKEN is not configured");
    }
    */

    
}

async function postAnalyzeBatch(comments) {
    cleanupExpiredCache();

    const batchKey = createBatchKey(comments);

    const cached = responseCache.get(batchKey);
    if (cached && Date.now() - cached.timestamp < RESPONSE_CACHE_TTL_MS) {
        debugLog("cache hit");
        return cached.data;
    }

    const existingRequest = inFlightRequests.get(batchKey);
    if (existingRequest) {
        debugLog("reusing in-flight request");
        return existingRequest;
    }

    const requestPromise = (async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const { API_BASE_URL } = getConfig();

            const response = await fetch(`${API_BASE_URL}/analyze-batch`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
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

            const rawData = await response.json();
            const normalized = normalizeAnalyzeResponse(rawData, comments);

            responseCache.set(batchKey, {
                data: normalized,
                timestamp: Date.now(),
            });

            return normalized;
        } catch (error) {
            if (error?.name === "AbortError") {
                throw new Error("Request timed out");
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
            inFlightRequests.delete(batchKey);
        }
    })();

    inFlightRequests.set(batchKey, requestPromise);
    return requestPromise;
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