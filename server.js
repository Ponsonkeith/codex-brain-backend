import express from "express";
import OpenAI from "openai";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import dispatch from "./dispatch.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const MAX_CHAT_HISTORY = 60;

// ===== BRAIN LOGS =====
async function saveBrainLog(role, content) {
  const cleanContent = String(content || "").trim();
  if (!cleanContent) return false;

  const { error } = await supabase.from("brain_logs").insert([
    { role, content: cleanContent }
  ]);

  if (error) {
    console.error("SAVE BRAIN LOG ERROR:", error.message);
    return false;
  }

  return true;
}

async function loadBrainLogs(limit = MAX_CHAT_HISTORY) {
  const { data, error } = await supabase
    .from("brain_logs")
    .select("role, content, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("LOAD BRAIN LOGS ERROR:", error.message);
    return [];
  }

  return (data || []).reverse().map(item => ({
    role: item.role === "assistant" ? "assistant" : "user",
    content: item.content
  }));
}

// ===== MANUAL MEMORY =====
async function loadMemory() {
  const { data, error } = await supabase
    .from("memory")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    console.error("LOAD MEMORY ERROR:", error.message);
    return [];
  }

  return data || [];
}

async function saveMemory(value) {
  const cleanValue = String(value || "").trim();
  if (!cleanValue) return false;

  const { error } = await supabase
    .from("memory")
    .insert([{ value: cleanValue }]);

  if (error) {
    console.error("SAVE MEMORY ERROR:", error.message);
    return false;
  }

  return true;
}

function isSaveMemoryRequest(msg) {
  const lower = msg.toLowerCase();
  return (
    lower.includes("save to memory") ||
    lower.includes("save this to memory") ||
    lower.includes("remember this") ||
    lower.includes("remember that") ||
    lower.includes("store this")
  );
}

// ===== HELPERS =====
function clean(text) {
  return String(text || "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\(\s*\)/g, "")
    .trim();
}

function getReply(response) {
  if (response.output_text) return response.output_text;

  let text = "";
  response.output?.forEach(item => {
    item.content?.forEach(content => {
      if (content.text) text += content.text;
    });
  });

  return text || "No response";
}

function wantsFullAnswer(msg) {
  const lower = msg.toLowerCase();
  return (
    lower.includes("full detail") ||
    lower.includes("full details") ||
    lower.includes("everything") ||
    lower.includes("complete breakdown") ||
    lower.includes("whole detail") ||
    lower.includes("tell me all")
  );
}

// ===== DISPATCH =====
function getDispatchSummary() {
  const all = dispatch.getAllDispatches();

  return {
    total: all.length,
    pending: all.filter(d => d.status === "Pending").length,
    scheduled: all.filter(d => d.status === "Scheduled").length,
    outForDelivery: all.filter(d => d.status === "Out for Delivery").length,
    delivered: all.filter(d => d.status === "Delivered").length,
    cancelled: all.filter(d => d.status === "Cancelled").length
  };
}

// ===== ROUTES =====
app.get("/", (req, res) => {
  res.send("Codex Brain running");
});

app.get("/memory", async (req, res) => {
  const memory = await loadMemory();
  res.json(memory);
});

app.get("/brain-logs", async (req, res) => {
  const logs = await loadBrainLogs(200);
  res.json(logs);
});

// ===== BULK MEMORY IMPORT =====
app.post("/bulk-memory", async (req, res) => {
  try {
    const { entries, text } = req.body;

    let finalEntries = [];

    if (Array.isArray(entries)) {
      finalEntries = entries;
    } else if (typeof text === "string") {
      finalEntries = text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0);
    } else {
      return res.status(400).json({
        error: "Send either { entries: [...] } or { text: 'line 1\\nline 2' }"
      });
    }

    finalEntries = finalEntries
      .map(e => String(e).trim())
      .filter(e => e.length > 0);

    if (finalEntries.length === 0) {
      return res.status(400).json({ error: "No valid memory entries found" });
    }

    const payload = finalEntries.map(entry => ({
      role: "user",
      content: entry
    }));

    const { error } = await supabase
      .from("brain_logs")
      .insert(payload);

    if (error) {
      console.error("BULK MEMORY ERROR:", error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json({
      success: true,
      inserted: payload.length
    });

  } catch (err) {
    console.error("BULK MEMORY SERVER ERROR:", err);
    res.status(500).json({ error: "Bulk memory failed" });
  }
});

// ===== CHAT =====
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "No message provided" });
    }

    await saveBrainLog("user", message);

    if (isSaveMemoryRequest(message)) {
      const cleaned = message
        .replace(/save this to memory[:\-]?/i, "")
        .replace(/save to memory[:\-]?/i, "")
        .replace(/remember this[:\-]?/i, "")
        .replace(/remember that[:\-]?/i, "")
        .replace(/store this[:\-]?/i, "")
        .trim();

      const saved = await saveMemory(cleaned);

      const reply = saved
        ? "Saved to memory."
        : "Tried to save it, but Supabase rejected it.";

      await saveBrainLog("assistant", reply);
      return res.json({ reply });
    }

    const manualMemory = await loadMemory();
    const brainHistory = await loadBrainLogs(MAX_CHAT_HISTORY);

    const formattedMemory = manualMemory
      .map(m => `- ${m.value}`)
      .join("\n");

    const lower = message.toLowerCase();
    const wantsFull = wantsFullAnswer(message);

    const systemPrompt = `
You are Codex Brain, Keith's personal AI operating system.

You have permanent memory through brain_logs.
The conversation history included below is real past conversation data.
Use it to maintain continuity.
If Keith asks what he said earlier, answer from the provided history.
If Keith asks how you knew something, check the provided history first.
Do not deny something if it appears in history.

Manual long-term memory:
${formattedMemory || "No manual memory yet."}

Current dispatch system state:
${JSON.stringify(getDispatchSummary(), null, 2)}

STYLE:
Talk like Keith's sharp operator brain.
Direct, human, slightly sarcastic.
No corporate tone.
No long speeches unless Keith asks for full detail.

RESPONSE MODE:
${wantsFull ? "Keith asked for detail. Give a detailed answer." : "Keep it short and sharp."}

RULES:
- Use brain_logs when relevant.
- Use manual memory when relevant.
- Do not dump all memory unless Keith asks for the whole detail.
- If you do not know something, say it plainly.
- Do not invent live/current facts.
- For current news, sports, prices, weather, or live events, say you need a live check if not verified.
`;

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: systemPrompt },
        ...brainHistory,
        { role: "user", content: message }
      ]
    });

    const reply = clean(getReply(response));

    await saveBrainLog("assistant", reply);

    res.json({
      reply,
      saved_to_brain_logs: true
    });

  } catch (err) {
    console.error("CHAT ERROR:", err);
    res.status(500).json({
      error: "Chat failed",
      details: err.message
    });
  }
});

// ===== DISPATCH ROUTES =====
app.get("/dispatch/create/:id", (req, res) => {
  res.json(dispatch.createDispatch(req.params.id));
});

app.get("/dispatch/update/:id/:status", (req, res) => {
  res.json(dispatch.updateStatus(req.params.id, req.params.status));
});

app.get("/dispatch/all", (req, res) => {
  res.json(dispatch.getAllDispatches());
});

app.get("/dispatch/summary", (req, res) => {
  res.json(getDispatchSummary());
});

// ===== START =====
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});