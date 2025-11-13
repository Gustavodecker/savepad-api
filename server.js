/****************************************************************************************
 * SAVEpad API - Servidor de Planos e Pagamentos (SDK v2 Mercado Pago)
 * --------------------------------------------------------------------------------------
 * Banco compartilhado com o bot WhatsApp (/root/bot-whatsapp/savepad.db)
 * 
 * Recursos principais:
 *  - Cadastro de usuários e planos
 *  - Integração com Mercado Pago (sandbox/teste)
 *  - Atualização automática via webhook
 *  - Vinculação de conta com WhatsApp (AdminGrana)
 ****************************************************************************************/

import express from "express";
import dotenv from "dotenv";
import sqlite3 from "sqlite3";
import { promisify } from "util";
import dayjs from "dayjs";
import cors from "cors";
import pkg from "mercadopago";
import crypto from "crypto";
import fetch from "node-fetch"; // 🔹 necessário para preapproval
const { MercadoPagoConfig, Preference, Payment } = pkg;
import { notificarBotPagamento } from "./botIntegration.js";
import bcrypt from "bcrypt";
import { setupFamilyRoutes } from "./familyRoutes.js";


dotenv.config();

// ================== CONFIGURAÇÃO BÁSICA ==================
const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 4000;
const DB_PATH = process.env.DB_PATH || "/root/bot-whatsapp/savepad.db";
const BASE_URL = process.env.BASE_URL || "https://example.ngrok-free.app";

// ================== BANCO DE DADOS ==================
let db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error("❌ Erro ao abrir o banco:", err);
  else console.log(`📦 Banco conectado: ${DB_PATH}`);
});
const dbAll = promisify(db.all.bind(db));
const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));

// ================== MERCADO PAGO ==================
const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN,
});

// ================== ROTA PRINCIPAL ==================
app.get("/", (req, res) => {
  res.send("🚀 SavePad API rodando com SDK v2.9.0 do Mercado Pago!");
});

// ================== LISTAR PLANOS ==================
app.get("/plans", async (req, res) => {
  try {
    const rows = await dbAll("SELECT * FROM plans ORDER BY id DESC");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================== CADASTRO DE USUÁRIO ==================
app.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: "Preencha todos os campos." });
    }

    const hashed = await bcrypt.hash(password, 10);

    await dbRun(
      `INSERT INTO users (name, email, password_hash, created_at)
       VALUES (?, ?, ?, datetime('now'))`,
      [name, email, hashed]
    );

    res.json({ success: true, message: "Usuário criado com sucesso!" });
  } catch (err) {
    console.error("❌ Erro no cadastro:", err);
    res.status(500).json({ error: "Erro ao criar usuário." });
  }
});

// ================== LOGIN DE USUÁRIO ==================
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Informe email e senha." });
    }

    const user = await dbGet("SELECT * FROM users WHERE email = ?", [email]);
    if (!user) {
      return res.status(401).json({ error: "Email ou senha inválidos." });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: "Email ou senha inválidos." });
    }

    res.json({
      success: true,
      message: "Login bem-sucedido!",
      user: {
        id: user.id || user.phone || user.email,
        name: user.name,
        email: user.email,
        plan_id: user.plan_id,
        whatsapp_number: user.whatsapp_number || null,
      },
    });
  } catch (err) {
    console.error("❌ Erro no login:", err);
    res.status(500).json({ error: "Erro interno no servidor." });
  }
});


