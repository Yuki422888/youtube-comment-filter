console.log("YouTube Comment Filter loaded");

const NG_WORDS = ["バカ", "死ね", "きもい"];

function filterComments() {
  const commentElements = document.querySelectorAll("#content-text");

  commentElements.forEach((comment) => {
    const text = comment.innerText;

    const hasNgWord = NG_WORDS.some((word) => text.includes(word));

    if (hasNgWord) {
      comment.style.opacity = "0.2";
      comment.style.border = "2px solid red";
      comment.style.padding = "4px";
    }
  });
}

// YouTubeはコメントがあとから読み込まれることがあるので少し待って実行
setInterval(filterComments, 2000);
