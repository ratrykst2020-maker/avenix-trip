
const fs = require("fs");
const path = require("path");

const postsDir = "flight-guides";
const outputDir = "flight-guides";

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function markdownToHtml(markdown) {
  return markdown
    .replace(/^### (.*$)/gm, "<h3>$1</h3>")
    .replace(/^## (.*$)/gm, "<h2>$1</h2>")
    .replace(/^# (.*$)/gm, "<h1>$1</h1>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .split(/\n\s*\n/)
    .map(block => {
      block = block.trim();
      if (!block) return "";
      if (/^<h[1-3]>/.test(block)) return block;
      return `<p>${block.replace(/\n/g, " ")}</p>`;
    })
    .join("\n");
}

fs.readdirSync(postsDir)
  .filter(file => file.endsWith(".md"))
  .forEach(file => {
    const source = fs.readFileSync(path.join(postsDir, file), "utf8");
    const title = file.replace(".md", "").replace(/-/g, " ");
    const html = markdownToHtml(source);

    const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} | Avenix Trip</title>
</head>
<body>
<header><a href="/">Avenix Trip</a></header>
<main>${html}</main>
<footer>© 2026 Avenix Trip</footer>
</body>
</html>`;

    const outputFile = file.replace(".md", ".html");
    fs.writeFileSync(path.join(outputDir, outputFile), page);
  });
