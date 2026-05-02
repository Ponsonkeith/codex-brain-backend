import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import OpenAI from "openai";

dotenv.config();

const require = createRequire(import.meta.url);
const { loadMemory, searchMemory, buildMemoryContext } = require("./memorySearch.cjs");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = process.env.PORT || 3000;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const LOCAL_MEMORY_FILE = path.join(__dirname, "memory.json");
const PROFILE_FILE = path.join(__dirname, "keith_profile.txt");
const DATA_MEMORY_FILE = path.join(__dirname, "data", "chatgpt-memory.jsonl");

function safeReadText(filePath) {
  try {
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    console.error("Failed reading text file:", filePath, error.message);
    return "";
  }
}

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;

    const raw = fs.readFileSync(filePath, "utf8");

    if (!raw.trim()) return fallback;

    return JSON.parse(raw);
  } catch (error) {
    console.error("Failed reading JSON file:", filePath, error.message);
    return fallback;
  }
}

function safeWriteJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (error) {
    console.error("Failed writing JSON file:", filePath, error.message);
    return false;
  }
}

function limitText(text, maxChars = 12000) {
  const value = String(text || "");

  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(0, maxChars) + "\n\n[TRUNCATED]";
}

function getLocalMemoryContext() {
  const parts = [];

  const profile = safeReadText(PROFILE_FILE);

  if (profile.trim()) {
    parts.push("LOCAL PROFILE:\n" + limitText(profile, 4000));
  }

  const localMemory = safeReadJson(LOCAL_MEMORY_FILE, null);

  if (localMemory) {
    let memoryText = "";

    if (Array.isArray(localMemory)) {
      memoryText = localMemory
        .slice(-50)
        .map((item, index) => {
          if (typeof item === "string") {
            return `${index + 1}. ${item}`;
          }

          return `${index + 1}. ${JSON.stringify(item)}`;
        })
        .join("\n");
    } else {
      memoryText = JSON.stringify(localMemory, null, 2);
    }

    if (memoryText.trim()) {
      parts.push("LOCAL SAVED MEMORY:\n" + limitText(memoryText, 8000));
    }
  }

  return parts.join("\n\n---\n\n");
}

function extractUserMessage(body) {
  if (!body || typeof body !== "object") {
    return "";
  }

  return (
    body.message ||
    body.input ||
    body.prompt ||
    body.text ||
    body.question ||
    ""
  ).toString();
}

function shouldUseMemory(message, results) {
  const text = String(message || "").toLowerCase();

  const memoryTriggers = [
    "where did we leave off",
    "what did we decide",
    "what did i decide",
    "what was the plan",
    "what was my plan",
    "where are we with",
    "where were we",
    "past chat",
    "past chats",
    "previous chat",
    "last time",
    "remember",
    "recall",
    "codex brain",
    "brain 297",
    "operator brain",
    "codex core",
    "x7",
    "dispatch",
    "driver portal",
    "arc league",
    "aruba racquet club",
    "real estate",
    "estateos",
    "neuralyx",
    "pos",
    "cash count",
    "alprazolam",
    "taper",
    "mounjaro",
    "hotel",
    "daher",
    "vanguard",
    "website",
    "codex",
    "do it center",
    "super do it center",
    "hr system",
    "recruitment",
    "vacancy"
  ];

  const triggered = memoryTriggers.some((trigger) => text.includes(trigger));

  const hasStrongResult =
    Array.isArray(results) &&
    results.some((result) => Number(result.score || 0) >= 12);

  return triggered || hasStrongResult;
}

function buildRuntimeContext({ memoryResultsCount, memoryUsed }) {
  return `
RUNTIME CURRENT STATE:
- This server.js file is running because the request reached the backend successfully.
- Codex Brain backend is active on port ${PORT}.
- OpenAI key loaded: ${Boolean(process.env.OPENAI_API_KEY)}.
- ChatGPT memory archive file exists: ${fs.existsSync(DATA_MEMORY_FILE)}.
- Local memory file exists: ${fs.existsSync(LOCAL_MEMORY_FILE)}.
- Memory search was executed for this request.
- Memory results found for this request: ${memoryResultsCount}.
- Retrieved memory was injected into the AI context for this request: ${memoryUsed}.
- If historical retrieved memory says the system is not built yet, treat that as outdated when runtime state proves the system is now running.
`.trim();
}

