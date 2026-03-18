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
  const BATCH_DELAY_MS = 500;
  const MAX_SESSION_CACHE_ENTRIES = 500;

  const RETRY_DELAYS_MS = [5000, 15000, 30000];

  let analyzeQueue = [];
  let queueTimer = null;

  let filterEnabled = DEFAULTS.filterEnabled;
  let threshold = DEFAULTS.threshold;

  const scoreCache = new Map();
  const commentMap = new WeakMap();
  const videoScores = [];

  let toxicScoreBox = null;
  let observer = null;

  if (window.__YTCF_INITIALIZED__) return;
  window.__YTCF_INITIALIZED__ = true;

  init();

  async function init() {
    injectStyles();
    restoreSessionCache();
    await loadSettings();
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

    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        onPageChanged();
      } else {
        ensureToxicScoreBox();
      }
    }, 1000);
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

  function onPageChanged() {
    analyzeQueue = [];
    clearTimeout(queueTimer);
    queueTimer = null;

    videoScores.length = 0;

    if (toxicScoreBox && toxicScoreBox.isConnected) {
      toxicScoreBox.remove();
    }
    toxicScoreBox = null;

    document.querySelectorAll("ytd-comment-thread-renderer").forEach((thread) => {
      delete thread.dataset.ytcfInitialized;
    });

    ensureToxicScoreBox();
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
        padding: 10px 12px;
        border-radius: 10px;
        background: rgba(0, 0, 0, 0.75);
        color: #fff;
        font-size: 13px;
        line-height: 1.5;
      }

      .ytcf-score-title {
        font-weight: bold;
        margin-bottom: 6px;
      }

      .ytcf-score-muted {
        opacity: 0.85;
        font-size: 12px;
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

  function ensureToxicScoreBox() {
    const commentsSection = findCommentsSection();
    if (!commentsSection) {
      console.log("[YTCF] comments section not found yet");
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
      <div class="ytcf-score-title">Video Toxicity</div>
      <div id="ytcf-score-value">Analyzing...</div>
      <div id="ytcf-score-meta" class="ytcf-score-muted">No analyzed comments yet</div>
    `;

    commentsSection.prepend(toxicScoreBox);
    console.log("[YTCF] Toxic score box created");
    updateToxicScoreBox();
  }

  function updateToxicScoreBox() {
    ensureToxicScoreBox();
    if (!toxicScoreBox || !toxicScoreBox.isConnected) return;

    const valueEl = toxicScoreBox.querySelector("#ytcf-score-value");
    const metaEl = toxicScoreBox.querySelector("#ytcf-score-meta");
    if (!valueEl || !metaEl) return;

    if (videoScores.length === 0) {
      valueEl.textContent = "Analyzing...";
      metaEl.textContent = "No analyzed comments yet";
      return;
    }

    const avg = videoScores.reduce((sum, s) => sum + s, 0) / videoScores.length;
    const highRiskCount = videoScores.filter((s) => s >= threshold).length;
    const ratio = Math.round((highRiskCount / videoScores.length) * 100);

    valueEl.textContent = `${avg.toFixed(2)} (${getRiskLabel(avg)})`;
    metaEl.textContent = `Analyzed: ${videoScores.length} comments | Toxic(>=${threshold.toFixed(
      2
    )}): ${ratio}%`;
  }

  function getRiskLabel(score) {
    if (score < 0.2) return "Healthy";
    if (score < 0.35) return "Slightly Toxic";
    if (score < 0.5) return "Toxic";
    return "Dangerous";
  }

  function startObserver() {
    if (observer) observer.disconnect();

    observer = new MutationObserver(() => {
      ensureToxicScoreBox();
      scanComments();
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

    const text = normalizeText(textEl.innerText || textEl.textContent || "");
    if (!text) return;

    const placeholder = ensurePlaceholder(thread, textEl);

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
      console.log("[YTCF] cache hit:", { text, score: cachedScore });
      applyScore(commentData, cachedScore, true);
      return;
    }

    enqueueComment(commentData);
  }

  function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  function ensurePlaceholder(thread, textEl) {
    let placeholder = thread.querySelector(".ytcf-placeholder");
    if (placeholder) return placeholder;

    placeholder = document.createElement("div");
    placeholder.className = "ytcf-placeholder";
    placeholder.textContent = "Analyzing comment...";
    textEl.insertAdjacentElement("afterend", placeholder);
    return placeholder;
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
    placeholder.textContent = "Analyzing comment...";
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
    placeholder.textContent = message || "Server waking up... retrying soon";
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
      videoScores.push(score);
      commentData.countedInVideoScore = true;
      updateToxicScoreBox();
    }

    console.log("[YTCF] applyScore:", {
      text: commentData.text,
      score,
      threshold,
      filterEnabled,
    });

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

    threads.forEach((thread) => {
      const commentData = commentMap.get(thread);
      if (!commentData) return;

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
  }

  function enqueueComment(commentData) {
    if (commentData.queued || commentData.score != null) return;

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
        console.log("[YTCF] pre-send cache hit:", {
          text: item.text,
          score: cachedScore,
        });
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

    console.log("[YTCF] flushQueue texts:", uncachedTexts);

    try {
      const response = await sendBatchForAnalysis(uncachedTexts);

      console.log("[YTCF] batch response:", response);

      if (!response || !Array.isArray(response.results)) {
        throw new Error("Invalid analyze-batch response");
      }

      response.results.forEach((result, index) => {
        const commentData = uncachedItems[index];
        if (!commentData) return;

        const rawScore = result?.score;
        const score = Number.isFinite(Number(rawScore)) ? Number(rawScore) : 0;

        console.log("[YTCF] score result:", {
          text: commentData.text,
          result,
          score,
        });

        setCachedScore(commentData.text, score);
        clearRetry(commentData);
        applyScore(commentData, score, true);
      });
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

    setUnknownState(commentData, "Analysis unavailable");
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
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: "ANALYZE_COMMENTS_BATCH",
          comments: texts,
        },
        (response) => {
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

  function setCachedScore(text, score) {
    if (!text) return;
    scoreCache.set(text, score);
    persistSessionCache();
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

      console.log("[YTCF] restored session cache entries:", scoreCache.size);
    } catch (error) {
      console.warn("[YTCF] failed to restore session cache:", error);
    }
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
})();
