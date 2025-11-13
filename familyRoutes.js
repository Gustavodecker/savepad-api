/****************************************************************************************
 * familyRoutes.js
 * --------------------------------------------------------------------------------------
 * Rotas de família e vínculo WhatsApp
 * - /family/add       → dono adiciona um novo membro (nome + WhatsApp)
 * - /family/remove    → dono remove um membro e envia notificação
 * - /link-whatsapp    → membro pode se cadastrar individualmente, mas não entrar em família
 * Integra com o Bot AdminGrana via endpoint /send-message
 ****************************************************************************************/

import fetch from "node-fetch";

// 🔹 Função auxiliar para enviar mensagens ao Bot
async function notifyBot(phone, message) {
  if (!phone) return console.log("⚠️ Número não informado para envio de mensagem.");
  try {
    await fetch("http://localhost:3000/send-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number: phone, message }),
    });
    console.log(`📩 Mensagem enviada via bot → ${phone}`);
  } catch (err) {
    console.error("❌ Erro ao notificar bot:", err.message);
  }
}

export function setupFamilyRoutes(app, dbGet, dbRun) {
  // =====================================================
  // 🔹 ADICIONAR MEMBRO (somente dono pode convidar)
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

      // Busca nome do dono
      const owner = await dbGet("SELECT name FROM users WHERE id = ?", [owner_id]);
      if (!owner) return res.status(404).json({ error: "Dono não encontrado" });

      // Normaliza número (somente dígitos e com DDI)
      let normalizedPhone = phone.replace(/\D/g, "");
      if (!normalizedPhone.startsWith("55")) normalizedPhone = "55" + normalizedPhone;

      // Verifica se o membro já existe
      let member = await dbGet(
        "SELECT * FROM users WHERE whatsapp_number = ?",
        [normalizedPhone]
      );

      if (!member) {
        await dbRun(
          "INSERT INTO users (name, whatsapp_number, status) VALUES (?, ?, 'invited')",
          [name, normalizedPhone]
        );
        console.log(`👤 Usuário convidado criado: ${name} (${normalizedPhone})`);
      } else {
        await dbRun("UPDATE users SET status='invited' WHERE id=?", [member.id]);
      }

      // Cria vínculo familiar
      await dbRun(
        "INSERT INTO family_members (owner_id, member_id, name) VALUES (?, ?, ?)",
        [owner_id, member?.id || null, name]
      );

      // Mensagem de convite
      const inviteMessage = `👋 Olá ${name}!\n\nVocê foi convidado por *${owner.name}* para fazer parte da família *AdminGrana*.\n\nBaixe o app 👉 https://savepad.app/download\nE toque no botão “Vincular WhatsApp” dentro do app para ativar seu acesso.\n\n🔒 O cadastro na família só pode ser feito através do convite.`;

      await notifyBot(normalizedPhone, inviteMessage);

      res.json({ success: true, message: "Convite enviado com sucesso!" });
    } catch (err) {
      console.error("❌ Erro ao adicionar membro:", err);
      res.status(500).json({ error: "Erro interno ao adicionar membro." });
    }
  });

  // =====================================================
  // 🔹 REMOVER MEMBRO (envia notificação)
  // =====================================================
  app.delete("/family/remove", async (req, res) => {
    try {
      const { owner_id, member_id } = req.body;
      console.log("📡 [DELETE] /family/remove - Body recebido:", req.body);

      if (!owner_id || !member_id)
        return res.status(400).json({ error: "Campos obrigatórios ausentes." });

      const member = await dbGet("SELECT name, whatsapp_number FROM users WHERE id = ?", [
        member_id,
      ]);
      const owner = await dbGet("SELECT name FROM users WHERE id = ?", [owner_id]);

      const exists = await dbGet(
        "SELECT 1 FROM family_members WHERE owner_id = ? AND member_id = ?",
        [owner_id, member_id]
      );
      if (!exists)
        return res.status(404).json({ error: "Membro não encontrado na família." });

      await dbRun("DELETE FROM family_members WHERE owner_id = ? AND member_id = ?", [
        owner_id,
        member_id,
      ]);

      console.log(`🧹 Membro ${member?.name || member_id} removido do grupo.`);

      // 🔹 Envia mensagem no WhatsApp ao membro removido
      if (member?.whatsapp_number) {
        const msg = `⚠️ Olá ${member.name || "usuário"}.\n\nVocê foi removido do grupo familiar de *${owner.name}* no *AdminGrana*.\n\nSe acredita que isso foi um engano, entre em contato com o dono do grupo.\n\nPara voltar, será necessário um novo convite.`;
        await notifyBot(member.whatsapp_number, msg);
        console.log(`📨 Mensagem de remoção enviada para ${member.name} (${member.whatsapp_number})`);
      }

      res.json({ success: true, message: "Membro removido com sucesso." });
    } catch (err) {
      console.error("❌ Erro ao remover membro:", err);
      res.status(500).json({ error: "Erro ao remover membro." });
    }
  });

  // =====================================================
  // 🔹 VINCULAR WHATSAPP (só ativa convite; bloqueia vínculo não convidado)
  // =====================================================
  app.post("/link-whatsapp", async (req, res) => {
    try {
      const { phone } = req.body;
      if (!phone)
        return res.status(400).json({ error: "Número do WhatsApp é obrigatório." });

      let normalizedPhone = phone.replace(/\D/g, "");
      if (!normalizedPhone.startsWith("55")) normalizedPhone = "55" + normalizedPhone;

      const user = await dbGet(
        "SELECT id, status FROM users WHERE whatsapp_number = ?",
        [normalizedPhone]
      );

      if (!user) {
        // ✅ Se não existe, cria conta nova (plano individual)
        await dbRun(
          "INSERT INTO users (name, whatsapp_number, status) VALUES ('Novo Usuário', ?, 'active')",
          [normalizedPhone]
        );
        console.log(`🆕 Novo usuário criado: ${normalizedPhone} (plano individual)`);
        return res.json({
          success: true,
          message: "Conta criada como plano individual com sucesso!",
        });
      }

      // 🔒 Se foi convidado → ativa convite
      if (user.status === "invited") {
        await dbRun(
          "UPDATE users SET status='active', verified_at=datetime('now') WHERE id=?",
          [user.id]
        );
        console.log(`✅ Convite ativado para número: ${normalizedPhone}`);
        return res.json({ success: true, message: "Convite ativado com sucesso!" });
      }

      // 🚫 Se já é ativo, não faz nada
      res.json({ success: true, message: "Usuário já possui conta ativa." });
    } catch (err) {
      console.error("❌ Erro ao vincular WhatsApp:", err);
      res.status(500).json({ error: "Erro interno ao vincular WhatsApp." });
    }
  });
}
