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

// ===== CHAT HISTORY =====
let chatHistory = [];
const MAX_HISTORY = 10;
let lastLiveTopic = "";

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

// ===== MEMORY CLEANER =====
function cleanMemoryInput(message) {
  let value = String(message || "")
    .replace(/save this to memory[:\-]?/i, "")
    .replace(/save to memory[:\-]?/i, "")
    .replace(/remember this[:\-]?/i, "")
    .replace(/remember that[:\-]?/i, "")
    .replace(/store this[:\-]?/i, "")
    .trim();

  value = value.replace(/\s+/g, " ").trim();

  if (value.length <= 220) return [value];

  const facts = [];
  const lower = value.toLowerCase();

  if (lower.includes("wife") && lower.includes("sofia")) {
    facts.push("My wife is Sofia Grishchenko.");
  }

  if (lower.includes("no longer have feelings") || lower.includes("no feelings")) {
    facts.push("I have said I no longer have feelings for my wife.");
  }

  if (lower.includes("son") && lower.includes("eli")) {
    facts.push("My son is named Eli.");
  }

  if (lower.includes("hate slow") || lower.includes("wasted time")) {
    facts.push("I hate slow systems and wasted time.");
  }

  if (lower.includes("makes me happy") || lower.includes("happy")) {
    facts.push("What makes me happy is control, fast progress, building useful systems, and seeing proof that things work.");
  }

  if (lower.includes("overbuild")) {
    facts.push("I tend to overbuild before validating.");
  }

  if (lower.includes("codex brain")) {
    facts.push("Codex Brain is my central AI operating system and control layer, not a dispatch system.");
  }

  if (facts.length === 0) {
    facts.push(value.slice(0, 280));
  }

  return [...new Set(facts)];
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

function shouldUseWeb(msg) {
  const lower = msg.toLowerCase();

  const liveTriggers = [
    "today",
    "now",
    "current",
    "latest",
    "live",
    "news",
    "score",
    "scores",
    "won",
    "win",
    "match",
    "matches",
    "playing",
    "played",
    "schedule",
    "draw",
    "tournament",
    "injury",
    "injured",
    "withdrew",
    "withdraw",
    "withdrawn",
    "pull out",
    "pulled out",
    "tennis",
    "football",
    "soccer",
    "nba",
    "nfl",
    "mlb",
    "ufc",
    "price",
    "stock",
    "weather",
    "breaking",
    "update",
    "this week",
    "yesterday",
    "tomorrow",
    "check",
    "verify",
    "look up",
    "search",
    "are you sure"
  ];

  const liveEntities = [
    "sinner",
    "alcaraz",
    "djokovic",
    "nadal",
    "medvedev",
    "zverev",
    "madrid open",
    "mutua madrid",
    "atp",
    "wta",
    "roland garros",
    "wimbledon",
    "us open",
    "australian open"
  ];

  const directTrigger =
    liveTriggers.some(t => lower.includes(t)) ||
    liveEntities.some(t => lower.includes(t));

  const followUpTrigger =
    ["check", "verify", "look it up", "search", "are you sure"].some(t => lower.includes(t)) &&
    Boolean(lastLiveTopic);

  return directTrigger || followUpTrigger;
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
    lower.includes("whole damn detail") ||
    lower.includes("tell me all")
  );
}

function isOperatorQuestion(lower) {
  return (
    lower.includes("dispatch") ||
    lower.includes("happening") ||
    lower.includes("system status") ||
    lower.includes("what should i do") ||
    lower.includes("what should i focus") ||
    lower.includes("what do i do")
  );
}