// ================== GERAR CHECKOUT (Mensal Recorrente / Anual Único) ==================
app.post("/checkout", async (req, res) => {
  try {
    const { user_id, plano, recorrencia } = req.body;

    const planosDisponiveis = {
      basico: { nome: "SavePad Básico", preco: 10.0 },
      pro: { nome: "SavePad Pro", preco: 20.0 },
      familiar: { nome: "SavePad Familiar", preco: 40.0 },
    };

    const escolhido = planosDisponiveis[plano];
    if (!escolhido) return res.status(400).json({ error: "Plano inválido" });

    // 🔸 Caso MENSAL (assinatura recorrente)
    if (recorrencia === "mensal") {
      const body = {
        reason: `${escolhido.nome} - Assinatura Mensal`,
        auto_recurring: {
          frequency: 1,
          frequency_type: "months",
          transaction_amount: escolhido.preco,
          currency_id: "BRL",
          start_date: new Date().toISOString(),
          end_date: new Date(new Date().setFullYear(new Date().getFullYear() + 3)).toISOString(),
        },
        back_url: `${BASE_URL}/pagamento-sucesso`,
        payer_email: `${user_id}@savepad.fake`,
      };

      const resp = await fetch("https://api.mercadopago.com/preapproval", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const data = await resp.json();
      console.log("💳 Assinatura mensal criada:", data);

      await dbRun(
        `INSERT INTO plans (user_id, type, status, mode, preapproval_id)
         VALUES (?, ?, ?, ?, ?)`,
        [user_id, plano, "pending", "individual", data.id]
      );

      return res.json({
        checkout_url: data.init_point || data.sandbox_init_point,
        preference_id: data.id,
        recorrencia: "mensal",
      });
    }

    // 🔸 Caso ANUAL (pagamento único)
    const preference = new Preference(client);
    const response = await preference.create({
      body: {
        items: [
          {
            title: `${escolhido.nome} - Assinatura Anual`,
            quantity: 1,
            currency_id: "BRL",
            unit_price: escolhido.preco * 10,
          },
        ],
        back_urls: {
          success: `${BASE_URL}/pagamento-sucesso`,
          failure: `${BASE_URL}/pagamento-falha`,
        },
        notification_url: `${BASE_URL}/webhook`,
        auto_return: "approved",
      },
    });

    const preferenceId = response.id || response.body?.id;
    const expiresAt = dayjs().add(365, "day").format("YYYY-MM-DD");

    await dbRun(
      `INSERT INTO plans (user_id, type, expires_at, status, mode)
       VALUES (?, ?, ?, ?, ?)`,
      [user_id, plano, expiresAt, "pending", "individual"]
    );

    res.json({
      checkout_url: response.init_point || response.body?.init_point,
      preference_id: preferenceId,
      recorrencia: "anual",
    });
  } catch (err) {
    console.error("❌ Erro ao criar checkout:", err);
    res.status(500).json({ error: "Erro interno ao criar pagamento" });
  }
});


// ================== CANCELAR PLANO ==================
app.post("/cancel-plan", async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: "user_id obrigatório" });

    const plano = await dbGet(
      "SELECT * FROM plans WHERE user_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 1",
      [user_id]
    );

    if (!plano) return res.status(404).json({ error: "Nenhum plano ativo encontrado." });

    // 🔸 Cancela assinatura recorrente no Mercado Pago (se existir)
    if (plano.preapproval_id) {
      await fetch(`https://api.mercadopago.com/preapproval/${plano.preapproval_id}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "cancelled" }),
      });
      console.log(`🛑 Assinatura Mercado Pago cancelada: ${plano.preapproval_id}`);
    }

    await dbRun(`UPDATE plans SET status = 'cancelled' WHERE id = ?`, [plano.id]);
    await dbRun(`DELETE FROM family_members WHERE owner_id = ?`, [user_id]);

    console.log(`❌ Plano cancelado localmente para user_id=${user_id}`);

    res.json({ success: true, message: "Assinatura cancelada com sucesso." });
  } catch (err) {
    console.error("❌ Erro ao cancelar plano:", err);
    res.status(500).json({ error: "Erro interno ao cancelar o plano." });
  }
});

// ================== WEBHOOK MERCADO PAGO ==================
app.post("/webhook", async (req, res) => {
  try {
    const paymentId = req.body?.data?.id;
    if (!paymentId) {
      console.log("⚠️ Webhook sem ID válido:", req.body);
      return res.status(400).json({ error: "ID de pagamento ausente" });
    }

    console.log("🔔 Webhook recebido:", req.body);

    let payment;
    try {
      payment = await new Payment(client).get({ id: paymentId });
    } catch (err) {
      if (err.status === 404) {
        console.warn("⚠️ Pagamento não encontrado (teste).");
        return res.status(200).json({ received: true });
      }
      throw err;
    }

    const status = payment.status;
    const payer_email = payment.payer?.email || "desconhecido";

    console.log(`💰 Pagamento ${paymentId}: ${status} - ${payer_email}`);

    // 🔹 Localiza o usuário pelo email do pagador
    const user = await dbGet("SELECT id FROM users WHERE email = ?", [payer_email]);

    if (!user) {
      console.warn(`⚠️ Nenhum usuário encontrado com email ${payer_email}`);
      return res.status(200).json({ received: true });
    }

    // 🔹 Atualiza o plano específico desse usuário
    await dbRun(
      `UPDATE plans
         SET status = ?
       WHERE user_id = ? AND status = 'pending'`,
      [status, user.id]
    );

    console.log(`✅ Plano do usuário ${user.id} atualizado para: ${status}`);

    // 🔹 Notifica o bot se o pagamento for aprovado
    if (status === "approved") {
      await notificarBotPagamento({
        user_id: user.id,
        plano: "SavePad Pro",
        status,
        valor: payment.transaction_amount,
      });
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Erro no webhook:", err);
    res.status(500).json({ error: "Erro interno no servidor" });
  }
});


// ================== CONSULTAR STATUS DO PLANO (com logs detalhados) ==================
app.get("/status/:user_id", async (req, res) => {
  try {
    const { user_id } = req.params;
    const userIdStr = String(user_id).trim();

    console.log(`📥 [STATUS] Requisição recebida para user_id=${userIdStr}`);

    // 🔹 Verifica se o usuário é membro de uma família (e normaliza owner_id)
    const member = await dbGet(
      `SELECT owner_id 
         FROM family_members 
        WHERE CAST(member_id AS TEXT) = ? 
           OR member_id IN (SELECT id FROM users WHERE email = ?)`,
      [userIdStr, userIdStr]
    );

    console.log("👨‍👩‍👧 Verificação de vínculo familiar:", member);

    let targetUserId = userIdStr;

    if (member?.owner_id) {
      if (isNaN(member.owner_id)) {
        const ownerRow = await dbGet(
          "SELECT id FROM users WHERE email = ?",
          [member.owner_id]
        );
        if (ownerRow?.id) {
          targetUserId = String(ownerRow.id);
          console.log(`📧 Owner ID convertido de e-mail para ID numérico: ${targetUserId}`);
        } else {
          console.warn(`⚠️ Nenhum usuário encontrado com email ${member.owner_id}`);
        }
      } else {
        targetUserId = String(member.owner_id);
      }
    }

    console.log(`🎯 Consultando plano do usuário alvo: ${targetUserId}`);

    const plano = await dbGet(
      `SELECT id, user_id, type, status, mode
         FROM plans
        WHERE CAST(user_id AS TEXT) = ?
           OR user_id = ?
        ORDER BY id DESC
        LIMIT 1`,
      [targetUserId, targetUserId]
    );

    console.log("📄 Resultado do plano encontrado:", plano);

    if (!plano) {
      console.log(`🚫 Nenhum plano encontrado para user_id=${targetUserId}`);
      return res.json({ status: "Sem plano ativo" });
    }

    let statusFinal = plano.status;
    if (statusFinal === "approved") statusFinal = "Ativo";
    else if (statusFinal === "pending") statusFinal = "Pendente";
    else if (statusFinal === "cancelled") statusFinal = "Cancelado";

    console.log(`✅ Status final para ${targetUserId}: ${statusFinal}`);

    res.json({
      status: statusFinal,
      type: plano.type,
      mode: plano.mode,
      owner_id: targetUserId,
      user_id: userIdStr,
    });
  } catch (err) {
    console.error("❌ Erro ao consultar plano:", err);
    res.status(500).json({ error: "Erro ao consultar plano" });
  }
});


// ================== VINCULAÇÃO DE WHATSAPP ==================
app.post("/api/link-whatsapp", async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: "user_id obrigatório" });

    const code = "AG-" + crypto.randomInt(100000, 999999);
    await dbRun("UPDATE users SET verification_code = ? WHERE id = ?", [code, user_id]);
    res.json({ code });
  } catch (err) {
    console.error("❌ Erro ao gerar código:", err);
    res.status(500).json({ error: "Erro interno ao gerar código" });
  }
});

app.get("/api/check-whatsapp-link", async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: "user_id obrigatório" });

    const user = await dbGet("SELECT whatsapp_number FROM users WHERE id = ?", [user_id]);
    res.json({
      linked: !!user?.whatsapp_number,
      whatsapp_number: user?.whatsapp_number || null,
    });
  } catch (err) {
    console.error("❌ Erro ao consultar vínculo:", err);
    res.status(500).json({ error: "Erro interno ao consultar" });
  }
});


// ================== PLANOS FAMILIARES ==================



// =====================================================
// Remover membro pelo vínculo (relation_id) — robusto
// =====================================================
app.delete("/family/remove", async (req, res) => {
  try {
    console.log("📡 [DELETE] /family/remove - Body recebido:", req.body);
    const { owner_id, relation_id, member_id } = req.body;

    if (!owner_id || (!relation_id && !member_id)) {
      return res.status(400).json({ error: "Informe owner_id e relation_id (preferencial) ou member_id." });
    }

    // 1) Carrega o vínculo alvo (preferindo relation_id)
    let rel;
    if (relation_id) {
      rel = await dbGet(
        `SELECT 
           fm.id AS relation_id,
           fm.member_id,
           fm.name AS invited_name,
           u.name AS user_name,
           u.whatsapp_number
         FROM family_members fm
         LEFT JOIN users u ON u.id = fm.member_id
         WHERE fm.id = ? AND fm.owner_id = ?`,
        [relation_id, owner_id]
      );
    } else {
      rel = await dbGet(
        `SELECT 
           fm.id AS relation_id,
           fm.member_id,
           fm.name AS invited_name,
           u.name AS user_name,
           u.whatsapp_number
         FROM family_members fm
         LEFT JOIN users u ON u.id = fm.member_id
         WHERE fm.member_id = ? AND fm.owner_id = ? 
         ORDER BY fm.id DESC LIMIT 1`,
        [member_id, owner_id]
      );
    }

    if (!rel) {
      console.warn("⚠️ Vínculo não encontrado para remoção.", { owner_id, relation_id, member_id });
      return res.status(404).json({ error: "Vínculo da família não encontrado." });
    }

    const owner = await dbGet("SELECT name FROM users WHERE id = ?", [owner_id]);

    // 2) Remove pelo relation_id (sem ambiguidade)
    await dbRun("DELETE FROM family_members WHERE id = ?", [rel.relation_id]);

    // 3) Nome amigável (prefere o que foi digitado no convite)
    const finalName = rel.invited_name || rel.user_name || "Membro";
    console.log("🧾 Removido:", {
      relation_id: rel.relation_id,
      member_id: rel.member_id,
      invited_name: rel.invited_name,
      user_name: rel.user_name,
      phone: rel.whatsapp_number,
    });

    // 4) Notifica no WhatsApp, se tiver número
    if (rel.whatsapp_number) {
      console.log("📡 Enviando notificação de remoção ao bot:", {
        phone: rel.whatsapp_number,
        name: finalName,
        ownerName: owner?.name,
        action: "removed",
      });

      // Se você já tem notifyBot(phone, name, ownerName, action):
      await fetch("http://localhost:3000/send-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: rel.whatsapp_number,
          name: finalName,
          ownerName: owner?.name,
          action: "removed",
        }),
      });

      console.log(`📩 Mensagem de remoção enviada para ${finalName} (${rel.whatsapp_number})`);
    } else {
      console.log("ℹ️ Sem WhatsApp cadastrado — não foi enviada mensagem de remoção.");
    }

    res.json({ success: true, message: "Membro removido com sucesso!" });
  } catch (err) {
    console.error("❌ Erro ao remover membro:", err);
    res.status(500).json({ error: "Erro interno ao remover membro." });
  }
});




app.delete("/family/leave", async (req, res) => {
  try {
    const { member_id } = req.body;
    if (!member_id)
      return res.status(400).json({ error: "member_id obrigatório." });

    const relation = await dbGet(
      "SELECT * FROM family_members WHERE member_id = ?",
      [member_id]
    );

    if (!relation)
      return res.status(404).json({ error: "Usuário não faz parte de uma família." });

    await dbRun("DELETE FROM family_members WHERE member_id = ?", [member_id]);

    res.json({ success: true, message: "Você saiu do plano familiar." });
  } catch (err) {
    console.error("❌ Erro ao sair da família:", err);
    res.status(500).json({ error: "Erro ao sair do plano familiar." });
  }
});

app.get("/family/:user_id", async (req, res) => {
  try {
    const { user_id } = req.params;

    const user =
      (await dbGet("SELECT * FROM users WHERE id = ?", [user_id])) ||
      (await dbGet("SELECT * FROM users WHERE email = ?", [user_id]));
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });

    const isOwner = await dbGet(
      "SELECT * FROM plans WHERE user_id = ? AND mode = 'familiar'",
      [user.id]
    );

    let ownerId = user.id;
    if (!isOwner) {
      const relation = await dbGet(
        "SELECT owner_id FROM family_members WHERE member_id = ?",
        [user.id]
      );
      if (relation) ownerId = relation.owner_id;
    }

    const owner = await dbGet("SELECT id, name, email FROM users WHERE id = ?", [ownerId]);
const members = await dbAll(
  `SELECT 
     fm.id            AS relation_id,
     fm.member_id,
     fm.name          AS invited_name,
     u.name           AS user_name,
     u.email,
     u.whatsapp_number
   FROM family_members fm
   LEFT JOIN users u ON u.id = fm.member_id
   WHERE fm.owner_id = ?`,
  [ownerId]
);




    res.json({
      owner,
      members: members || [],
      total: (members?.length || 0) + 1,
    });
  } catch (err) {
    console.error("❌ Erro ao buscar família:", err);
    res.status(500).json({ error: "Erro ao carregar membros da família" });
  }
});

setupFamilyRoutes(app, dbGet, dbRun);

// ================== INICIAR SERVIDOR ==================
app.listen(PORT, () => {
  console.log(`🚀 SavePad API rodando na porta ${PORT}`);
});
