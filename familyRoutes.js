/****************************************************************************************
 * familyRoutes.js
 * --------------------------------------------------------------------------------------
 * Rotas de família e vínculo WhatsApp
 * - /family/add               → dono convida novo membro
 * - /family/remove            → dono remove membro
 * - /family/confirm-whatsapp  → convidado vincula e entra na família
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

  const payload = { phone, name, ownerName, action };

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
  // Rota: Adicionar novo membro
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

      // Normaliza número
      let normalizedPhone = String(phone).replace(/\D/g, "");
      if (!normalizedPhone.startsWith("55")) {
        normalizedPhone = "55" + normalizedPhone;
      }

      // Buscar dono
      const owner = await dbGet("SELECT name FROM users WHERE id = ?", [owner_id]);
      if (!owner) return res.status(404).json({ error: "Dono não encontrado." });

      // Criar convite SEM member_id (membro só entra quando vincular)
      await dbRun(
        `INSERT INTO family_members (owner_id, member_id, name, whatsapp_number)
         VALUES (?, NULL, ?, ?)`,
        [owner_id, name, normalizedPhone]
      );

      // Enviar mensagem ao bot
      await notifyBot(normalizedPhone, name, owner.name, "invited_external");

      res.json({ success: true, message: "Convite enviado com sucesso!" });
    } catch (err) {
      console.error("❌ Erro ao adicionar membro:", err);
      res.status(500).json({ error: "Erro interno ao adicionar membro." });
    }
  });

  // =====================================================
  // Rota: Remover membro
  // =====================================================
  app.delete("/family/remove", async (req, res) => {
    try {
      console.log("📡 [DELETE] /family/remove - Body recebido:", req.body);
      const { owner_id, member_id } = req.body;

      if (!owner_id || !member_id) {
        return res.status(400).json({ error: "Campos obrigatórios ausentes." });
      }

      // Pega nome do convite OU nome real do user
      const member = await dbGet(
        `SELECT 
            COALESCE(fm.name, u.name) AS name,
            COALESCE(u.whatsapp_number, fm.whatsapp_number) AS whatsapp_number
         FROM family_members fm
         LEFT JOIN users u ON u.id = fm.member_id
         WHERE fm.member_id = ? AND fm.owner_id = ?`,
        [member_id, owner_id]
      );

      if (!member) {
        return res.status(404).json({ error: "Membro não encontrado." });
      }

      const owner = await dbGet("SELECT name FROM users WHERE id = ?", [owner_id]);

      // Remove vínculo
      await dbRun("DELETE FROM family_members WHERE owner_id = ? AND member_id = ?", [
        owner_id,
        member_id,
      ]);

      console.log("🧩 Membro removido:", {
        member_id,
        member_name: member.name,
        phone: member.whatsapp_number,
        owner_name: owner?.name,
      });

      // Envia mensagem de remoção
      if (member.whatsapp_number) {
        await notifyBot(member.whatsapp_number, member.name, owner?.name, "removed");
      }

      res.json({ success: true, message: "Membro removido com sucesso!" });
    } catch (err) {
      console.error("❌ Erro ao remover membro:", err);
      res.status(500).json({ error: "Erro interno ao remover membro." });
    }
  });

  // =====================================================
  // Rota: Confirmar vínculo WhatsApp → membro realmente entra na família
  // =====================================================
  app.post("/family/confirm-whatsapp", async (req, res) => {
    try {
      console.log("📡 [POST] /family/confirm-whatsapp - Body recebido:", req.body);
      const { user_id, phone } = req.body;

      if (!user_id || !phone) {
        return res.status(400).json({
          error: "Campos obrigatórios: user_id e phone.",
        });
      }

      let normalizedPhone = String(phone).replace(/\D/g, "");
      if (!normalizedPhone.startsWith("55")) {
        normalizedPhone = "55" + normalizedPhone;
      }

      // Atualiza WhatsApp do usuário
      await dbRun(
        `UPDATE users 
           SET whatsapp_number = ?, status = 'active', verified_at = datetime('now')
         WHERE id = ?`,
        [normalizedPhone, user_id]
      );

      // Liga convites pendentes ao usuário real
      const result = await dbRun(
        `UPDATE family_members
            SET member_id = ?
          WHERE whatsapp_number = ?
            AND (member_id IS NULL OR member_id = 0)`,
        [user_id, normalizedPhone]
      );

      console.log("🔗 Vínculo atualizado. Linhas afetadas:", result.changes);

      res.json({
        success: true,
        linked: result.changes > 0,
        message:
          result.changes > 0
            ? "WhatsApp vinculado e família conectada com sucesso!"
            : "WhatsApp vinculado, mas nenhum convite correspondente encontrado.",
      });
    } catch (err) {
      console.error("❌ Erro ao confirmar vínculo:", err);
      res.status(500).json({ error: "Erro interno ao confirmar vínculo familiar." });
    }
  });


  // =====================================================
  // Rota antiga — mantida apenas por compatibilidade
  // =====================================================
  app.post("/link-whatsapp", async (req, res) => {
    try {
      const { phone } = req.body;
      if (!phone)
        return res.status(400).json({ error: "Número do WhatsApp é obrigatório." });

      await dbRun(
        "UPDATE users SET status='active', verified_at=datetime('now') WHERE whatsapp_number=?",
        [phone]
      );

      console.log(`✅ WhatsApp vinculado (LEGADO): ${phone}`);
      res.json({ success: true, message: "WhatsApp vinculado com sucesso!" });
    } catch (err) {
      console.error("❌ Erro ao vincular WhatsApp:", err);
      res.status(500).json({ error: "Erro interno ao vincular WhatsApp." });
    }
  });
}
