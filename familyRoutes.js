/****************************************************************************************
 * familyRoutes.js
 * --------------------------------------------------------------------------------------
 * Rotas de família e vínculo WhatsApp
 * - /family/add       → dono adiciona um novo membro (apenas nome + WhatsApp)
 * - /link-whatsapp    → membro vincula o WhatsApp pelo app
 * Integra com o Bot AdminGrana via endpoint /send-message
 ****************************************************************************************/

import fetch from "node-fetch";

// Função auxiliar para enviar mensagens ao Bot
async function notifyBot(phone, name, ownerName, action) {
  if (!phone) return console.log(`⚠️ Número não informado para ${name}`);
  try {
    await fetch("http://localhost:3000/send-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, name, ownerName, action }),
    });
    console.log(`📤 Notificação enviada ao bot (${action}) → ${name}`);
  } catch (err) {
    console.error("❌ Erro ao notificar bot:", err.message);
  }
}

/**
 * Função que configura as rotas de família e vínculo
 * @param {ExpressApp} app Instância principal do Express
 * @param {Function} dbGet Função async para SELECT
 * @param {Function} dbRun Função async para INSERT/UPDATE
 */
export function setupFamilyRoutes(app, dbGet, dbRun) {

  // =====================================================
  // ➕ Adicionar um novo membro à família
  // =====================================================
  app.post("/family/add", async (req, res) => {
    try {
      console.log("📡 [POST] /family/add - Body recebido:", req.body);

      const { owner_id, name, phone } = req.body;

      // 🔹 Validação de campos obrigatórios
      if (!owner_id || !name || !phone) {
        console.warn("⚠️ Tentativa de convite com dados incompletos:", req.body);
        return res.status(400).json({
          error: "Você precisa informar o nome e o número de WhatsApp do novo membro.",
        });
      }

      // 🔹 Normaliza o número de telefone
      let normalizedPhone = phone.replace(/\D/g, ""); // remove traços, espaços, parênteses
      if (normalizedPhone.length < 10) {
        return res.status(400).json({ error: "Número de WhatsApp inválido." });
      }
      if (!normalizedPhone.startsWith("55")) {
        normalizedPhone = "55" + normalizedPhone;
      }

      // 🔹 Busca o nome do dono
      const owner = await dbGet("SELECT name FROM users WHERE id = ?", [owner_id]);
      if (!owner) return res.status(404).json({ error: "Dono não encontrado" });

      // 🔹 Busca o membro pelo número
      let member = await dbGet("SELECT * FROM users WHERE whatsapp_number = ?", [normalizedPhone]);

      if (!member) {
        await dbRun(
          "INSERT INTO users (name, whatsapp_number, status) VALUES (?, ?, 'invited')",
          [name, normalizedPhone]
        );
        console.log(`👤 Usuário convidado criado: ${name} (${normalizedPhone})`);
        member = await dbGet("SELECT * FROM users WHERE whatsapp_number = ?", [normalizedPhone]);
      } else {
        await dbRun("UPDATE users SET status='invited' WHERE id=?", [member.id]);
      }

      // 🔹 Cria o vínculo familiar (com ID sempre definido)
      await dbRun(
        "INSERT INTO family_members (owner_id, member_id, name) VALUES (?, ?, ?)",
        [owner_id, member.id, name]
      );

      // 🔹 Envia o convite via bot
      await notifyBot(normalizedPhone, name, owner.name, "invited_external");

      res.json({ success: true, message: "Convite enviado com sucesso!" });
    } catch (err) {
      console.error("❌ Erro ao adicionar membro:", err);
      res.status(500).json({ error: "Erro interno ao adicionar membro." });
    }
  });

  // =====================================================
  // 🔗 Vincular WhatsApp (quando o usuário entra no app)
  // =====================================================
  app.post("/link-whatsapp", async (req, res) => {
    try {
      const { phone } = req.body;

      if (!phone) {
        return res.status(400).json({ error: "Número do WhatsApp é obrigatório." });
      }

      const formatted = phone.replace(/\D/g, "");
      await dbRun(
        "UPDATE users SET status='active', verified_at=datetime('now') WHERE whatsapp_number=?",
        [formatted]
      );

      console.log(`✅ WhatsApp vinculado: ${formatted}`);
      res.json({ success: true, message: "WhatsApp vinculado com sucesso!" });
    } catch (err) {
      console.error("❌ Erro ao vincular WhatsApp:", err);
      res.status(500).json({ error: "Erro interno ao vincular WhatsApp." });
    }
  });
}
