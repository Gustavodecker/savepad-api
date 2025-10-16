/****************************************************************************************
 * SAVEpad Bot Integration
 * ----------------------------------------------------------------------
 * Responsável por conectar a API SavePad (pagamentos e planos)
 * com o bot WhatsApp (mensagens automáticas).
 ****************************************************************************************/

import fetch from "node-fetch";

export async function notificarBotPagamento({ user_id, plano, status, valor }) {
  try {
    const BOT_URL = process.env.BOT_URL || "http://localhost:3000/notificacao-pagamento";

    console.log(`📤 Enviando notificação ao bot: ${BOT_URL}`);
    console.log({ user_id, plano, status, valor });

    const response = await fetch(BOT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id, plano, status, valor }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Erro ao notificar bot (${response.status}): ${errorText}`);
    } else {
      console.log("✅ Notificação enviada ao bot com sucesso.");
    }
  } catch (err) {
    console.error("🚨 Falha na comunicação com o bot WhatsApp:", err);
  }
}
