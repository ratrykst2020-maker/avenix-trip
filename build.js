
const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");
const { marked } = require("marked");

const ROOT = __dirname;
const DIST = path.join(ROOT, "dist");

marked.setOptions({
  gfm: true,
  breaks: false
});

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function findMarkdownFiles(folder, results = []) {
  if (!fs.existsSync(folder)) return results;

  for (const item of fs.readdirSync(folder, {
    withFileTypes: true
  })) {
    if (
      item.name.startsWith(".") ||
      item.name === "node_modules" ||
      item.name === "dist"
    ) continue;

    const fullPath = path.join(folder, item.name);

    if (item.isDirectory()) {
      findMarkdownFiles(fullPath, results);
    } else if (item.isFile() && item.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }

  return results;
}

function getCategory(file) {
  const relative = path.relative(ROOT, file);
  const firstFolder = relative.split(path.sep)[0];

  return firstFolder === file ? "Travel Guides" :
    firstFolder.replace(/-/g, " ");
}

function pageTemplate({
  title,
  description,
  canonical,
  content,
  jsonLd = ""
}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta name="robots" content="index,follow">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta name="twitter:card" content="summary_large_image">
<style>
*{box-sizing:border-box}
body{margin:0;font-family:Arial,sans-serif;line-height:1.75;color:#263238;background:#fff}
header,footer{background:#142b3b;color:white;padding:20px max(20px,calc((100% - 1050px)/2))}
header a{color:white;text-decoration:none;font-size:22px;font-weight:bold}
main{max-width:900px;margin:35px auto;padding:0 20px}
h1,h2,h3{line-height:1.3;color:#142b3b}
h1{font-size:34px}
a{color:#1769aa}
article{margin:24px 0;padding-bottom:18px;border-bottom:1px solid #ddd}
.post-image{width:100%;height:auto;border-radius:8px}
footer{margin-top:50px}
</style>
${jsonLd ? `<script type="application/ld+json">${jsonLd}</script>` : ""}
</head>
<body>
<header><a href="/">Avenix Trip</a></header>
<main>${content}</main>
<footer>© ${new Date().getFullYear()} Avenix Trip. All rights reserved.</footer>
</body>
</html>`;
}

function build() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  const files = findMarkdownFiles(ROOT);
  const posts = [];
  const usedSlugs = new Set();

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const parsed = matter(source);
    const data = parsed.data || {};

    const title = String(data.title || path.basename(file, ".md"));
    const description = String(data.description || "");
    const slug = slugify(data.slug || path.basename(file, ".md"));
    const category = getCategory(file);

    if (!slug) {
      throw new Error("Missing or invalid slug in " + file);
    }

    if (usedSlugs.has(slug)) {
      throw new Error("Duplicate post slug: " + slug);
    }

    usedSlugs.add(slug);

    const url = `https://avenixpro.com/${slug}/`;
    const image = data.image || "";
    const imageAlt = data.image_alt || title;

    let imageHtml = "";
    if (image) {
      const imageFile = path.join(ROOT, image.replace(/^\/+/, ""));
      if (fs.existsSync(imageFile)) {
        imageHtml = `<img class="post-image" src="${escapeHtml(image)}" alt="${escapeHtml(imageAlt)}">`;
      } else {
        console.warn("Image not found:", image);
      }
    }

    const articleHtml = marked.parse(parsed.content);
    const content = `
<h1>${escapeHtml(title)}</h1>
${imageHtml}
${articleHtml}
<p><a href="/">Back to Avenix Trip</a></p>`;

    const jsonLd = safeJson({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: title,
      description,
      mainEntityOfPage: url,
      author: {
        "@type": "Organization",
        name: "Avenix Trip"
      },
      publisher: {
        "@type": "Organization",
        name: "Avenix Trip"
      },
      ...(image ? { image: `https://avenixpro.com${image}` } : {})
    });

    const outputFolder = path.join(DIST, slug);
    fs.mkdirSync(outputFolder, { recursive: true });

    fs.writeFileSync(
      path.join(outputFolder, "index.html"),
      pageTemplate({
        title: `${title} | Avenix Trip`,
        description,
        canonical: url,
        content,
        jsonLd
      })
    );

    posts.push({
      title,
      description,
      slug,
      category,
      url,
      source: file
    });
  }

  posts.sort((a, b) => a.title.localeCompare(b.title));

  const postLinks = posts.map(post => `
<article>
<h2><a href="/${escapeHtml(post.slug)}/">${escapeHtml(post.title)}</a></h2>
<p>${escapeHtml(post.description)}</p>
<p><small>${escapeHtml(post.category)}</small></p>
<a href="/${escapeHtml(post.slug)}/">Read Full Guide</a>
</article>`).join("\n");

  const homepage = `
<h1>Avenix Trip</h1>
<p>Your Guide to Smarter Travel</p>
<h2>Latest Travel Guides</h2>
${postLinks || "<p>New travel guides are coming soon.</p>"}
`;

  fs.writeFileSync(
    path.join(DIST, "index.html"),
    pageTemplate({
      title: "Avenix Trip | Travel Guides, Flights & Travel Tips",
      description: "Explore flight guides, destination advice, visa information and travel tips with Avenix Trip.",
      canonical: "https://avenixpro.com/",
      content: homepage
    })
  );

  const sitemapUrls = [
    "https://avenixpro.com/",
    ...posts.map(post => post.url)
  ];

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls.map(url => `<url><loc>${escapeHtml(url)}</loc></url>`).join("\n")}
</urlset>`;

  fs.writeFileSync(path.join(DIST, "sitemap.xml"), sitemap);

  fs.writeFileSync(
    path.join(DIST, "robots.txt"),
    "User-agent: *\nAllow: /\n\nSitemap: https://avenixpro.com/sitemap.xml\n"
  );

  fs.writeFileSync(
    path.join(DIST, "404.html"),
    pageTemplate({
      title: "Page Not Found | Avenix Trip",
      description: "The requested page could not be found.",
      canonical: "https://avenixpro.com/404.html",
      content: "<h1>Page Not Found</h1><p>The page you requested does not exist.</p><a href='/'>Return to Homepage</a>"
    })
  );

  const imagesFolder = path.join(ROOT, "images");
  if (fs.existsSync(imagesFolder)) {
    fs.cpSync(imagesFolder, path.join(DIST, "images"), {
      recursive: true
    });
  }

  console.log(`Build complete: ${posts.length} posts generated.`);
}

build();
