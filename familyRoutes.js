/****************************************************************************************
 * familyRoutes.js
 * --------------------------------------------------------------------------------------
 * Rotas de família e vínculo WhatsApp
 * - /family/add       → dono adiciona um novo membro (apenas nome + WhatsApp)
 * - /link-whatsapp    → membro vincula o WhatsApp pelo app
 * Integra com o Bot AdminGrana via endpoint /send-message
 ****************************************************************************************/

import fetch from "node-fetch";

// ==================== CONFIG BOT ====================
const BOT_URL = process.env.BOT_URL || "http://135.181.97.173:3000";

// ==================== Função auxiliar ====================
async function notifyBot(phone, name, ownerName, action) {
  if (!phone) {
    console.log(`⚠️ Número não informado para ${name}`);
    return;
  }

  const payload = {
    phone,
    name,
    ownerName,
    action,
  };

  try {
    console.log(`📡 Enviando notificação ao bot em: ${BOT_URL}/send-message`);
    console.log("📦 Payload:", payload);

    const response = await fetch(`${BOT_URL}/send-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("❌ Erro na resposta do bot:", text);
      return;
    }

    console.log(`📩 Mensagem enviada via bot → ${phone}`);
  } catch (err) {
    console.error("❌ Erro ao notificar bot:", err.message);
  }
}

// ==================== Rotas de Família ====================
export function setupFamilyRoutes(app, dbGet, dbRun) {
  // =====================================================
  // Adicionar novo membro
  // =====================================================
  app.post("/family/add", async (req, res) => {
    try {
      console.log("📡 [POST] /family/add - Body recebido:", req.body);
      const { owner_id, name, phone } = req.body;

      if (!owner_id || !name || !phone) {
        return res.status(400).json({
          error: "Você precisa informar o nome e o número de WhatsApp do novo membro.",
        });
      }

      // 🔹 Busca o dono
      const owner = await dbGet("SELECT name FROM users WHERE id = ?", [owner_id]);
      if (!owner) return res.status(404).json({ error: "Dono não encontrado." });

      // 🔹 Normaliza número
      let normalizedPhone = phone.replace(/\D/g, "");
      if (!normalizedPhone.startsWith("55")) {
        normalizedPhone = "55" + normalizedPhone;
      }

      // 🔹 Verifica se o membro já existe
      let member = await dbGet("SELECT * FROM users WHERE whatsapp_number = ?", [normalizedPhone]);
      if (!member) {
        await dbRun(
          "INSERT INTO users (name, whatsapp_number, status) VALUES (?, ?, 'invited')",
          [name, normalizedPhone]
        );
        console.log(`👤 Usuário convidado criado: ${name} (${normalizedPhone})`);
      } else {
        await dbRun("UPDATE users SET status='invited' WHERE id=?", [member.id]);
      }

      // 🔹 Cria vínculo familiar
      await dbRun(
        "INSERT INTO family_members (owner_id, member_id, name) VALUES (?, ?, ?)",
        [owner_id, member?.id || null, name]
      );

      // 🔹 Notifica o bot
      await notifyBot(
        normalizedPhone,
        name,
        owner.name,
        "invited_external"
      );

      res.json({ success: true, message: "Convite enviado com sucesso!" });
    } catch (err) {
      console.error("❌ Erro ao adicionar membro:", err);
      res.status(500).json({ error: "Erro interno ao adicionar membro." });
    }
  });

  // =====================================================
  // Remover membro
  // =====================================================
  app.delete("/family/remove", async (req, res) => {
    try {
      console.log("📡 [DELETE] /family/remove - Body recebido:", req.body);
      const { owner_id, member_id } = req.body;

      if (!owner_id || !member_id) {
        return res.status(400).json({ error: "Campos obrigatórios ausentes." });
      }

      const member = await dbGet("SELECT name, whatsapp_number FROM users WHERE id = ?", [member_id]);
      const owner = await dbGet("SELECT name FROM users WHERE id = ?", [owner_id]);

      await dbRun("DELETE FROM family_members WHERE owner_id = ? AND member_id = ?", [
        owner_id,
        member_id,
      ]);

      if (member?.whatsapp_number) {
        console.log("📡 Enviando notificação de remoção ao bot:", {
  phone: member.whatsapp_number,
  name: member.name,
  ownerName: owner.name,
  action: "removed",
});

        await notifyBot(member.whatsapp_number, member.name, owner.name, "removed");
        console.log(`📩 Notificação enviada ao remover ${member.name}`);
      }

      res.json({ success: true, message: "Membro removido com sucesso!" });
    } catch (err) {
      console.error("❌ Erro ao remover membro:", err);
      res.status(500).json({ error: "Erro interno ao remover membro." });
    }
  });

  // =====================================================
  // Vincular WhatsApp
  // =====================================================
  app.post("/link-whatsapp", async (req, res) => {
    try {
      const { phone } = req.body;
      if (!phone) return res.status(400).json({ error: "Número do WhatsApp é obrigatório." });

      await dbRun(
        "UPDATE users SET status='active', verified_at=datetime('now') WHERE whatsapp_number=?",
        [phone]
      );

      console.log(`✅ WhatsApp vinculado: ${phone}`);
      res.json({ success: true, message: "WhatsApp vinculado com sucesso!" });
    } catch (err) {
      console.error("❌ Erro ao vincular WhatsApp:", err);
      res.status(500).json({ error: "Erro interno ao vincular WhatsApp." });
    }
  });
}
