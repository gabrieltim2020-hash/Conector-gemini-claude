// Ponte Gemini -> Claude (servidor MCP remoto para a Vercel)
// O Claude chama a ferramenta "gemini_escrever"; este arquivo repassa o pedido
// para a API do Gemini (usando a SUA chave e a cota grátis do Google) e devolve o texto.
//
// Variáveis de ambiente (configure no painel da Vercel, NUNCA no código):
//   GEMINI_API_KEY  -> sua chave do Google AI Studio
//   MCP_SECRET      -> uma senha longa inventada por você (protege sua cota)
//   GEMINI_MODELS   -> opcional; ordem do plano B. Padrão "gemini-pro-latest,gemini-flash-latest"

const PROTOCOLO_PADRAO = "2025-06-18";

const FERRAMENTA = {
  name: "gemini_escrever",
  description:
    "Pede ao Google Gemini para ESCREVER um rascunho (código Python/JS/HTML, textos, " +
    "resumos, roteiros, etc.). Use para tarefas de escrita longas; depois o Claude revisa. " +
    "Se a resposta começar com COTA_GEMINI_ESGOTADA, o Claude deve fazer a tarefa sozinho.",
  inputSchema: {
    type: "object",
    properties: {
      tarefa: {
        type: "string",
        description: "O que o Gemini deve escrever, com todos os requisitos.",
      },
      contexto: {
        type: "string",
        description: "Opcional: código existente, trechos de arquivos ou regras do projeto.",
      },
      modelo: {
        type: "string",
        description: "Opcional: modelo para tentar primeiro (ex.: gemini-flash-latest). Se omitido, tenta Pro e cai para Flash no erro 429.",
      },
    },
    required: ["tarefa"],
  },
};

function resposta(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function erro(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function textoFerramenta(texto, isError = false) {
  return { content: [{ type: "text", text: texto }], isError };
}

// PLANO B: ordem de tentativa dos modelos.
// 1º o Pro (respostas mais complexas); se der 429 (cota/excesso de pedidos),
// tenta o Flash (cota grátis maior). Dá para mudar sem mexer no código,
// criando na Vercel a variável GEMINI_MODELS="modeloA,modeloB,modeloC".
const MODELOS_PADRAO = ["gemini-pro-latest", "gemini-flash-latest"];

function listaDeModelos(modeloPedido) {
  const daVercel = (process.env.GEMINI_MODELS || "")
    .split(",").map((m) => m.trim()).filter(Boolean);
  const base = daVercel.length ? daVercel : MODELOS_PADRAO;
  const lista = modeloPedido ? [modeloPedido, ...base] : base;
  return [...new Set(lista)]; // remove repetidos
}

async function tentarModelo(model, chave, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": chave },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
    });
    return { r };
  } catch (e) {
    return { erroRede: e.message };
  }
}

async function chamarGemini({ tarefa, contexto, modelo }) {
  const chave = process.env.GEMINI_API_KEY;
  if (!chave) return textoFerramenta("ERRO_CONFIG: GEMINI_API_KEY não configurada na Vercel.", true);

  const prompt =
    (contexto ? `CONTEXTO:\n${contexto}\n\n` : "") +
    `TAREFA:\n${tarefa}\n\n` +
    "Responda em português do Brasil. Se for código, entregue o código completo e funcional.";

  const tentativas = []; // histórico: "gemini-pro-latest → 429"

  for (const model of listaDeModelos(modelo)) {
    const { r, erroRede } = await tentarModelo(model, chave, prompt);

    if (erroRede) {
      return textoFerramenta(`GEMINI_INDISPONIVEL: falha de rede (${erroRede}). Claude deve fazer sozinho.`, true);
    }

    // 429 = cota esgotada ou muitas requisições → plano B: próximo modelo
    if (r.status === 429) {
      tentativas.push(`${model} → 429 (cota)`);
      continue;
    }
    // 404 = modelo não existe mais/não liberado para sua chave → também pula
    if (r.status === 404) {
      tentativas.push(`${model} → 404 (modelo indisponível)`);
      continue;
    }
    if (!r.ok) {
      const corpo = (await r.text()).slice(0, 500);
      return textoFerramenta(`GEMINI_ERRO ${r.status} no modelo ${model}: ${corpo}`, true);
    }

    const dados = await r.json();
    const partes = dados?.candidates?.[0]?.content?.parts || [];
    const texto = partes.map((p) => p.text || "").join("").trim();
    if (!texto) {
      const motivo = dados?.candidates?.[0]?.finishReason || dados?.promptFeedback?.blockReason || "desconhecido";
      return textoFerramenta(`GEMINI_SEM_RESPOSTA no modelo ${model} (motivo: ${motivo}). Claude deve fazer sozinho.`, true);
    }

    const aviso = tentativas.length ? ` | plano B usado: ${tentativas.join("; ")}` : "";
    return textoFerramenta(`[Rascunho do Gemini — modelo ${model}${aviso}]\n\n${texto}`);
  }

  // Todos os modelos falharam com 429/404
  return textoFerramenta(
    `COTA_GEMINI_ESGOTADA: nenhum modelo disponível (${tentativas.join("; ")}). Claude deve fazer a tarefa sozinho.`,
    true
  );
}

async function tratarMensagem(msg) {
  const { id, method, params } = msg || {};
  const ehNotificacao = id === undefined || id === null;

  if (method === "initialize") {
    return resposta(id, {
      protocolVersion: params?.protocolVersion || PROTOCOLO_PADRAO,
      capabilities: { tools: {} },
      serverInfo: { name: "ponte-gemini", version: "1.0.0" },
    });
  }
  if (ehNotificacao) return null; // ex.: notifications/initialized
  if (method === "ping") return resposta(id, {});
  if (method === "tools/list") return resposta(id, { tools: [FERRAMENTA] });
  if (method === "tools/call") {
    if (params?.name !== FERRAMENTA.name) return erro(id, -32602, "Ferramenta desconhecida");
    const args = params.arguments || {};
    if (!args.tarefa) return resposta(id, textoFerramenta("Faltou o campo 'tarefa'.", true));
    return resposta(id, await chamarGemini(args));
  }
  return erro(id, -32601, `Método não suportado: ${method}`);
}

export default async function handler(req, res) {
  // Senha simples na URL: https://seu-projeto.vercel.app/api/mcp?key=SUA_SENHA
  const segredo = process.env.MCP_SECRET;
  const url = new URL(req.url, "http://localhost");
  if (!segredo || url.searchParams.get("key") !== segredo) {
    return res.status(401).json({ error: "Não autorizado" });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST" });
  }

  let corpo = req.body;
  if (typeof corpo === "string") {
    try { corpo = JSON.parse(corpo); } catch { return res.status(400).json(erro(null, -32700, "JSON inválido")); }
  }

  if (Array.isArray(corpo)) {
    const saidas = (await Promise.all(corpo.map(tratarMensagem))).filter(Boolean);
    if (saidas.length === 0) return res.status(202).end();
    return res.status(200).json(saidas);
  }

  const saida = await tratarMensagem(corpo);
  if (!saida) return res.status(202).end();
  return res.status(200).json(saida);
}

export const config = { maxDuration: 60 };
