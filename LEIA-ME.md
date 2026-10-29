# Ponte Gemini → Claude

O Gemini escreve, o Claude revisa. Dois usos:

- **No chat do claude.ai**: arquivo `api/mcp.js` (conector na Vercel)
- **No Jarvis / scripts Python**: arquivo `ia_dupla.py`

---

## Parte 1 — Conector no chat (≈15 min)

### 1. Pegue a chave do Gemini (grátis)
Acesse **aistudio.google.com/apikey** → *Create API key* → copie a chave.
Nunca cole essa chave no chat nem no código.

### 2. Suba o projeto no GitHub
Crie um repositório novo (ex.: `ponte-gemini`) e envie esta pasta inteira,
do mesmo jeito que você fez com o site da farmácia.

### 3. Importe na Vercel
vercel.com → *Add New → Project* → escolha o repositório → **antes de clicar
em Deploy**, abra *Environment Variables* e crie:

| Nome | Valor |
|---|---|
| `GEMINI_API_KEY` | a chave do passo 1 |
| `MCP_SECRET` | uma senha longa inventada por você (ex.: 30 letras e números aleatórios) |

Clique em **Deploy**.

### 4. Teste no navegador
Abra `https://SEU-PROJETO.vercel.app/api/mcp?key=SUA_SENHA`
Deve aparecer `{"error":"Use POST"}` → significa que está funcionando.

### 5. Adicione no claude.ai
**Configurações → Conectores → Adicionar conector personalizado**
- Nome: `Gemini`
- URL: `https://SEU-PROJETO.vercel.app/api/mcp?key=SUA_SENHA`

Depois, numa conversa, ative o conector no menu **+**.

### 6. Como pedir
> "Use o Gemini para escrever o script X e depois revise."

Se aparecer `COTA_GEMINI_ESGOTADA`, o Claude faz a tarefa sozinho.

---

## Parte 2 — No Jarvis (Python)

1. Copie `ia_dupla.py` para a pasta do Jarvis.
2. `pip install requests`
3. Configure as variáveis `GEMINI_API_KEY` e, se quiser revisão, `ANTHROPIC_API_KEY`.
4. No código:

```python
from ia_dupla import escrever_e_revisar
res = escrever_e_revisar("Resuma o slide de fisiologia renal em tópicos")
print(res["final"])
```

⚠️ A `ANTHROPIC_API_KEY` usa créditos pagos em console.anthropic.com,
**separados** do seu plano do claude.ai.

---

## Segurança
- A senha na URL impede que outras pessoas gastem sua cota.
  Se vazar, troque `MCP_SECRET` na Vercel e atualize a URL do conector.
- Na cota grátis, o Google pode usar o conteúdo para melhorar os modelos.
  Evite mandar dados de clientes ou de pacientes pelo Gemini.

## Plano B (fallback de modelos)
Ordem padrão: **`gemini-pro-latest` → `gemini-flash-latest`**.
- Se o Pro responder **429** (cota esgotada / muitas requisições) ou **404**
  (modelo desligado), o código tenta o próximo automaticamente.
- Se todos falharem, o Claude faz a tarefa sozinho.
- Para mudar a ordem sem mexer no código, crie na Vercel (ou no .env do Jarvis):
  `GEMINI_MODELS=gemini-pro-latest,gemini-flash-latest,gemini-flash-lite-latest`
- Os modelos 1.5 (`gemini-1.5-pro`, `gemini-1.5-flash`) foram desligados pelo
  Google e não funcionam mais.