function buildSystemPrompt({
  runtimeContext,
  localMemoryContext,
  retrievedMemoryContext
}) {
  return `
You are Codex Brain, Keith's operator assistant.

Core behavior:
- Answer directly.
- Be practical, sharp, and execution-focused.
- Use retrieved memory only when it is relevant.
- Do not pretend to remember something unless it appears in the provided memory context.
- Do not invent past decisions.
- Do not over-explain unless the user asks for depth.
- Do not end responses with follow-up questions.
- Do not say "Want me to..." or ask permission to continue.
- Do not end with "I can help..." or "let me know."
- If there is an obvious next step, give the next step directly.
- Be concise unless the user asks for a full plan.

Keith prefers:
- direct answers
- no fluff
- ruthless logic
- practical steps
- no fake confidence
- no soft chatbot behavior
- clear next actions

Memory priority rules:
1. RUNTIME CURRENT STATE is the highest priority.
2. LOCAL SAVED MEMORY is second priority.
3. RETRIEVED PAST CHAT MEMORY is historical context and may be outdated.
4. If retrieved memory conflicts with runtime state or local memory, prioritize runtime state and local memory.
5. Do not say something is not built if runtime state proves it is already working.
6. If memory results are weak, say the memory is not strong enough and answer normally.

For "where did we leave off" questions, answer in this structure:
1. Current confirmed state
2. Relevant retrieved memory
3. Next concrete action

When using retrieved memory:
- Do not dump raw memory unless the user asks for raw details.
- Summarize what matters.
- Separate confirmed memory from your recommended next step.
- Keep it concise unless the question requires more detail.

${runtimeContext ? `\n${runtimeContext}\n` : ""}

${localMemoryContext ? `\nLOCAL CONTEXT:\n${localMemoryContext}\n` : ""}

${retrievedMemoryContext ? `\nRETRIEVED PAST CHAT MEMORY:\n${retrievedMemoryContext}\n` : ""}
`.trim();
}

async function handleChat(req, res) {
  try {
    const userMessage = extractUserMessage(req.body);

    if (!userMessage) {
      return res.status(400).json({
        ok: false,
        error: "Missing message"
      });
    }

    if (!openai) {
      return res.status(500).json({
        ok: false,
        error: "OPENAI_API_KEY is missing in .env"
      });
    }

    console.log("Chat request:", userMessage);

    let memoryResults = [];
    let memoryContext = "";
    let memoryUsed = false;

    try {
      memoryResults = searchMemory(userMessage, 8);

      console.log(`Memory search for: ${userMessage}`);
      console.log(`Found ${memoryResults.length} memory results`);

      const strongResults = memoryResults
        .filter((result) => Number(result.score || 0) >= 8)
        .slice(0, 8);

      if (shouldUseMemory(userMessage, strongResults)) {
        memoryContext = buildMemoryContext(strongResults);
        memoryContext = limitText(memoryContext, 14000);
        memoryUsed = Boolean(memoryContext);
      }
    } catch (memoryError) {
      console.error("Memory retrieval failed:", memoryError.message);
    }

    const localMemoryContext = getLocalMemoryContext();

    const runtimeContext = buildRuntimeContext({
      memoryResultsCount: memoryResults.length,
      memoryUsed
    });

    const systemPrompt = buildSystemPrompt({
      runtimeContext,
      localMemoryContext,
      retrievedMemoryContext: memoryContext
    });

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userMessage
        }
      ],
      temperature: 0.3
    });

    const reply = completion.choices?.[0]?.message?.content || "";

    return res.json({
      ok: true,
      reply,
      response: reply,
      answer: reply,
      message: reply,
      memory_used: memoryUsed,
      memory_results_count: memoryResults.length,
      memory_results_preview: memoryResults.slice(0, 5).map((result) => ({
        conversation_title: result.conversation_title,
        tags: result.tags,
        score: result.score,
        updated_at: result.updated_at
      }))
    });
  } catch (error) {
    console.error("Chat error:", error);

    return res.status(500).json({
      ok: false,
      error: "Chat failed",
      details: error.message
    });
  }
}

