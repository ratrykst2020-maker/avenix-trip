
const fs = require("fs");
const path = require("path");

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-3.8-flash";

const API_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const DAILY_POSTS = 20;
const ROOT = process.cwd();

const MAX_ATTEMPTS = 6;
const REQUEST_TIMEOUT = 180000;
const MIN_REQUEST_GAP = 8000;

const CATEGORIES = [
  "flight-guides",
  "visa-guides",
  "destination-guides",
  "travel-tips"
];

if (!API_KEY) {
  throw new Error("GEMINI_API_KEY is missing in GitHub Secrets.");
}

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function getMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];

  let files = [];

  for (const item of fs.readdirSync(dir, {
    withFileTypes: true
  })) {
    if (
      item.name === ".git" ||
      item.name === "node_modules" ||
      item.name === "dist" ||
      item.name === ".github"
    ) {
      continue;
    }

    const full = path.join(dir, item.name);

    if (item.isDirectory()) {
      files = files.concat(getMarkdownFiles(full));
    } else if (
      item.isFile() &&
      item.name.toLowerCase().endsWith(".md")
    ) {
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

    const match = content.match(
      /^title:\s*["']?(.*?)["']?\s*$/m
    );

    if (match) {
      titles.push(match[1].replace(/["']/g, "").trim());
    } else {
      const heading = content.match(/^#\s+(.+)$/m);
      if (heading) titles.push(heading[1].trim());
    }
  }

  return [...new Set(titles)];
}

function getExistingSlugs() {
  return new Set(
    getMarkdownFiles(ROOT).map(file =>
      path.basename(file, ".md").toLowerCase()
    )
  );
}

let lastRequestAt = 0;

function isTemporaryError(error) {
  const message = String(error?.message || "");

  return (
    error?.name === "AbortError" ||
    error?.name === "TimeoutError" ||
    message.includes("fetch failed") ||
    message.includes("Headers Timeout") ||
    message.includes("UND_ERR") ||
    message.includes("ECONNRESET") ||
    message.includes("ETIMEDOUT") ||
    message.includes("EAI_AGAIN")
  );
}

async function callGemini(prompt, schema, maxTokens = 5000) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const elapsed = Date.now() - lastRequestAt;

      if (elapsed < MIN_REQUEST_GAP) {
        await sleep(MIN_REQUEST_GAP - elapsed);
      }

      console.log(
        `Gemini request: attempt ${attempt}/${MAX_ATTEMPTS}`
      );

      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": API_KEY
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        body: JSON.stringify({
          contents: [{
            role: "user",
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

      if (!response.ok) {
        const errorText = await response.text();

        const temporaryStatuses = [
          408, 425, 429, 500, 502, 503, 504
        ];

        if (temporaryStatuses.includes(response.status)) {
          throw new Error(
            `TEMPORARY_HTTP_${response.status}: ${errorText}`
          );
        }

        throw new Error(
          `Gemini API error ${response.status}: ${errorText}`
        );
      }

      const data = await response.json();

      const candidate = data.candidates?.[0];

      const resultText = candidate?.content?.parts
        ?.map(part => part.text || "")
        .join("");

      if (!resultText) {
        throw new Error(
          `Gemini returned no usable text. Finish reason: ${
            candidate?.finishReason || "unknown"
          }`
        );
      }

      return JSON.parse(resultText);

    } catch (error) {
      const message = String(error.message || error);

      const temporary =
        isTemporaryError(error) ||
        message.startsWith("TEMPORARY_HTTP_");

      if (!temporary || attempt === MAX_ATTEMPTS) {
        throw error;
      }

      const waitTime = Math.min(
        15000 * Math.pow(2, attempt - 1),
        120000
      );

      const jitter = Math.floor(Math.random() * 5000);

      console.log(
        `Temporary Gemini/network error. ` +
        `Retry ${attempt}/${MAX_ATTEMPTS} after ` +
        `${Math.round((waitTime + jitter) / 1000)} seconds.`
      );

      await sleep(waitTime + jitter);
    }
  }

  throw new Error("Gemini request failed after all retries.");
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
        required: [
          "title",
          "slug",
          "category",
          "focus_keyword"
        ]
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
  required: [
    "description",
    "focus_keyword",
    "article_markdown"
  ]
};

async function main() {
  const existingTitles = getExistingTitles();
  const existingSlugs = getExistingSlugs();

  const titleSet = new Set(
    existingTitles.map(title => title.toLowerCase())
  );

  console.log("Planning new Avenix Trip articles...");

  const plannerPrompt = `
You are the editorial planner for Avenix Trip,
an international travel guide website.

Create exactly ${DAILY_POSTS} distinct, useful,
evergreen article ideas.

Existing article titles (avoid duplicates):
${existingTitles.join("\n")}

Allowed categories:
${CATEGORIES.join(", ")}

Rules:
- Focus on international travel, flights, airports,
  destinations, travel planning, accommodation,
  transport and visa preparation.
- Avoid invented visa rules, fees, prices or airline policies.
- Prefer topics answerable with reliable general guidance.
- Avoid thin, repetitive or misleading topics.
- Every title must be meaningfully different.
- Use short, readable, lowercase URL slugs.
- Choose only an allowed category.
- Return exactly ${DAILY_POSTS} topics.
`;

  const plan = await callGemini(
    plannerPrompt,
    topicSchema,
    5000
  );

  const plannedSlugs = new Set();

  const topics = (plan.topics || [])
    .map(topic => ({
      ...topic,
      slug: slugify(topic.slug || topic.title),
      category: CATEGORIES.includes(topic.category)
        ? topic.category
        : "travel-tips"
    }))
    .filter(topic => {
      if (
        !topic.title ||
        !topic.slug ||
        !topic.focus_keyword
      ) return false;

      const normalizedTitle = topic.title.toLowerCase();

      if (
        existingSlugs.has(topic.slug) ||
        plannedSlugs.has(topic.slug) ||
        titleSet.has(normalizedTitle)
      ) {
        return false;
      }

      plannedSlugs.add(topic.slug);
      titleSet.add(normalizedTitle);

      return true;
    });

  console.log(`New topics available: ${topics.length}`);

  let created = 0;
  let failed = 0;

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
- Include a helpful introduction and practical steps.
- Include a relevant FAQ and useful conclusion.
- Avoid keyword stuffing and repetitive paragraphs.
- Do not invent facts, official policies, visa fees
  or current prices.
- For visa, immigration, baggage and airline rules,
  tell readers to verify current information with
  the relevant official authority.
- Do not invent sources, quotations, statistics or links.
- Do not mention that the article was AI-generated.
- Return original, useful content, not a template.
- Return the article body in Markdown.
`;

      const article = await callGemini(
        prompt,
        articleSchema,
        8000
      );

      const description = String(
        article.description || ""
      ).trim();

      const keyword = String(
        article.focus_keyword || topic.focus_keyword
      ).trim();

      let body = String(
        article.article_markdown || ""
      ).trim();

      if (
        !description ||
        !body ||
        body.split(/\s+/).length < 400
      ) {
        console.log(
          `Skipping incomplete article: ${topic.title}`
        );
        failed++;
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

      const markdown =
        `${frontmatter}# ${topic.title}\n\n${body}\n`;

      const folder = path.join(ROOT, topic.category);

      fs.mkdirSync(folder, { recursive: true });

      const filePath = path.join(
        folder,
        `${topic.slug}.md`
      );

      if (fs.existsSync(filePath)) {
        console.log(`Already exists: ${topic.slug}`);
        continue;
      }

      fs.writeFileSync(filePath, markdown, "utf8");

      existingSlugs.add(topic.slug);
      created++;

      console.log(`Created: ${filePath}`);

    } catch (error) {
      failed++;

      console.error(`Article failed: ${topic.title}`);
      console.error(error.message);
    }
  }

  console.log("--------------------------------");
  console.log(`Articles created: ${created}`);
  console.log(`Articles failed/skipped: ${failed}`);
  console.log("--------------------------------");

  if (created === 0) {
    throw new Error(
      "No articles were created. Check Gemini API availability and quota."
    );
  }

  console.log("Article generation completed.");
}

main().catch(error => {
  console.error("FATAL ERROR:", error.message);
  process.exit(1);
});
