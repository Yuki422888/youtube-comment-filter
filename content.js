(() => {
  "use strict";

  const STORAGE_KEYS = {
    FILTER_ENABLED: "filterEnabled",
    THRESHOLD: "threshold",
  };

  const DEFAULTS = {
    filterEnabled: true,
    threshold: 0.5,
  };

  const CACHE_KEYS = {
    SCORE_CACHE: "ytcf_score_cache_v1",
  };

  const MAX_BATCH_SIZE = 20;
  const BATCH_DELAY_MS = 350;
  const MAX_SESSION_CACHE_ENTRIES = 500;
  const CACHE_PERSIST_DELAY_MS = 1000;

  const RETRY_DELAYS_MS = [5000, 15000, 30000];

  let analyzeQueue = [];
  let queueTimer = null;

  let filterEnabled = DEFAULTS.filterEnabled;
  let threshold = DEFAULTS.threshold;

  const scoreCache = new Map();
  const commentMap = new WeakMap();

  let toxicScoreBox = null;
  let observer = null;

  let statusBanner = null;
  let wakeupTimer = null;
  let longWaitTimer = null;
  let activeRequests = 0;

  let cachePersistTimer = null;
  let ensureScoreBoxTimer = null;
  let pageWatchTimer = null;

  let currentVideoId = "";
  let lastKnownUrl = location.href;

  let videoScoreSum = 0;
  let videoScoreCount = 0;
  let videoHighRiskCount = 0;

  if (window.__YTCF_INITIALIZED__) return;
  window.__YTCF_INITIALIZED__ = true;

  init();

  async function init() {
    injectStyles();
    restoreSessionCache();
    await loadSettings();

    currentVideoId = getCurrentVideoId();
    ensureToxicScoreBox();
    startObserver();
    scanComments();

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;

      let shouldReapply = false;

      if (changes[STORAGE_KEYS.FILTER_ENABLED]) {
        filterEnabled =
          changes[STORAGE_KEYS.FILTER_ENABLED].newValue ?? DEFAULTS.filterEnabled;
        shouldReapply = true;
      }

      if (changes[STORAGE_KEYS.THRESHOLD]) {
        threshold = Number(
          changes[STORAGE_KEYS.THRESHOLD].newValue ?? DEFAULTS.threshold
        );
        shouldReapply = true;
      }

      if (shouldReapply) {
        console.log("[YTCF] settings updated:", { filterEnabled, threshold });
        reapplyAllCommentStates();
        updateToxicScoreBox();
      }
    });

    startPageWatcher();
  }

  async function loadSettings() {
    const data = await chrome.storage.local.get([
      STORAGE_KEYS.FILTER_ENABLED,
      STORAGE_KEYS.THRESHOLD,
    ]);

    filterEnabled = data[STORAGE_KEYS.FILTER_ENABLED] ?? DEFAULTS.filterEnabled;
    threshold = Number(data[STORAGE_KEYS.THRESHOLD] ?? DEFAULTS.threshold);

    console.log("[YTCF] initial settings:", { filterEnabled, threshold });
  }

  function startPageWatcher() {
    if (pageWatchTimer) {
      clearInterval(pageWatchTimer);
    }

    pageWatchTimer = setInterval(() => {
      const currentUrl = location.href;
      const videoId = getCurrentVideoId();

      if (currentUrl !== lastKnownUrl || videoId !== currentVideoId) {
        lastKnownUrl = currentUrl;
        currentVideoId = videoId;
        onPageChanged();
        return;
      }

      scheduleEnsureToxicScoreBox();
    }, 1500);
  }

  function getCurrentVideoId() {
    try {
      return new URL(location.href).searchParams.get("v") || "";
    } catch {
      return "";
    }
  }

  function onPageChanged() {
    analyzeQueue = [];
    clearTimeout(queueTimer);
    queueTimer = null;

    resetVideoScoreStats();

    hideStatusBanner(true);
    activeRequests = 0;

    if (toxicScoreBox && toxicScoreBox.isConnected) {
      toxicScoreBox.remove();
    }
    toxicScoreBox = null;

    document.querySelectorAll("ytd-comment-thread-renderer").forEach((thread) => {
      delete thread.dataset.ytcfInitialized;
    });

    scheduleEnsureToxicScoreBox();
    scanComments();
  }

  function injectStyles() {
   if (document.getElementById("ytcf-styles")) return;

   const style = document.createElement("style");
   style.id = "ytcf-styles";
   style.textContent = `
     .ytcf-pending-text {
       display: none !important;
     }

     .ytcf-hidden-text {
       display: none !important;
     }

     .ytcf-placeholder {
       font-size: 12px;
       color: #888;
       margin-top: 4px;
       line-height: 1.4;
     }

     .ytcf-placeholder.hidden {
       color: #ff8a80;
     }

     .ytcf-placeholder.warning {
       color: #ffd180;
     }

     .ytcf-score-box {
       position: sticky;
       top: 0;
       z-index: 9999;
       margin: 12px 0;
       padding: 12px 14px;
       border-radius: 12px;
       background: rgba(0, 0, 0, 0.78);
       color: #fff;
       font-size: 13px;
       line-height: 1.5;
       backdrop-filter: blur(6px);
     }

     .ytcf-score-title {
       font-weight: 700;
       margin-bottom: 8px;
       font-size: 12px;
       letter-spacing: 0.02em;
       opacity: 0.9;
     }

     .ytcf-score-badge {
       display: inline-flex;
       align-items: center;
       gap: 6px;
       padding: 6px 10px;
       border-radius: 999px;
       font-size: 14px;
       font-weight: 700;
       line-height: 1.2;
       margin-bottom: 8px;
     }

     .ytcf-score-badge.safe {
       background: rgba(76, 175, 80, 0.22);
       color: #b9f6ca;
     }

     .ytcf-score-badge.caution {
       background: rgba(255, 235, 59, 0.18);
       color: #fff59d;
     }

     .ytcf-score-badge.risky {
       background: rgba(255, 152, 0, 0.20);
       color: #ffd180;
     }

     .ytcf-score-badge.danger {
       background: rgba(244, 67, 54, 0.22);
       color: #ffab91;
     }

     .ytcf-score-summary {
       font-size: 14px;
       font-weight: 600;
       margin-bottom: 4px;
     }

     .ytcf-score-meta {
       opacity: 0.85;
       font-size: 12px;
     }

     .ytcf-status-banner {
       position: fixed;
       top: 16px;
       right: 16px;
       z-index: 2147483647;
       max-width: 320px;
       padding: 10px 14px;
       border-radius: 10px;
       background: rgba(0, 0, 0, 0.88);
       color: #fff;
       font-size: 13px;
       line-height: 1.5;
       box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
     }

     .ytcf-status-banner strong {
       display: block;
       margin-bottom: 2px;
     }
   `;
   document.head.appendChild(style);
 }

  function findCommentsSection() {
    return (
      document.querySelector("ytd-comments#comments") ||
      document.querySelector("#comments") ||
      document.querySelector("ytd-item-section-renderer #contents")
    );
  }

  function scheduleEnsureToxicScoreBox() {
    if (ensureScoreBoxTimer) return;

    ensureScoreBoxTimer = setTimeout(() => {
      ensureScoreBoxTimer = null;
      ensureToxicScoreBox();
    }, 100);
  }

  function ensureToxicScoreBox() {
   const commentsSection = findCommentsSection();
   if (!commentsSection) {
     return;
   }

   if (toxicScoreBox && toxicScoreBox.isConnected) {
     return;
   }

   const existing = document.getElementById("ytcf-score-box");
   if (existing) {
     toxicScoreBox = existing;
     updateToxicScoreBox();
     return;
   }

   toxicScoreBox = document.createElement("div");
   toxicScoreBox.id = "ytcf-score-box";
   toxicScoreBox.className = "ytcf-score-box";
   toxicScoreBox.innerHTML = `
     <div class="ytcf-score-title">Comment Safety</div>
     <div id="ytcf-score-value" class="ytcf-score-summary">Checking comments...</div>
     <div id="ytcf-score-meta" class="ytcf-score-meta">No analyzed comments yet</div>
   `;

   commentsSection.prepend(toxicScoreBox);
   updateToxicScoreBox();
 }

  function resetVideoScoreStats() {
    videoScoreSum = 0;
    videoScoreCount = 0;
    videoHighRiskCount = 0;
  }

  function updateToxicScoreBox() {
   ensureToxicScoreBox();
   if (!toxicScoreBox || !toxicScoreBox.isConnected) return;

   const valueEl = toxicScoreBox.querySelector("#ytcf-score-value");
   const metaEl = toxicScoreBox.querySelector("#ytcf-score-meta");
   if (!valueEl || !metaEl) return;

   if (videoScoreCount === 0) {
     valueEl.textContent = "Checking comments...";
     metaEl.textContent = "No analyzed comments yet";
     return;
   }

   const avg = videoScoreSum / videoScoreCount;
   const toxicPercent = Math.round((videoHighRiskCount / videoScoreCount) * 100);
   const risk = getRiskLabel(avg, toxicPercent);

   valueEl.innerHTML = `
     <div class="ytcf-score-badge ${risk.tone}">
       <span>${risk.emoji}</span>
       <span>${risk.text}</span>
     </div>
     <div class="ytcf-score-summary">
       ${toxicPercent}% of checked comments were flagged
     </div>
   `;

   metaEl.textContent =
     `Checked: ${videoScoreCount} comments · Avg score: ${avg.toFixed(2)} · Threshold:    ${threshold.toFixed(2)}`;
 }

  function getRiskLabel(avgScore, toxicPercent) {
   if (toxicPercent >= 40 || avgScore >= 0.50) {
     return {
       emoji: "🔴",
       text: "Dangerous discussion",
       tone: "danger",
     };
   }

   if (toxicPercent >= 25 || avgScore >= 0.35) {
     return {
       emoji: "🟠",
       text: "Risky discussion",
       tone: "risky",
     };
   }

   if (toxicPercent >= 10 || avgScore >= 0.20) {
     return {
       emoji: "🟡",
       text: "Use caution",
       tone: "caution",
     };
   }

   return {
     emoji: "🟢",
     text: "Mostly safe",
     tone: "safe",
   };
 }

  function startObserver() {
    if (observer) observer.disconnect();

    observer = new MutationObserver((mutations) => {
      let sawPossibleCommentAreaChange = false;

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;

          if (node.matches?.("ytd-comment-thread-renderer")) {
            processCommentThread(node);
            sawPossibleCommentAreaChange = true;
          }

          const nestedThreads = node.querySelectorAll?.("ytd-comment-thread-renderer");
          if (nestedThreads && nestedThreads.length > 0) {
            nestedThreads.forEach((thread) => processCommentThread(thread));
            sawPossibleCommentAreaChange = true;
          }

          if (
            node.id === "comments" ||
            node.matches?.("ytd-comments, ytd-comments#comments")
          ) {
            sawPossibleCommentAreaChange = true;
          }
        }
      }

      if (sawPossibleCommentAreaChange) {
        scheduleEnsureToxicScoreBox();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function scanComments() {
    const commentThreads = document.querySelectorAll("ytd-comment-thread-renderer");
    commentThreads.forEach((thread) => {
      processCommentThread(thread);
    });
  }

 function processCommentThread(thread) {
  if (!thread) return;
  if (thread.dataset.ytcfInitialized === "true") return;

  const textEl = thread.querySelector("#content-text");
  if (!textEl) return;

  const rawText = textEl.textContent || "";
  const text = normalizeText(rawText);
  if (!text) return;

  const placeholder = ensurePlaceholder(thread, textEl);
  if (!placeholder) return;

  const commentData = {
    thread,
    textEl,
    placeholder,
    text,
    state: "pending",
    score: null,
    queued: false,
    countedInVideoScore: false,
    retryCount: 0,
    retryTimer: null,
  };

  commentMap.set(thread, commentData);
  thread.dataset.ytcfInitialized = "true";

  if (filterEnabled) {
    setPendingState(commentData);
  } else {
    setSafeState(commentData);
  }

  const cachedScore = getCachedScore(text);
  if (cachedScore != null) {
    applyScore(commentData, cachedScore, true);
    return;
  }

  enqueueComment(commentData);
}

  function normalizeText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function ensurePlaceholder(thread, textEl) {
  　if (!thread || !textEl) return null;

  　let placeholder = thread.querySelector(".ytcf-placeholder");
  　if (placeholder) return placeholder;

  　placeholder = document.createElement("div");
  　placeholder.className = "ytcf-placeholder";
    placeholder.textContent = "Checking comment safety...";
  　textEl.insertAdjacentElement("afterend", placeholder);
  　return placeholder;
　}

  function showStatusBanner(title, message) {
    if (!statusBanner) {
      statusBanner = document.createElement("div");
      statusBanner.id = "ytcf-status-banner";
      statusBanner.className = "ytcf-status-banner";
      document.body.appendChild(statusBanner);
    }

    statusBanner.innerHTML = `<strong>${escapeHtml(title)}</strong>${escapeHtml(
      message
    )}`;
  }

  function hideStatusBanner(force = false) {
    if (wakeupTimer) {
      clearTimeout(wakeupTimer);
      wakeupTimer = null;
    }

    if (longWaitTimer) {
      clearTimeout(longWaitTimer);
      longWaitTimer = null;
    }

    if ((force || activeRequests === 0) && statusBanner) {
      statusBanner.remove();
      statusBanner = null;
    }
  }

  function startWakeupNotice() {
  　if (activeRequests !== 1) return;

  　hideStatusBanner(true);

  　wakeupTimer = setTimeout(() => {
    　showStatusBanner(
      　"Preparing comment filter...",
      　"The server may be waking up. The first check can take a few seconds."
    　);
  　}, 2000);

  　longWaitTimer = setTimeout(() => {
    　showStatusBanner(
      　"Still checking comments...",
      　"Thanks for waiting. Free hosting can be slower on the first request."
    　);
  　}, 10000);
　}

　function setPendingState(commentData) {
  　const { textEl, placeholder } = commentData;
  　commentData.state = "pending";

  　if (!filterEnabled) {
    　textEl.classList.remove("ytcf-pending-text", "ytcf-hidden-text");
    　placeholder.style.display = "none";
    　return;
  　}

  　textEl.classList.add("ytcf-pending-text");
  　textEl.classList.remove("ytcf-hidden-text");

  　placeholder.style.display = "block";
  　placeholder.classList.remove("hidden", "warning");
  　placeholder.textContent = "Checking comment...";
　}

  function setSafeState(commentData) {
    const { textEl, placeholder } = commentData;

    commentData.state = "safe";
    textEl.classList.remove("ytcf-pending-text", "ytcf-hidden-text");
    placeholder.style.display = "none";
  }

  function setHiddenState(commentData) {
    const { textEl, placeholder } = commentData;

    commentData.state = "hidden";
    textEl.classList.add("ytcf-hidden-text");
    textEl.classList.remove("ytcf-pending-text");

    placeholder.style.display = "block";
    placeholder.classList.remove("warning");
    placeholder.classList.add("hidden");
    placeholder.textContent = "Filtered comment";
  }

  function setRetryState(commentData, message) {
  　const { textEl, placeholder } = commentData;
  　commentData.state = "retrying";

  　textEl.classList.add("ytcf-pending-text");
  　textEl.classList.remove("ytcf-hidden-text");

  　placeholder.style.display = "block";
  　placeholder.classList.remove("hidden");
  　placeholder.classList.add("warning");
  　placeholder.textContent = message || "Still checking comment...";
　}

  function setUnknownState(commentData, message) {
    const { textEl, placeholder } = commentData;

    commentData.state = "unknown";
    textEl.classList.add("ytcf-pending-text");
    textEl.classList.remove("ytcf-hidden-text");

    placeholder.style.display = "block";
    placeholder.classList.remove("hidden");
    placeholder.classList.add("warning");
    placeholder.textContent = message || "Could not analyze comment";
  }

  function applyScore(commentData, score, allowCount = true) {
    commentData.score = score;

    if (allowCount && !commentData.countedInVideoScore) {
      videoScoreSum += score;
      videoScoreCount += 1;
      if (score >= threshold) {
        videoHighRiskCount += 1;
      }
      commentData.countedInVideoScore = true;
      updateToxicScoreBox();
    }

    if (!filterEnabled) {
      setSafeState(commentData);
      return;
    }

    if (score >= threshold) {
      setHiddenState(commentData);
    } else {
      setSafeState(commentData);
    }
  }

  function reapplyAllCommentStates() {
    const threads = document.querySelectorAll("ytd-comment-thread-renderer");

    let recomputedSum = 0;
    let recomputedCount = 0;
    let recomputedHighRiskCount = 0;

    threads.forEach((thread) => {
      const commentData = commentMap.get(thread);
      if (!commentData) return;

      if (commentData.score != null) {
        recomputedSum += commentData.score;
        recomputedCount += 1;
        if (commentData.score >= threshold) {
          recomputedHighRiskCount += 1;
        }
      }

      if (!filterEnabled) {
        setSafeState(commentData);
        return;
      }

      if (commentData.score == null) {
        if (commentData.state === "unknown") {
          setUnknownState(commentData, "Analysis unavailable");
        } else if (commentData.state === "retrying") {
          setRetryState(commentData, "Server waking up... retrying soon");
        } else {
          setPendingState(commentData);
        }
      } else if (commentData.score >= threshold) {
        setHiddenState(commentData);
      } else {
        setSafeState(commentData);
      }
    });

    videoScoreSum = recomputedSum;
    videoScoreCount = recomputedCount;
    videoHighRiskCount = recomputedHighRiskCount;
  }

  function enqueueComment(commentData) {
    if (!commentData || commentData.queued || commentData.score != null) return;

    commentData.queued = true;
    analyzeQueue.push(commentData);

    if (!queueTimer) {
      queueTimer = setTimeout(flushQueue, BATCH_DELAY_MS);
    }
  }

  async function flushQueue() {
    queueTimer = null;

    if (analyzeQueue.length === 0) return;

    const batch = analyzeQueue.splice(0, MAX_BATCH_SIZE);
    batch.forEach((item) => {
      item.queued = false;
    });

    const uncachedItems = [];
    const uncachedTexts = [];

    for (const item of batch) {
      const cachedScore = getCachedScore(item.text);

      if (cachedScore != null) {
        applyScore(item, cachedScore, true);
      } else {
        uncachedItems.push(item);
        uncachedTexts.push(item.text);
      }
    }

    if (uncachedItems.length === 0) {
      if (analyzeQueue.length > 0) {
        queueTimer = setTimeout(flushQueue, BATCH_DELAY_MS);
      }
      return;
    }

    try {
      const response = await sendBatchForAnalysis(uncachedTexts);

      if (!response || !Array.isArray(response.results)) {
        throw new Error("Invalid analyze-batch response");
      }

      let didUpdateCache = false;

      response.results.forEach((result, index) => {
        const commentData = uncachedItems[index];
        if (!commentData) return;

        const rawScore = result?.score;
        const score = Number.isFinite(Number(rawScore)) ? Number(rawScore) : 0;

        setCachedScore(commentData.text, score, false);
        didUpdateCache = true;

        clearRetry(commentData);
        applyScore(commentData, score, true);
      });

      if (didUpdateCache) {
        schedulePersistSessionCache();
      }
    } catch (error) {
      console.error("[YTCF] analyze-batch error:", error);

      uncachedItems.forEach((commentData) => {
        handleAnalysisFailure(commentData, error);
      });
    }

    if (analyzeQueue.length > 0) {
      queueTimer = setTimeout(flushQueue, BATCH_DELAY_MS);
    }
  }

  function handleAnalysisFailure(commentData, error) {
    const delay = RETRY_DELAYS_MS[commentData.retryCount];

    if (delay != null) {
      commentData.retryCount += 1;
      setRetryState(
        commentData,
        `Server waking up... retry ${commentData.retryCount}/${RETRY_DELAYS_MS.length}`
      );

      scheduleRetry(commentData, delay);
      return;
    }

    const message =
      error && /401|Unauthorized/i.test(String(error.message || error))
        ? "Authentication failed"
        : "Analysis unavailable";

    setUnknownState(commentData, message);
  }

  function scheduleRetry(commentData, delayMs) {
    clearRetry(commentData);

    commentData.retryTimer = setTimeout(() => {
      commentData.retryTimer = null;
      enqueueComment(commentData);
    }, delayMs);
  }

  function clearRetry(commentData) {
    if (commentData.retryTimer) {
      clearTimeout(commentData.retryTimer);
      commentData.retryTimer = null;
    }
  }

  function sendBatchForAnalysis(texts) {
    activeRequests += 1;
    startWakeupNotice();

    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: "ANALYZE_COMMENTS_BATCH",
          comments: texts,
        },
        (response) => {
          activeRequests = Math.max(0, activeRequests - 1);
          if (activeRequests === 0) {
            hideStatusBanner();
          }

          if (chrome.runtime.lastError) {
            console.error("[YTCF] runtime.lastError:", chrome.runtime.lastError);
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          if (!response) {
            reject(new Error("No response from background"));
            return;
          }

          if (response.success !== true) {
            reject(new Error(response.error || "Unknown background error"));
            return;
          }

          resolve(response.data);
        }
      );
    });
  }

  function getCachedScore(text) {
    if (!text) return null;
    if (scoreCache.has(text)) {
      return scoreCache.get(text);
    }
    return null;
  }

  function setCachedScore(text, score, persistNow = true) {
    if (!text) return;
    scoreCache.set(text, score);

    if (persistNow) {
      schedulePersistSessionCache();
    }
  }

  function restoreSessionCache() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEYS.SCORE_CACHE);
      if (!raw) return;

      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return;

      Object.entries(obj).forEach(([text, score]) => {
        const num = Number(score);
        if (Number.isFinite(num)) {
          scoreCache.set(text, num);
        }
      });
    } catch (error) {
      console.warn("[YTCF] failed to restore session cache:", error);
    }
  }

  function schedulePersistSessionCache() {
    if (cachePersistTimer) return;

    cachePersistTimer = setTimeout(() => {
      cachePersistTimer = null;
      persistSessionCache();
    }, CACHE_PERSIST_DELAY_MS);
  }

  function persistSessionCache() {
    try {
      const entries = Array.from(scoreCache.entries());
      const trimmedEntries =
        entries.length > MAX_SESSION_CACHE_ENTRIES
          ? entries.slice(entries.length - MAX_SESSION_CACHE_ENTRIES)
          : entries;

      const obj = Object.fromEntries(trimmedEntries);
      sessionStorage.setItem(CACHE_KEYS.SCORE_CACHE, JSON.stringify(obj));
    } catch (error) {
      console.warn("[YTCF] failed to persist session cache:", error);
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();