const fs = require("fs");
const path = require("path");

const MEMORY_FILE = path.join(__dirname, "data", "chatgpt-memory.jsonl");

let memoryChunks = [];

function loadMemory() {
  if (!fs.existsSync(MEMORY_FILE)) {
    console.warn("⚠️ Memory file not found:", MEMORY_FILE);
    memoryChunks = [];
    return;
  }

  const raw = fs.readFileSync(MEMORY_FILE, "utf8");

  memoryChunks = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  console.log(`✅ Loaded ${memoryChunks.length} memory chunks`);
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(query) {
  const stopWords = new Set([
    "the", "a", "an", "and", "or", "to", "of", "in", "on", "for",
    "with", "about", "what", "where", "when", "how", "did", "do",
    "we", "i", "you", "it", "is", "are", "was", "were", "this",
    "that", "my", "me", "our", "past", "chat", "chats"
  ]);

  return normalize(query)
    .split(" ")
    .filter((word) => word.length > 2 && !stopWords.has(word));
}

function scoreChunk(chunk, queryTokens, rawQuery) {
  const title = normalize(chunk.conversation_title || "");
  const content = normalize(chunk.content || "");
  const tags = Array.isArray(chunk.tags)
    ? normalize(chunk.tags.join(" "))
    : normalize(chunk.tags || "");

  let score = 0;

  for (const token of queryTokens) {
    if (title.includes(token)) score += 8;
    if (tags.includes(token)) score += 6;
    if (content.includes(token)) score += 2;
  }

  const exactQuery = normalize(rawQuery);

  if (exactQuery && content.includes(exactQuery)) {
    score += 25;
  }

  return score;
}

function searchMemory(query, limit = 8) {
  if (!memoryChunks.length) {
    loadMemory();
  }

  const queryTokens = tokenize(query);

  if (!queryTokens.length) {
    return [];
  }

  const scored = memoryChunks
    .map((chunk) => ({
      ...chunk,
      score: scoreChunk(chunk, queryTokens, query)
    }))
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map((chunk) => ({
    conversation_title: chunk.conversation_title,
    tags: chunk.tags,
    created_at: chunk.created_at,
    updated_at: chunk.updated_at,
    score: chunk.score,
    content: chunk.content
  }));
}

function buildMemoryContext(results) {
  if (!results || !results.length) {
    return "";
  }

  return results
    .map((result, index) => {
      return [
        `MEMORY RESULT ${index + 1}`,
        `Title: ${result.conversation_title || "Unknown"}`,
        `Tags: ${Array.isArray(result.tags) ? result.tags.join(", ") : "None"}`,
        `Date: ${result.updated_at || result.created_at || "Unknown"}`,
        "Content:",
        result.content
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

module.exports = {
  loadMemory,
  searchMemory,
  buildMemoryContext
};