function updateLastLiveTopic(message) {
  const lower = message.toLowerCase();

  const liveTopicWords = [
    "sinner",
    "alcaraz",
    "djokovic",
    "nadal",
    "madrid open",
    "mutua madrid",
    "tennis",
    "atp",
    "wta",
    "score",
    "match",
    "today",
    "latest",
    "current",
    "news",
    "weather",
    "stock"
  ];

  if (liveTopicWords.some(w => lower.includes(w))) {
    lastLiveTopic = message;
  }
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

    updateLastLiveTopic(message);

    // ===== SAVE MEMORY =====
    if (isSaveMemoryRequest(message)) {
      const cleanedFacts = cleanMemoryInput(message);
      let savedCount = 0;

      for (const fact of cleanedFacts) {
        const saved = await saveMemory(fact);
        if (saved) savedCount++;
      }

      if (savedCount === 0) {
        return res.json({
          reply: "Tried to save it, but Supabase rejected it. So no, I’m not pretending it worked."
        });
      }

      return res.json({
        reply: `Saved ${savedCount} clean memory ${savedCount === 1 ? "entry" : "entries"}.`
      });
    }

    const memory = await loadMemory();
    const formattedMemory = memory.map(m => `- ${m.value}`).join("\n");

    const dispatchSummary = getDispatchSummary();
    const issues = analyzeDispatches();

    const wantsFull = wantsFullAnswer(message);
    const isOperator = isOperatorQuestion(lower);
    const useWeb = !isOperator && shouldUseWeb(message);

    const effectiveUserMessage =
      useWeb &&
        lastLiveTopic &&
        ["check", "verify", "look it up", "search", "are you sure"].some(t => lower.includes(t))
        ? `${message}\n\nPrevious live topic/context: ${lastLiveTopic}`
        : message;

    const responseStyle = wantsFull
      ? "Keith explicitly asked for detail. Give a full detailed answer."
      : "Keep it short, sharp, and human. Do not dump the whole memory. No long speeches.";

    let systemPrompt;

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
- Use saved memory only when relevant.
- Do not dump all memory unless Keith clearly asks for full detail.
- Explain what is happening.
- Judge if it is good, bad, stuck, idle, or moving.
- Give ONE action.
- Explain why.
- No vague consultant garbage.
`;
    } else if (useWeb) {
      systemPrompt = `
You are Codex Brain.

You are Keith's personal AI operating system.

LIVE DATA MODE:
This question needs current/live information.
You MUST use web search.
Do NOT answer from memory for current events, sports, scores, schedules, prices, weather, or news.
Do NOT guess.
Do NOT invent match results.
If web results are unclear or conflicting, say that plainly.

CRITICAL TENNIS / SPORTS RULES:
- If a player withdrew, say "withdrew".
- If a player lost a match, say "lost".
- If a player is not scheduled, say "not scheduled".
- If a player is injured, say "injured" only if the source supports it.
- Do NOT say "knocked out" unless a source clearly says they lost a match.
- Distinguish clearly between: withdrew / injured / lost / not scheduled / still in tournament.
- If Keith asks a follow-up like "check", use the previous live topic context.

Known memory:
${formattedMemory || "No saved memory yet."}

Previous live topic:
${lastLiveTopic || "None"}

STYLE:
Talk like a sharp human.
Natural. Slight attitude. Not robotic.
Keep it short and clean unless Keith asks for full detail.

RESPONSE STYLE:
${responseStyle}

RULES:
- Use current web results.
- No raw URLs.
- No broken links.
- No fake certainty.
- For sports/news, give key facts only.
- Do not mention dispatch unless Keith asks about dispatch.
- If you cannot verify it, say: "I can’t confirm that from live results."
`;
    } else {
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
- Use saved memory only when relevant.
- Do not dump all memory unless Keith clearly asks for full detail.
- For simple personal questions, answer shortly.
- If Keith asks "what do you know about me", summarize only the most important points unless he asks for the whole detail.
- No long paragraphs unless explicitly requested.
- No broken links.
- No fake memory claims.
- If you do not know something from memory, say it plainly.
- Do not mention dispatch unless Keith asks about dispatch.
`;
    }

    const baseRequest = {
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: systemPrompt },
        ...chatHistory,
        { role: "user", content: effectiveUserMessage }
      ]
    };

    let response;
    let webToolFailed = false;

    if (useWeb) {
      try {
        response = await client.responses.create({
          ...baseRequest,
          tools: [{ type: "web_search" }]
        });
      } catch (webError) {
        console.error("WEB SEARCH ERROR:", webError.message);
        webToolFailed = true;

        response = await client.responses.create({
          ...baseRequest,
          input: [
            { role: "system", content: systemPrompt },
            ...chatHistory,
            {
              role: "user",
              content:
                effectiveUserMessage +
                "\n\nIMPORTANT: Web search failed. Do not invent live facts. Say you cannot verify live data right now."
            }
          ]
        });
      }
    } else {
      response = await client.responses.create(baseRequest);
    }

    let reply = clean(getReply(response));

    chatHistory.push({ role: "user", content: message });
    chatHistory.push({ role: "assistant", content: reply });

    if (chatHistory.length > MAX_HISTORY) {
      chatHistory = chatHistory.slice(-MAX_HISTORY);
    }

    res.json({
      reply,
      web_used: useWeb && !webToolFailed,
      web_failed: webToolFailed,
      last_live_topic: lastLiveTopic
    });

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
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});