function renderChatPage(req, res) {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Codex Brain</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background:
        radial-gradient(circle at top left, rgba(78, 131, 255, 0.16), transparent 30%),
        radial-gradient(circle at bottom right, rgba(126, 255, 205, 0.08), transparent 35%),
        #070707;
      color: #f5f5f5;
      font-family: Arial, Helvetica, sans-serif;
      min-height: 100vh;
    }

    .shell {
      width: 100%;
      max-width: 1050px;
      margin: 0 auto;
      padding: 28px;
    }

    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 20px;
    }

    .brand {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .brand h1 {
      margin: 0;
      font-size: 30px;
      letter-spacing: -0.04em;
    }

    .brand p {
      margin: 0;
      color: #a7a7a7;
      font-size: 14px;
    }

    .status {
      border: 1px solid rgba(139, 226, 139, 0.35);
      color: #9cff9c;
      background: rgba(139, 226, 139, 0.08);
      padding: 10px 14px;
      border-radius: 999px;
      font-size: 13px;
      white-space: nowrap;
    }

    .panel {
      background: rgba(14, 14, 14, 0.92);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 22px;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.42);
      overflow: hidden;
    }

    #messages {
      min-height: 530px;
      max-height: 650px;
      overflow-y: auto;
      padding: 24px;
      white-space: pre-wrap;
      line-height: 1.55;
    }

    .msg {
      margin-bottom: 18px;
      padding: 16px;
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.06);
    }

    .user {
      background: rgba(79, 131, 255, 0.12);
      color: #dce7ff;
    }

    .assistant {
      background: rgba(255, 255, 255, 0.045);
      color: #f5f5f5;
    }

    .label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #9c9c9c;
      margin-bottom: 8px;
    }

    .input-wrap {
      display: flex;
      gap: 12px;
      padding: 18px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(0, 0, 0, 0.25);
    }

    input {
      flex: 1;
      background: #0b0b0b;
      color: #ffffff;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 14px;
      padding: 15px 16px;
      font-size: 16px;
      outline: none;
    }

    input:focus {
      border-color: rgba(139, 180, 255, 0.75);
      box-shadow: 0 0 0 4px rgba(139, 180, 255, 0.08);
    }

    button {
      background: #ffffff;
      color: #000000;
      border: 0;
      border-radius: 14px;
      padding: 15px 24px;
      font-weight: 800;
      cursor: pointer;
      font-size: 15px;
    }

    button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .quick {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin: 16px 0 0;
    }

    .quick button {
      background: rgba(255, 255, 255, 0.08);
      color: #ffffff;
      border: 1px solid rgba(255, 255, 255, 0.1);
      padding: 10px 12px;
      font-size: 13px;
      font-weight: 600;
    }

    @media (max-width: 700px) {
      .shell {
        padding: 16px;
      }

      .topbar {
        align-items: flex-start;
        flex-direction: column;
      }

      .status {
        white-space: normal;
      }

      #messages {
        min-height: 480px;
        max-height: 620px;
        padding: 16px;
      }

      .input-wrap {
        flex-direction: column;
      }

      button {
        width: 100%;
      }
    }
  </style>
</head>

