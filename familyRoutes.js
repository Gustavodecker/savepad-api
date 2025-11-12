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
  // Rota para adicionar um novo membro à família
  // =====================================================
 app.post("/family/add", async (req, res) => {
  console.log("📥 /family/add recebido:", req.body);
  const { owner_id, name, phone } = req.body;


    if (!owner_id || !name || !phone) {
      return res.status(400).json({ error: "Campos obrigatórios: owner_id, name, phone" });
    }

    // Busca o nome do dono
    const owner = await dbGet("SELECT name FROM users WHERE id = ?", [owner_id]);
    if (!owner) return res.status(404).json({ error: "Dono não encontrado" });

    // Verifica se o membro já existe
    let member = await dbGet("SELECT * FROM users WHERE whatsapp_number = ?", [phone]);

    if (!member) {
      // Cria usuário pendente
      await dbRun(
        "INSERT INTO users (name, whatsapp_number, status) VALUES (?, ?, 'invited')",
        [name, phone]
      );
      console.log(`👤 Usuário convidado criado: ${name} (${phone})`);
    } else {
      // Atualiza status, caso já exista
      await dbRun("UPDATE users SET status='invited' WHERE id=?", [member.id]);
    }

    // Cria o vínculo familiar
    await dbRun(
      "INSERT INTO family_members (owner_id, member_id, name) VALUES (?, ?, ?)",
      [owner_id, member?.id || null, name]
    );

    // Envia o convite via bot
    await notifyBot(phone, name, owner.name, "invited_external");

    res.json({ success: true });
  });

  // =====================================================
  // Rota chamada pelo botão "Vincular WhatsApp" no app
  // =====================================================
  app.post("/link-whatsapp", async (req, res) => {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: "Número do WhatsApp é obrigatório." });
    }

    await dbRun(
      "UPDATE users SET status='active', verified_at=datetime('now') WHERE whatsapp_number=?",
      [phone]
    );

    console.log(`✅ WhatsApp vinculado: ${phone}`);
    res.json({ success: true, message: "WhatsApp vinculado com sucesso!" });
  });
}
