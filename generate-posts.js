
const fs = require("fs");
const path = require("path");

const API_KEY = process.env.OPENROUTER_API_KEY;
const API_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "openrouter/free";

const DAILY_POSTS = 20;
const MAX_ATTEMPTS = 2;
const REQUEST_TIMEOUT = 180000;
const MIN_REQUEST_GAP = 8000;

const ROOT = process.cwd();

const CATEGORIES = [
  "flight-guides",
  "visa-guides",
  "destination-guides",
  "travel-tips"
];

if (!API_KEY) {
  throw new Error("OPENROUTER_API_KEY is missing in GitHub Secrets.");
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
    if ([
      ".git",
      "node_modules",
      "dist",
      ".github"
    ].includes(item.name)) continue;

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
  const titles = [];

  for (const file of getMarkdownFiles(ROOT)) {
    const content = fs.readFileSync(file, "utf8");
    const match = content.match(/^title:\s*["']?(.*?)["']?\s*$/m);

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

function extractJson(text) {
  let cleaned = String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start < 0 || end <= start) {
    throw new Error("AI response did not contain valid JSON.");
  }

  return JSON.parse(cleaned.slice(start, end + 1));
}

function getMessageContent(data) {
  const content = data.choices?.[0]?.message?.content;

  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map(item => item.text || "")
      .join("");
  }

  return "";
}

let lastRequestAt = 0;

async function callAI(prompt, maxTokens = 4500) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const elapsed = Date.now() - lastRequestAt;

      if (elapsed < MIN_REQUEST_GAP) {
        await sleep(MIN_REQUEST_GAP - elapsed);
      }

      console.log(
        `OpenRouter request: ${attempt}/${MAX_ATTEMPTS}`
      );

      lastRequestAt = Date.now();

      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://avenixpro.com",
          "X-Title": "Avenix Trip"
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        body: JSON.stringify({
          model: MODEL,
          messages: [
            {
              role: "system",
              content:
                "You are a careful international travel editor. Follow the user's instructions and return valid JSON only."
            },
            {
              role: "user",
              content: prompt
            }
          ],
          temperature: 0.7,
          max_tokens: maxTokens,
          response_format: {
            type: "json_object"
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();

        const temporaryStatuses = [
          408, 425, 429, 500, 502, 503, 504
        ];

        if (temporaryStatuses.includes(response.status)) {
          const error = new Error(
            `TEMPORARY_HTTP_${response.status}: ${errorText}`
          );
          error.temporary = true;
          error.retryAfter = response.headers.get("retry-after");
          throw error;
        }

        throw new Error(
          `OpenRouter API error ${response.status}: ${errorText}`
        );
      }

      const data = await response.json();
      const content = getMessageContent(data);

      if (!content) {
        throw new Error("OpenRouter returned an empty response.");
      }

      return extractJson(content);

    } catch (error) {
      const message = String(error.message || error);

      const temporary =
        error.temporary === true ||
        error.name === "AbortError" ||
        error.name === "TimeoutError" ||
        message.includes("fetch failed") ||
        message.includes("Headers Timeout") ||
        message.includes("UND_ERR") ||
        message.includes("ECONNRESET") ||
        message.includes("ETIMEDOUT") ||
        message.includes("EAI_AGAIN");

      if (!temporary || attempt === MAX_ATTEMPTS) {
        throw error;
      }

      const retryHeader = Number(error.retryAfter);
      const waitTime =
        retryHeader > 0
          ? Math.min(retryHeader * 1000, 120000)
          : 30000;

      console.log(
        `Temporary error. Retrying after ${Math.ceil(waitTime / 1000)} seconds.`
      );

      await sleep(waitTime);
    }
  }

  throw new Error("OpenRouter request failed.");
}

async function main() {
  const existingTitles = getExistingTitles();
  const existingSlugs = getExistingSlugs();

  const titleSet = new Set(
    existingTitles.map(title => title.toLowerCase())
  );

  console.log("Planning new Avenix Trip articles...");

  const plannerPrompt = `
Return a JSON object with a "topics" array containing exactly ${DAILY_POSTS} article ideas.

You are the editorial planner for Avenix Trip, an international travel guide website.

Existing article titles:
${existingTitles.join("\n")}

Allowed categories:
${CATEGORIES.join(", ")}

Each topic must contain:
- title
- slug
- category
- focus_keyword

Rules:
- Write useful evergreen international travel topics.
- Cover flights, airports, destinations, visa preparation,
  accommodation, transport and travel planning.
- Avoid duplicate or closely related titles.
- Avoid invented visa rules, fees and current prices.
- Use short lowercase URL slugs.
- Use only the allowed categories.
- Make every topic meaningfully different.
- Return valid JSON only.
`;

  const plan = await callAI(plannerPrompt, 5000);

  if (!Array.isArray(plan.topics)) {
    throw new Error("Topic planner returned no topics array.");
  }

  const plannedSlugs = new Set();

  const topics = plan.topics
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
      ) return false;

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
Return a JSON object with these fields:
- description
- focus_keyword
- article_markdown

Write an original, useful English travel guide for Avenix Trip.

Title: ${topic.title}
Primary keyword: ${topic.focus_keyword}

Requirements:
- Aim for 800–1,000 useful words.
- Write naturally for international travellers.
- Start the article body with a useful introduction.
- Use relevant H2 and H3 headings.
- Include practical advice and clear steps.
- Include a relevant FAQ and conclusion.
- Avoid keyword stuffing and repetitive paragraphs.
- Do not invent facts, statistics, quotations, sources,
  official policies, visa fees or current prices.
- Tell readers to verify changing visa, immigration,
  airline and baggage rules with official authorities.
- Do not mention AI generation.
- Return valid JSON only.
`;

      const article = await callAI(prompt, 5000);

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
        console.log(`Incomplete article: ${topic.title}`);
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
  console.log(`Articles failed: ${failed}`);
  console.log("--------------------------------");

  if (created === 0) {
    throw new Error(
      "No articles were created. Check OpenRouter availability and free quota."
    );
  }

  console.log("Article generation completed.");
}

main().catch(error => {
  console.error("FATAL ERROR:", error.message);
  process.exit(1);
});