<body>
  <div class="shell">
    <div class="topbar">
      <div class="brand">
        <h1>Codex Brain</h1>
        <p>Local memory engine connected to your ChatGPT archive.</p>
      </div>
      <div class="status">Backend live on port 3000</div>
    </div>

    <div class="panel">
      <div id="messages"></div>

      <div class="input-wrap">
        <input id="messageInput" placeholder="Ask Codex Brain..." autocomplete="off" />
        <button id="sendButton">Send</button>
      </div>
    </div>

    <div class="quick">
      <button onclick="quickAsk('where did we leave off with codex brain?')">Codex Brain status</button>
      <button onclick="quickAsk('where did we leave off with X7?')">X7</button>
      <button onclick="quickAsk('what did we decide about the dispatch dashboard?')">Dispatch</button>
      <button onclick="quickAsk('where did we leave off with ARC League?')">ARC League</button>
      <button onclick="quickAsk('what was the plan for Neuralyx POS?')">Neuralyx POS</button>
    </div>
  </div>

  <script>
    const messages = document.getElementById("messages");
    const input = document.getElementById("messageInput");
    const button = document.getElementById("sendButton");

    function addMessage(type, text) {
      const wrapper = document.createElement("div");
      wrapper.className = "msg " + type;

      const label = document.createElement("div");
      label.className = "label";
      label.textContent = type === "user" ? "Keith" : "Codex Brain";

      const content = document.createElement("div");
      content.textContent = text;

      wrapper.appendChild(label);
      wrapper.appendChild(content);
      messages.appendChild(wrapper);
      messages.scrollTop = messages.scrollHeight;
    }

    async function sendMessage() {
      const text = input.value.trim();

      if (!text) return;

      addMessage("user", text);

      input.value = "";
      button.disabled = true;
      button.textContent = "Thinking...";

      try {
        const response = await fetch("/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            message: text
          })
        });

        const data = await response.json();

        if (!data.ok) {
          addMessage("assistant", "Error: " + (data.error || "Unknown error"));
        } else {
          addMessage("assistant", data.reply || data.answer || data.message || "No reply returned.");
        }
      } catch (error) {
        addMessage("assistant", "Connection error: " + error.message);
      }

      button.disabled = false;
      button.textContent = "Send";
      input.focus();
    }

    function quickAsk(text) {
      input.value = text;
      sendMessage();
    }

    button.addEventListener("click", sendMessage);

    input.addEventListener("keydown", function(event) {
      if (event.key === "Enter") {
        sendMessage();
      }
    });

    addMessage("assistant", "Codex Brain is ready. Ask what we left off with, or use one of the quick buttons.");
  </script>
</body>
</html>
  `);
}

function initializeServer() {
  console.log("Starting Codex Brain backend...");
  console.log("Backend folder:", __dirname);

  if (fs.existsSync(DATA_MEMORY_FILE)) {
    console.log("Memory archive found:", DATA_MEMORY_FILE);
  } else {
    console.warn("Memory archive missing:", DATA_MEMORY_FILE);
  }

  loadMemory();
}

initializeServer();

app.get("/", renderChatPage);
app.get("/chat", renderChatPage);

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "healthy",
    port: PORT,
    model: OPENAI_MODEL,
    openai_key_loaded: Boolean(process.env.OPENAI_API_KEY),
    memory_file_exists: fs.existsSync(DATA_MEMORY_FILE),
    local_memory_exists: fs.existsSync(LOCAL_MEMORY_FILE)
  });
});

app.post("/memory/search", async (req, res) => {
  try {
    const { query, limit = 8 } = req.body || {};

    if (!query || typeof query !== "string") {
      return res.status(400).json({
        ok: false,
        error: "Missing query"
      });
    }

    console.log("Memory search for:", query);

    const results = searchMemory(query, limit);

    console.log(`Found ${results.length} memory results`);

    return res.json({
      ok: true,
      query,
      count: results.length,
      results
    });
  } catch (error) {
    console.error("Memory search error:", error);

    return res.status(500).json({
      ok: false,
      error: "Memory search failed",
      details: error.message
    });
  }
});

app.get("/memory/local", (req, res) => {
  const localMemory = safeReadJson(LOCAL_MEMORY_FILE, []);

  return res.json({
    ok: true,
    memory: localMemory
  });
});

app.post("/memory/local", (req, res) => {
  const body = req.body || {};

  const currentMemory = safeReadJson(LOCAL_MEMORY_FILE, []);
  const memoryArray = Array.isArray(currentMemory) ? currentMemory : [currentMemory];

  const item = {
    id: Date.now().toString(),
    created_at: new Date().toISOString(),
    type: body.type || "note",
    title: body.title || "Untitled memory",
    content: body.content || body.message || body.text || "",
    raw: body
  };

  memoryArray.push(item);

  const saved = safeWriteJson(LOCAL_MEMORY_FILE, memoryArray);

  if (!saved) {
    return res.status(500).json({
      ok: false,
      error: "Failed to save local memory"
    });
  }

  return res.json({
    ok: true,
    item,
    count: memoryArray.length
  });
});

app.post("/chat", handleChat);
app.post("/api/chat", handleChat);

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Route not found",
    path: req.path
  });
});

app.listen(PORT, () => {
  console.log(`Codex Brain backend running on http://localhost:${PORT}`);
});