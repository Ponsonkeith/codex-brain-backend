import express from "express";
import OpenAI from "openai";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

import dispatch from "./dispatch.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ===== CHAT MEMORY =====
let chatHistory = [];
const MAX_HISTORY = 10;

// ===== SUPABASE MEMORY =====
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

// ===== DISPATCH SUMMARY =====
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

// ===== TIME ANALYSIS =====
function analyzeDispatches() {
  const all = dispatch.getAllDispatches();
  const now = new Date();
  const issues = [];

  all.forEach(d => {
    const last = new Date(d.history[d.history.length - 1].time);
    const minutes = (now - last) / 60000;

    if (d.status === "Pending" && minutes > 2) {
      issues.push(`Dispatch ${d.id} stuck in Pending (${Math.floor(minutes)} min)`);
    }

    if (d.status === "Scheduled" && minutes > 5) {
      issues.push(`Dispatch ${d.id} stuck in Scheduled (${Math.floor(minutes)} min)`);
    }

    if (d.status === "Out for Delivery" && minutes > 10) {
      issues.push(`Dispatch ${d.id} taking too long (${Math.floor(minutes)} min)`);
    }
  });

  return issues;
}

// ===== HELPERS =====
function clean(text) {
  return String(text || "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .trim();
}

function getReply(r) {
  if (r.output_text) return r.output_text;

  let t = "";
  r.output?.forEach(o => {
    o.content?.forEach(c => {
      if (c.text) t += c.text;
    });
  });

  return t || "No response";
}

function shouldUseWeb(msg) {
  const lower = msg.toLowerCase();
  const triggers = ["today", "news", "latest", "score", "tennis", "current", "now", "won"];
  return triggers.some(t => lower.includes(t));
}

function wantsFullAnswer(msg) {
  const lower = msg.toLowerCase();

  return (
    lower.includes("full detail") ||
    lower.includes("full details") ||
    lower.includes("everything") ||
    lower.includes("full analysis") ||
    lower.includes("complete breakdown") ||
    lower.includes("whole detail") ||
    lower.includes("whole damn detail")
  );
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

function extractMemoryValue(msg) {
  return String(msg)
    .replace(/save this to memory[:\-]?/i, "")
    .replace(/save to memory[:\-]?/i, "")
    .replace(/remember this[:\-]?/i, "")
    .replace(/remember that[:\-]?/i, "")
    .replace(/store this[:\-]?/i, "")
    .trim();
}

// ===== ROUTES =====
app.get("/", (req, res) => {
  res.send("Codex Brain running");
});

app.get("/memory", async (req, res) => {
  const memory = await loadMemory();
  res.json(memory);
});

// ===== CHAT =====
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "No message provided" });
    }

    const lower = message.toLowerCase();

    // ===== SAVE MEMORY ALWAYS =====
    if (isSaveMemoryRequest(message)) {
      const value = extractMemoryValue(message);
      const saved = await saveMemory(value);

      if (!saved) {
        return res.json({
          reply: "Tried to save it, but Supabase rejected it. So no, I’m not going to lie and pretend it worked."
        });
      }

      return res.json({
        reply: "Saved. Now it’s actually in memory, not floating around in imaginary robot confidence."
      });
    }

    const memory = await loadMemory();
    const formattedMemory = memory.map(m => `- ${m.value}`).join("\n");

    const dispatchSummary = getDispatchSummary();
    const issues = analyzeDispatches();

    const wantsFull = wantsFullAnswer(message);

    const responseStyle = wantsFull
      ? "Give a full detailed answer because Keith explicitly asked for detail."
      : "Keep it short, sharp, and human. Do not dump the whole memory. No long speeches.";

    const isOperator =
      lower.includes("dispatch") ||
      lower.includes("happening") ||
      lower.includes("system") ||
      lower.includes("status") ||
      lower.includes("what should i do") ||
      lower.includes("what should i focus") ||
      lower.includes("what do i do");

    let systemPrompt;

    // ===== OPERATOR MODE =====
    if (isOperator) {
      systemPrompt = `
You are Codex Brain.

You are Keith's personal AI operating system.

Known memory:
${formattedMemory || "No saved memory yet."}

This is a logistics system.
A dispatch is an internal job/task, NOT a customer order.

System state:
${JSON.stringify(dispatchSummary, null, 2)}

Issues:
${issues.length ? issues.join("\n") : "None"}

STYLE:
Talk like a real human operator.
Direct. Slight edge. No corporate tone.
Keep the robot accuracy, but speak normal.

RESPONSE STYLE:
${responseStyle}

RULES:
- Use saved memory when relevant.
- Do not dump all memory unless Keith asks for full detail.
- Explain what is happening.
- Judge if it is good, bad, stuck, idle, or moving.
- Give ONE action.
- Explain why.
- No vague consultant garbage.
`;
    }

    // ===== GENERAL MODE =====
    else {
      systemPrompt = `
You are Codex Brain.

You are Keith's personal AI operating system.

Known memory:
${formattedMemory || "No saved memory yet."}

STYLE:
Talk like a sharp human.
Natural. Slight attitude. Not robotic.
Keep the robot accuracy, but speak normal.
Do not sound like a professor, therapist, or corporate intern.

RESPONSE STYLE:
${responseStyle}

RULES:
- Use saved memory when relevant.
- Do not dump all memory unless Keith asks for full detail.
- For simple personal questions, answer shortly.
- If Keith asks "what do you know about me", summarize only the most important points unless he asks for the whole detail.
- No long paragraphs unless explicitly requested.
- No broken links.
- No fake memory claims.
- If you do not know something from memory, say it plainly.
`;
    }

    const request = {
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: systemPrompt },
        ...chatHistory,
        { role: "user", content: message }
      ]
    };

    if (!isOperator && shouldUseWeb(message)) {
      request.tools = [{ type: "web_search_preview" }];
    }

    const response = await client.responses.create(request);

    let reply = clean(getReply(response));

    chatHistory.push({ role: "user", content: message });
    chatHistory.push({ role: "assistant", content: reply });

    if (chatHistory.length > MAX_HISTORY) {
      chatHistory = chatHistory.slice(-MAX_HISTORY);
    }

    res.json({ reply });

  } catch (e) {
    console.error("CHAT ERROR:", e);
    res.status(500).json({ error: e.message });
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
app.listen(3000, () => {
  console.log("Server running on port 3000");
});