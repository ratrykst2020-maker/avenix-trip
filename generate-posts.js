
const fs = require("fs");
const path = require("path");

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-3.8-flash";
const API_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const DAILY_POSTS = 20;
const ROOT = process.cwd();

const CATEGORIES = [
  "flight-guides",
  "visa-guides",
  "destination-guides",
  "travel-tips"
];

if (!API_KEY) {
  throw new Error("GEMINI_API_KEY is missing in GitHub Secrets.");
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function getMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];

  let files = [];

  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);

    if (item.isDirectory()) {
      files = files.concat(getMarkdownFiles(full));
    } else if (item.isFile() && item.name.endsWith(".md")) {
      files.push(full);
    }
  }

  return files;
}

function getExistingTitles() {
  const files = getMarkdownFiles(ROOT);
  const titles = [];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const match = content.match(/^title:\s*["']?(.*?)["']?\s*$/m);

    if (match) titles.push(match[1].replace(/["']/g, ""));
    else {
      const heading = content.match(/^#\s+(.+)$/m);
      if (heading) titles.push(heading[1]);
    }
  }

  return [...new Set(titles)];
}

function getExistingSlugs() {
  return new Set(
    getMarkdownFiles(ROOT).map(file =>
      path.basename(file, ".md")
    )
  );
}

let lastRequestAt = 0;

async function callGemini(prompt, schema, maxTokens = 5000) {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < 7000) await sleep(7000 - elapsed);

  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(`${API_URL}?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          temperature: 0.7,
          responseMimeType: "application/json",
          responseSchema: schema,
          maxOutputTokens: maxTokens
        }
      })
    });

    lastRequestAt = Date.now();

    if (response.ok) {
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join("");

      if (!text) throw new Error("Gemini returned an empty response.");

      return JSON.parse(text);
    }

    const errorText = await response.text();

    if (
      (response.status === 429 || response.status >= 500) &&
      attempt < 4
    ) {
      console.log(`Gemini temporary error. Retry ${attempt}/3.`);
      await sleep(30000 * attempt);
      continue;
    }

    throw new Error(`Gemini API error ${response.status}: ${errorText}`);
  }

  throw new Error("Gemini request failed after retries.");
}

const topicSchema = {
  type: "OBJECT",
  properties: {
    topics: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          slug: { type: "STRING" },
          category: { type: "STRING" },
          focus_keyword: { type: "STRING" }
        },
        required: ["title", "slug", "category", "focus_keyword"]
      }
    }
  },
  required: ["topics"]
};

const articleSchema = {
  type: "OBJECT",
  properties: {
    description: { type: "STRING" },
    focus_keyword: { type: "STRING" },
    article_markdown: { type: "STRING" }
  },
  required: ["description", "focus_keyword", "article_markdown"]
};

async function main() {
  const existingTitles = getExistingTitles();
  const existingSlugs = getExistingSlugs();

  console.log("Planning new Avenix Trip articles...");

  const plannerPrompt = `
You are the editorial planner for Avenix Trip, an international travel guide website.

Create exactly ${DAILY_POSTS} distinct, useful, evergreen article ideas.

Existing article titles (avoid duplicates and close variations):
${existingTitles.join("\n")}

Allowed categories:
${CATEGORIES.join(", ")}

Rules:
- Focus on international travel, flights, airports, destinations,
  travel planning, accommodation, transport and visa preparation.
- Avoid invented visa rules, fees, current prices or airline policies.
- Prefer topics that can be answered with reliable general guidance.
- Do not create thin, repetitive or misleading topics.
- Every title must be meaningfully different.
- Use a short, readable, lowercase URL slug.
- Choose one allowed category for each topic.
- Return exactly ${DAILY_POSTS} topics.
`;

  const plan = await callGemini(
    plannerPrompt,
    topicSchema,
    4000
  );

  const topics = (plan.topics || [])
    .map(topic => ({
      ...topic,
      slug: slugify(topic.slug || topic.title),
      category: CATEGORIES.includes(topic.category)
        ? topic.category
        : "travel-tips"
    }))
    .filter(topic =>
      topic.title &&
      topic.slug &&
      topic.focus_keyword &&
      !existingSlugs.has(topic.slug)
    );

  console.log(`New topics available: ${topics.length}`);

  let created = 0;

  for (const topic of topics.slice(0, DAILY_POSTS)) {
    console.log(`Writing: ${topic.title}`);

    try {
      const prompt = `
Write a high-quality English travel guide for Avenix Trip.

Article title: ${topic.title}
Primary keyword: ${topic.focus_keyword}

Requirements:
- Aim for approximately 800–1,000 useful words.
- Write naturally for international travellers.
- Use a clear H1 title and useful H2/H3 headings.
- Include a helpful introduction, practical steps and a relevant FAQ.
- Include a useful conclusion.
- Avoid keyword stuffing and repetitive paragraphs.
- Do not invent facts, official policies, visa fees or current prices.
- For visa, immigration, baggage and airline rules, tell readers to
  verify the latest information with the relevant official authority.
- Do not invent sources, quotations, statistics or links.
- Do not mention that the article was AI-generated.
- Return original, useful content, not a template.
- Return the article body in Markdown.
`;

      const article = await callGemini(
        prompt,
        articleSchema,
        6000
      );

      const description = String(article.description || "").trim();
      const keyword = String(
        article.focus_keyword || topic.focus_keyword
      ).trim();

      let body = String(article.article_markdown || "").trim();

      if (!description || !body || body.split(/\s+/).length < 400) {
        console.log(`Skipping incomplete article: ${topic.title}`);
        continue;
      }

      body = body.replace(/^#\s+.*\n+/, "");

      const frontmatter = [
        "---",
        `title: ${JSON.stringify(topic.title)}`,
        `description: ${JSON.stringify(description)}`,
        `slug: ${JSON.stringify(topic.slug)}`,
        `focus_keyword: ${JSON.stringify(keyword)}`,
        "---",
        ""
      ].join("\n");

      const markdown = `${frontmatter}# ${topic.title}\n\n${body}\n`;

      const folder = path.join(ROOT, topic.category);
      fs.mkdirSync(folder, { recursive: true });

      const filePath = path.join(folder, `${topic.slug}.md`);

      if (fs.existsSync(filePath)) {
        console.log(`Already exists: ${topic.slug}`);
        continue;
      }

      fs.writeFileSync(filePath, markdown, "utf8");

      existingSlugs.add(topic.slug);
      created++;

      console.log(`Created: ${filePath}`);
    } catch (error) {
      console.error(`Article failed: ${topic.title}`);
      console.error(error.message);
    }
  }

  console.log(`Finished. Articles created: ${created}`);

  if (created === 0) {
    throw new Error("No articles were created. Check the API and quota.");
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
