document.addEventListener("DOMContentLoaded", async () => {
  const toggle = document.getElementById("filterToggle");
  const thresholdSlider = document.getElementById("thresholdSlider");
  const thresholdValue = document.getElementById("thresholdValue");

  const STORAGE_KEYS = {
    FILTER_ENABLED: "filterEnabled",
    THRESHOLD: "threshold"
  };

  const DEFAULTS = {
    filterEnabled: true,
    threshold: 0.5
  };

  const data = await chrome.storage.local.get([
    STORAGE_KEYS.FILTER_ENABLED,
    STORAGE_KEYS.THRESHOLD
  ]);

  const filterEnabled =
    data[STORAGE_KEYS.FILTER_ENABLED] ?? DEFAULTS.filterEnabled;
  const threshold = Number(data[STORAGE_KEYS.THRESHOLD] ?? DEFAULTS.threshold);

  toggle.checked = filterEnabled;
  thresholdSlider.value = String(threshold);
  thresholdValue.textContent = threshold.toFixed(2);

  toggle.addEventListener("change", async () => {
    await chrome.storage.local.set({
      [STORAGE_KEYS.FILTER_ENABLED]: toggle.checked
    });

    console.log("[YTCF popup] filterEnabled =", toggle.checked);
  });

  thresholdSlider.addEventListener("input", () => {
    thresholdValue.textContent = Number(thresholdSlider.value).toFixed(2);
  });

  thresholdSlider.addEventListener("change", async () => {
    const value = Number(thresholdSlider.value);

    await chrome.storage.local.set({
      [STORAGE_KEYS.THRESHOLD]: value
    });

    thresholdValue.textContent = value.toFixed(2);
    console.log("[YTCF popup] threshold =", value);
  });
});