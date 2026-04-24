const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

// ─── CONFIGURAÇÕES ───────────────────────────────────────────────
const SUPABASE_URL = "https://vwzhvimhsnxaehvyqojt.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ3emh2aW1oc254YWVodnlxb2p0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwMzUzNzYsImV4cCI6MjA5MjYxMTM3Nn0.0uc3RtUKoH1gxMtYVUU5a4N0d5-xg1tu3vgjthL_eq8";
const ZAPI_INSTANCE = "3F2194787B15211F74569E024201EAF7";
const ZAPI_TOKEN = "F73846D0C75319701E529CD2";
const GEMINI_KEY = "AIzaSyDutH-vPz8_M49vXebMVvdOWBBp1L99hlA";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── PROMPT DO AGENTE NIL'S ──────────────────────────────────────
const SYSTEM_PROMPT = `Você é a atendente virtual do Restaurante Nil's, chamada de "Nil". Você atende pedidos de marmita pelo WhatsApp.

PERSONALIDADE:
- Educada, natural, leve, amigável, objetiva e prestativa
- Nunca robótica — use linguagem natural
- Use emojis com moderação (😊 🍛 ✅)
- Tom: "Olá! Tudo bem? 😊 Vou te ajudar com seu pedido!"

HORÁRIO DE FUNCIONAMENTO:
- Aceita pedidos: 10h às 16h (horário de Brasília)
- Fora do horário: informe que está fechado e o horário de funcionamento

CARDÁPIO:
1. MARMITAS PADRÃO
   - Já vêm prontas com proteína + acompanhamentos
   - Cliente pode remover ou adicionar itens
   - Até 2 misturas inclusas. Mais de 2 = cobra taxa adicional

2. FEIJOADA (fluxo especial)
   Opção A - Separada: tamanhos P/M/G, composta de arroz, farofa, couve, feijoada (light ou completa), molho separado
   Opção B - Marmitex: tudo junto na marmita, molho sempre separado

BEBIDAS:
- Refrigerantes: Coca normal, Coca Zero — lata ou 600ml
  * Só detalhar se cliente pedir ou mencionar "coca" ou "refri"
- Sucos: sabores variam diariamente
  * Nunca listar automaticamente. Se perguntarem, diga que vai confirmar a disponibilidade

ENTREGA:
- Vila Conceição e Serraria: entrega normal
- Outras regiões: informar que a taxa será confirmada manualmente

PAGAMENTO:
- Pix, dinheiro ou cartão
- Se dinheiro: perguntar sobre troco

FLUXO DE ATENDIMENTO (siga esta ordem):
1. Saudação calorosa
2. Identificar o que o cliente quer pedir
3. Tipo de marmita / feijoada
4. Se feijoada: tamanho e tipo (separada ou marmitex)
5. Ajustes (remover/adicionar itens)
6. Sugestão leve de bebida (não force)
7. Endereço de entrega
8. Forma de pagamento (se dinheiro, troco)
9. Confirmação completa do pedido

NAVEGAÇÃO / CORREÇÃO DE ERROS:
- Se cliente disser "voltar", "errei", "mudar", "não é isso" → volte uma etapa
- Nunca reinicie o fluxo completo automaticamente
- Resposta padrão: "Sem problema 😊 vamos ajustar isso!"

CONFIRMAÇÃO FINAL:
"✅ Pedido confirmado!
🍛 [itens e ajustes]
📍 Entrega: [endereço]
💳 Pagamento: [forma]
Seu pedido está sendo preparado! Em breve entramos em contato. 😊"

REGRAS:
- Respostas curtas no estilo WhatsApp
- Não sobrecarregue com informação demais de uma vez
- Confirme sempre antes de finalizar
- Seja tolerante a erros de digitação`;

// ─── FUNÇÕES DE SUPABASE ─────────────────────────────────────────
async function getHistorico(telefone) {
  const { data } = await supabase
    .from("conversas")
    .select("historico")
    .eq("telefone", telefone)
    .single();
  return data?.historico || [];
}

async function salvarHistorico(telefone, historico) {
  const { data: existe } = await supabase
    .from("conversas")
    .select("id")
    .eq("telefone", telefone)
    .single();

  if (existe) {
    await supabase
      .from("conversas")
      .update({ historico, atualizado_em: new Date().toISOString() })
      .eq("telefone", telefone);
  } else {
    await supabase
      .from("conversas")
      .insert({ telefone, historico });
  }
}

async function salvarPedido(telefone, resumo) {
  await supabase.from("pedidos").insert({
    telefone,
    itens: resumo,
    status: "novo",
  });
}

// ─── FUNÇÃO DO GEMINI ────────────────────────────────────────────
async function chamarGemini(historico, mensagemUsuario) {
  const messages = historico.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  messages.push({ role: "user", parts: [{ text: mensagemUsuario }] });

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
    {
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: messages,
      generationConfig: { maxOutputTokens: 500, temperature: 0.7 },
    }
  );

  return response.data.candidates[0].content.parts[0].text;
}

// ─── FUNÇÃO DE ENVIO PELO Z-API ──────────────────────────────────
async function enviarMensagem(telefone, texto) {
  await axios.post(
    `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
    { phone: telefone, message: texto }
  );
}

// ─── WEBHOOK PRINCIPAL ───────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // responde rápido pro Z-API

  try {
    const body = req.body;

    // ignora mensagens enviadas pelo próprio bot
    if (body.fromMe) return;

    // ignora se não for mensagem de texto
    if (!body.text?.message) return;

    const telefone = body.phone;
    const mensagem = body.text.message;

    console.log(`📩 [${telefone}] ${mensagem}`);

    // busca histórico salvo
    const historico = await getHistorico(telefone);

    // chama o Gemini
    const resposta = await chamarGemini(historico, mensagem);

    // atualiza histórico
    const novoHistorico = [
      ...historico,
      { role: "user", content: mensagem },
      { role: "assistant", content: resposta },
    ];

    // mantém só as últimas 20 mensagens (10 trocas)
    const historicoLimitado = novoHistorico.slice(-20);
    await salvarHistorico(telefone, historicoLimitado);

    // salva pedido se confirmado
    if (resposta.includes("Pedido confirmado")) {
      await salvarPedido(telefone, resposta);
    }

    // envia resposta pelo WhatsApp
    await enviarMensagem(telefone, resposta);

    console.log(`✅ [${telefone}] Resposta enviada`);
  } catch (err) {
    console.error("❌ Erro no webhook:", err.message);
  }
});

// ─── ROTA DE VERIFICAÇÃO ─────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Bot do Nil's rodando! 🍛" });
});

// ─── INICIA SERVIDOR ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bot do Nil's rodando na porta ${PORT}`);
});
