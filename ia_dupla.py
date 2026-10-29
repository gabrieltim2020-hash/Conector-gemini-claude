"""
ia_dupla.py — módulo para o Jarvis (ou qualquer script Python)

Fluxo:
  1. O Gemini escreve o rascunho (cota grátis do Google).
  2. O Claude revisa e corrige (API da Anthropic).
  3. Se a cota do Gemini acabar, o Claude faz a tarefa sozinho.

ATENÇÃO: a API do Claude é cobrada à parte (créditos em console.anthropic.com),
não usa o seu plano do claude.ai. Sem ANTHROPIC_API_KEY, o módulo devolve só
o rascunho do Gemini, sem revisão.

Instalação:  pip install requests
Chaves (no Windows, crie um arquivo .env ou use variáveis de ambiente):
  GEMINI_API_KEY=...      (aistudio.google.com/apikey)
  ANTHROPIC_API_KEY=...   (console.anthropic.com) — opcional

Uso:
  from ia_dupla import escrever_e_revisar
  resultado = escrever_e_revisar("Crie uma função Python que lê banco_questoes.json e sorteia 15 questões")
  print(resultado["final"])
"""

import os
import requests

# PLANO B: tenta o Pro primeiro; se der 429 (cota/excesso), cai para o Flash.
# Para mudar a ordem sem mexer no código: GEMINI_MODELS="modeloA,modeloB"
GEMINI_MODELOS = [m.strip() for m in os.getenv(
    "GEMINI_MODELS", "gemini-pro-latest,gemini-flash-latest").split(",") if m.strip()]
CLAUDE_MODELO = os.getenv("CLAUDE_MODEL", "claude-sonnet-5-5")
TIMEOUT = 120


class CotaGeminiEsgotada(Exception):
    pass


def _gemini(tarefa: str, contexto: str = "") -> tuple[str, str]:
    """Devolve (texto, modelo_usado). Percorre GEMINI_MODELOS até um funcionar."""
    chave = os.getenv("GEMINI_API_KEY")
    if not chave:
        raise CotaGeminiEsgotada("GEMINI_API_KEY não configurada")

    prompt = (f"CONTEXTO:\n{contexto}\n\n" if contexto else "") + \
             f"TAREFA:\n{tarefa}\n\nResponda em português do Brasil. Se for código, entregue completo."

    tentativas = []
    for modelo in GEMINI_MODELOS:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{modelo}:generateContent"
        try:
            r = requests.post(
                url,
                headers={"x-goog-api-key": chave, "Content-Type": "application/json"},
                json={"contents": [{"role": "user", "parts": [{"text": prompt}]}]},
                timeout=TIMEOUT,
            )
        except requests.RequestException as e:
            raise CotaGeminiEsgotada(f"Falha de rede: {e}")

        # 429 = cota esgotada / muitas requisições → plano B: próximo modelo
        if r.status_code == 429:
            tentativas.append(f"{modelo} → 429")
            print(f"[ia_dupla] {modelo} sem cota (429), tentando o próximo...")
            continue
        # 404 = modelo desligado ou não liberado para a chave → também pula
        if r.status_code == 404:
            tentativas.append(f"{modelo} → 404")
            print(f"[ia_dupla] {modelo} indisponível (404), tentando o próximo...")
            continue
        r.raise_for_status()

        partes = r.json().get("candidates", [{}])[0].get("content", {}).get("parts", [])
        texto = "".join(p.get("text", "") for p in partes).strip()
        if not texto:
            raise CotaGeminiEsgotada(f"{modelo} não devolveu texto")
        return texto, modelo

    raise CotaGeminiEsgotada("Nenhum modelo do Gemini disponível: " + "; ".join(tentativas))


def _claude(prompt: str, sistema: str) -> str:
    chave = os.getenv("ANTHROPIC_API_KEY")
    if not chave:
        raise RuntimeError("ANTHROPIC_API_KEY não configurada")

    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": chave,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": CLAUDE_MODELO,
            "max_tokens": 8000,
            "system": sistema,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    return "".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text").strip()


SISTEMA_REVISOR = (
    "Você é um revisor rigoroso. Recebe uma TAREFA e um RASCUNHO escrito por outra IA. "
    "Corrija erros, bugs, informações falsas e partes faltando. "
    "Responda em português do Brasil com: 1) a VERSÃO FINAL completa e corrigida; "
    "2) uma lista curta 'O que mudei' explicando cada correção de forma simples, para um iniciante."
)

SISTEMA_SOZINHO = "Responda em português do Brasil. Se for código, entregue completo e explique de forma simples."


def escrever_e_revisar(tarefa: str, contexto: str = "") -> dict:
    """Devolve {'quem_escreveu', 'rascunho', 'final', 'revisado'}."""
    try:
        rascunho, modelo_usado = _gemini(tarefa, contexto)
    except CotaGeminiEsgotada as motivo:
        # Plano B: o Claude faz tudo sozinho
        prompt = (f"CONTEXTO:\n{contexto}\n\n" if contexto else "") + f"TAREFA:\n{tarefa}"
        final = _claude(prompt, SISTEMA_SOZINHO)
        return {"quem_escreveu": f"Claude (Gemini indisponível: {motivo})",
                "rascunho": None, "final": final, "revisado": False}

    if not os.getenv("ANTHROPIC_API_KEY"):
        return {"quem_escreveu": f"Gemini ({modelo_usado}), sem revisão: falta ANTHROPIC_API_KEY",
                "rascunho": rascunho, "final": rascunho, "revisado": False}

    final = _claude(f"TAREFA:\n{tarefa}\n\nRASCUNHO DO GEMINI:\n{rascunho}", SISTEMA_REVISOR)
    return {"quem_escreveu": f"Gemini ({modelo_usado}), revisado pelo Claude",
            "rascunho": rascunho, "final": final, "revisado": True}


if __name__ == "__main__":
    import sys
    pedido = " ".join(sys.argv[1:]) or "Escreva uma função Python que soma os números de uma lista."
    res = escrever_e_revisar(pedido)
    print(f"== {res['quem_escreveu']} ==\n")
    print(res["final"])
