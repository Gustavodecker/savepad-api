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
const { MercadoPagoConfig, Preference, Payment } = pkg;
import { notificarBotPagamento } from "./botIntegration.js";
import bcrypt from "bcrypt";

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

// ================== GERAR CHECKOUT ==================
app.post("/checkout", async (req, res) => {
  try {
    const { user_id, plano } = req.body;

    const planosDisponiveis = {
      basico: { nome: "SavePad Básico", preco: 10.0, duracaoDias: 30 },
      pro: { nome: "SavePad Pro", preco: 20.0, duracaoDias: 30 },
    };

    const escolhido = planosDisponiveis[plano];
    if (!escolhido)
      return res.status(400).json({ error: "Plano inválido" });

    const preference = new Preference(client);
    const response = await preference.create({
      body: {
        items: [
          {
            title: escolhido.nome,
            quantity: 1,
            currency_id: "BRL",
            unit_price: escolhido.preco,
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
    const expiresAt = dayjs().add(escolhido.duracaoDias, "day").format("YYYY-MM-DD");

    await dbRun(
      `INSERT INTO plans (user_id, type, expires_at, status)
       VALUES (?, ?, ?, ?)`,
      [user_id, plano, expiresAt, "pending"]
    );

    res.json({
      checkout_url: response.init_point || response.body?.init_point,
      preference_id: preferenceId,
    });
  } catch (err) {
    console.error("❌ Erro ao criar checkout:", err);
    res.status(500).json({ error: "Erro interno ao criar pagamento" });
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
        console.warn("⚠️ Pagamento não encontrado (teste ou simulação).");
        return res.status(200).json({ received: true });
      }
      throw err;
    }

    const status = payment.status;
    const payer_email = payment.payer?.email || "desconhecido";

    console.log(`💰 Pagamento ${paymentId}: ${status} - ${payer_email}`);

    // ✅ Atualiza SOMENTE o plano do usuário correto
    await dbRun(
      `UPDATE plans
         SET status = ?
       WHERE user_id IN (
         SELECT id FROM users WHERE email = ? OR id = ?
       )
       AND status = 'pending'
       ORDER BY id DESC
       LIMIT 1`,
      [status, payer_email, payer_email]
    );

    // 🚀 Notifica o bot apenas se o pagamento for aprovado
    if (status === "approved") {
      await notificarBotPagamento({
        user_id: payer_email,
        plano: "SavePad Pro",
        status,
        valor: payment.transaction_amount,
      });
    }

    console.log("✅ Webhook processado com sucesso.");
    res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Erro no webhook:", err);
    res.status(500).json({ error: "Erro interno no servidor" });
  }
});


// ================== CONSULTAR STATUS DO PLANO ==================
app.get("/status/:user_id", async (req, res) => {
  try {
    const { user_id } = req.params;

    // 1️⃣ Verifica se o usuário é membro de uma família
    const member = await dbGet(
      `SELECT owner_id 
         FROM family_members 
        WHERE member_id = ? 
           OR member_id IN (SELECT id FROM users WHERE email = ?)`,
      [user_id, user_id]
    );

    let targetUserId = user_id;

    // Se ele for membro de uma família, busca o plano do dono
    if (member?.owner_id) {
      targetUserId = member.owner_id;
    }

    // 2️⃣ Busca plano por número, texto e e-mail (cobre todas as possibilidades)
    const plano =
      (await dbGet(
        `SELECT * FROM plans WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
        [parseInt(targetUserId)]
      )) ||
      (await dbGet(
        `SELECT * FROM plans WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
        [targetUserId.toString()]
      )) ||
      (await dbGet(
        `SELECT p.* 
           FROM plans p 
           JOIN users u 
             ON p.user_id = u.id OR p.user_id = u.email 
          WHERE u.id = ? OR u.email = ?
          ORDER BY p.id DESC 
          LIMIT 1`,
        [targetUserId, targetUserId]
      ));

    if (!plano) {
      return res.json({ status: "Sem plano ativo" });
    }

    res.json({
      status: plano.status || "Ativo",
      type: plano.type,
      mode: plano.mode,
      owner_id: targetUserId,
      user_id,
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
app.post("/family/add", async (req, res) => {
  try {
    const { owner_id, member_email, name } = req.body;
    if (!owner_id || !member_email || !name)
      return res.status(400).json({ error: "Campos obrigatórios ausentes." });

    let member = await dbGet("SELECT id FROM users WHERE email = ?", [member_email]);
    if (!member) {
      await dbRun(
        "INSERT INTO users (name, email, created_at) VALUES (?, ?, datetime('now'))",
        [name, member_email]
      );
      member = await dbGet("SELECT id FROM users WHERE email = ?", [member_email]);
    }

    const exists = await dbGet(
      "SELECT 1 FROM family_members WHERE owner_id = ? AND member_id = ?",
      [owner_id, member.id]
    );
    if (exists) return res.json({ message: "Usuário já faz parte da família." });

    await dbRun(
      "INSERT INTO family_members (owner_id, member_id, name) VALUES (?, ?, ?)",
      [owner_id, member.id, name]
    );
    res.json({ success: true, message: "Membro adicionado com sucesso!" });
  } catch (err) {
    console.error("❌ Erro ao adicionar membro:", err);
    res.status(500).json({ error: "Erro ao adicionar membro à família." });
  }
});

// 🔹 Remover membro da família (somente o dono pode remover)
app.delete("/family/remove", async (req, res) => {
  try {
    const { owner_id, member_id } = req.body;
    if (!owner_id || !member_id)
      return res.status(400).json({ error: "Campos obrigatórios ausentes." });

    const exists = await dbGet(
      "SELECT 1 FROM family_members WHERE owner_id = ? AND member_id = ?",
      [owner_id, member_id]
    );

    if (!exists)
      return res.status(404).json({ error: "Membro não encontrado na família." });

    await dbRun(
      "DELETE FROM family_members WHERE owner_id = ? AND member_id = ?",
      [owner_id, member_id]
    );

    res.json({ success: true, message: "Membro removido com sucesso." });
  } catch (err) {
    console.error("❌ Erro ao remover membro:", err);
    res.status(500).json({ error: "Erro ao remover membro da família." });
  }
});

// 🔹 Membro sai por conta própria do plano familiar
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



// 🔹 LISTAR MEMBROS DA FAMÍLIA (CORRIGIDA)
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
      `SELECT fm.id, fm.name, u.email 
         FROM family_members fm
         LEFT JOIN users u ON fm.member_id = u.id
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

// ================== INICIAR SERVIDOR ==================
app.listen(PORT, () => {
  console.log(`🚀 SavePad API rodando na porta ${PORT}`);
});
