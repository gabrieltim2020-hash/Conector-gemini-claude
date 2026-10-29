// Ponte Gemini -> Claude (servidor MCP remoto para Vercel)

const PROTOCOL_VERSION = "2024-11-05";

const TOOL = {
  name: "gemini_escrever",
  description: "Pede ao Google Gemini para ESCREVER um rascunho (código Python/JS/HTML, textos, currículos, roteiros, etc.). Use para tarefas de escrita longas; depois o Claude revisa. Se a resposta começar com COTA_GEMINI_ESGOTADA, o Claude deve fazer a tarefa sozinho.",
  inputSchema: {
    type: "object",
    properties: {
      tarefa: {
        type: "string",
        description: "O que o Gemini deve escrever, com todos os requisitos."
      },
      contexto: {
        type: "string",
        description: "Opcional: código existente, trechos de arquivos ou regras do projeto."
      },
      modelo: {
        type: "string",
        description: "Opcional: modelo para tentar primeiro (ex.: gemini-flash-latest). Se omitido, tenta Pro e cai para Flash no erro 429."
      }
    },
    required: ["tarefa"]
  }
};

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function error(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolText(text, isError = false) {
  return { content: [{ type: "text", text: text }], isError };
}

const DEFAULT_MODELS = ["gemini-pro-latest", "gemini-flash-latest"];

function getModelList(requestedModel) {
  const fromVercel = (process.env.GEMINI_MODELS || "")
    .split(",").map(m => m.trim()).filter(Boolean);
  const base = fromVercel.length ? fromVercel : DEFAULT_MODELS;
  const list = requestedModel ? [requestedModel, ...base] : base;
  return [...new Set(list)];
}

async function tryModel(model, key, prompt) {
  const URL = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  try {
    const r = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] })
    });
    return { r };
  } catch (e) {
    return { netError: e.message };
  }
}

async function callGemini({ tarefa, contexto, modelo }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return toolText("ERRO_CONFIG: GEMINI_API_KEY não configurado no Vercel.", true);

  const prompt = (contexto ? `CONTEXTO:\n${contexto}\n\n` : "") +
                 `TAREFA:\n${tarefa}\n\n` +
                 "Responda em português do Brasil. Se for código, entregue o código completo e funcional.";

  const attemptLogs = [];

  for (const m of getModelList(modelo)) {
    const { r, netError } = await tryModel(m, key, prompt);
    
    if (netError) {
      return toolText(`GEMINI_INDISPONIVEL: falha de rede (${netError}). Claude deve fazer sozinho.`, true);
    }

    if (r.status === 429) {
      attemptLogs.push(`${m} -> 429 (cota)`);
      continue;
    }
    if (r.status === 404) {
      attemptLogs.push(`${m} -> 404 (modelo indisponível)`);
      continue;
    }
    if (!r.ok) {
      const body = await r.text().catch(() => "").slice(0, 500);
      return toolText(`GEMINI_ERRO_${r.status}_${m}: ${body}`, true);
    }

    const data = await r.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.map(p => p.text || "").join("").trim();
    
    if (!text) {
      const reason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason || "desconhecido";
      return toolText(`GEMINI_SEM_RESPOSTA_${m} (motivo: ${reason}). Claude deve fazer sozinho.`, true);
    }

    const warning = attemptLogs.length ? ` | Plano B usado: ${attemptLogs.join("; ")}` : "";
    return toolText(`[Rascunho do Gêmeos - modelo: ${m}${warning}]\n\n${text}`);
  }

  return toolText(`COTA_GEMINI_ESGOTADA: nenhum modelo disponível (${attemptLogs.join("; ")}). Claude deve fazer a tarefa sozinho.`, true);
}

async function handleMessage(message) {
  const { id, method, params } = message || {};
  const isNotification = id === undefined || id === null;

  if (method === "initialize") {
    return response(id, {
      protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "ponte-gemeos", version: "1.0.0" }
    });
  }

  if (isNotification) return null;
  if (method === "ping") return response(id, {});
  if (method === "tools/list") return response(id, { tools: [TOOL] });
  if (method === "tools/call") {
    if (params?.name !== TOOL.name) return error(id, -32602, "Ferramenta desconhecida");
    const args = params.arguments || {};
    if (!args.tarefa) return response(id, toolText("Faltou o campo 'tarefa'.", true));
    return response(id, await callGemini(args));
  }

  return error(id, -32601, `Método não suportado: ${method}`);
}

export default async function handler(req, res) {
  const secret = process.env.MCP_SECRET;
  const url = new URL(req.url, "http://localhost");
  
  if (secret) {
      const authHeader = req.headers.authorization;
      const queryKey = url.searchParams.get("key");
      if (authHeader !== `Bearer ${secret}` && queryKey !== secret) {
          return res.status(401).json({ error: "Não autorizado" });
      }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Usar POST" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } 
    catch (e) { return res.status(400).json(error(null, -32700, "JSON inválido")); }
  }

  if (Array.isArray(body)) {
    const results = (await Promise.all(body.map(handleMessage))).filter(Boolean);
    if (results.length === 0) return res.status(202).end();
    return res.status(200).json(results);
  }

  const result = await handleMessage(body);
  if (!result) return res.status(202).end();
  return res.status(200).json(result);
}

export const config = { maxDuration: 60 };
