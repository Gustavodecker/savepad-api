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
    id: user.id || user.phone || user.email, // 🔹 garante um identificador
    name: user.name,
    email: user.email,
    plan_id: user.plan_id,
    whatsapp_number: user.whatsapp_number || null
  }
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

    // Planos disponíveis
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

    // Define expiração 30 dias após pagamento
    const expiresAt = dayjs().add(escolhido.duracaoDias, "day").format("YYYY-MM-DD");

    // Grava no banco (campos existentes)
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
        console.warn("⚠️ Pagamento não encontrado (provavelmente teste do simulador).");
        return res.status(200).json({ received: true });
      }
      throw err;
    }

    const status = payment.status;
    const payer_email = payment.payer?.email || "desconhecido";

    console.log(`💰 Pagamento ${paymentId}: ${status} - ${payer_email}`);

    // Atualiza o status do plano no banco (último plano pendente do usuário)
    await dbRun(
      `UPDATE plans
         SET status = ?
       WHERE status = 'pending'
       ORDER BY id DESC
       LIMIT 1`,
      [status]
    );

    // 🚀 NOVO TRECHO: notifica o bot caso o pagamento seja aprovado
    if (status === "approved") {
      await notificarBotPagamento({
        user_id: payer_email,
        plano: "SavePad Pro",
        status,
        valor: payment.transaction_amount
      });
    }

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

    // 🔍 Busca o usuário para descobrir o identificador real
    const user =
      (await dbGet(`SELECT * FROM users WHERE id = ? OR email = ? OR phone = ?`, [
        user_id,
        user_id,
        user_id,
      ])) || null;

    let plano = null;

    if (user) {
      // tenta pelo identificador usado no plano
      plano =
        (await dbGet(
          `SELECT * FROM plans WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
          [user.id]
        )) ||
        (await dbGet(
          `SELECT * FROM plans WHERE user_id LIKE ? ORDER BY id DESC LIMIT 1`,
          [`%${user.email || user.phone || user.id}%`]
        ));
    } else {
      // fallback direto (para casos em que id é número de telefone)
      plano =
        (await dbGet(
          `SELECT * FROM plans WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
          [user_id]
        )) ||
        (await dbGet(
          `SELECT * FROM plans WHERE user_id LIKE ? ORDER BY id DESC LIMIT 1`,
          [`%${user_id}%`]
        ));
    }

    if (!plano) {
      return res.json({ status: "Sem plano ativo" });
    }

    res.json({
      status: plano.status || "Ativo",
      type: plano.type,
      user_id: plano.user_id,
    });
  } catch (err) {
    console.error("❌ Erro ao consultar plano:", err);
    res.status(500).json({ error: "Erro ao consultar plano" });
  }
});


// ================== NOVAS ROTAS: VINCULAÇÃO DE WHATSAPP ==================
app.post("/api/link-whatsapp", async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: "user_id obrigatório" });

    const code = "AG-" + crypto.randomInt(100000, 999999);
    await dbRun("UPDATE users SET verification_code = ? WHERE id = ?", [code, user_id]);

    console.log(`🔗 Código gerado para usuário ${user_id}: ${code}`);
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
    console.error("❌ Erro ao consultar status de vinculação:", err);
    res.status(500).json({ error: "Erro interno ao consultar" });
  }
});

// ================== PLANOS FAMILIARES ==================

// 🔹 Adicionar membro da família
app.post("/family/add", async (req, res) => {
  try {
    const { owner_id, member_email, name } = req.body;
    if (!owner_id || !member_email)
      return res.status(400).json({ error: "Campos obrigatórios ausentes" });

    const member = await dbGet("SELECT * FROM users WHERE email = ?", [member_email]);
    if (!member)
      return res.status(404).json({ error: "Usuário não encontrado" });

    // Evita duplicidade
    const existing = await dbGet(
      "SELECT * FROM family_members WHERE owner_id = ? AND member_id = ?",
      [owner_id, member.id]
    );
    if (existing)
      return res.status(409).json({ error: "Este membro já faz parte da família." });

    await dbRun(
      "INSERT INTO family_members (owner_id, member_id, name) VALUES (?, ?, ?)",
      [owner_id, member.id, name || member.name]
    );

    res.json({ success: true, message: "Membro adicionado com sucesso!" });
  } catch (err) {
    console.error("❌ Erro ao adicionar membro:", err);
    res.status(500).json({ error: "Erro interno ao adicionar membro." });
  }
});

// 🔹 Listar membros da família
app.get("/family/:owner_id", async (req, res) => {
  try {
    const { owner_id } = req.params;
    const membros = await dbAll(
      "SELECT id, name, member_id FROM family_members WHERE owner_id = ?",
      [owner_id]
    );
    res.json(membros);
  } catch (err) {
    console.error("❌ Erro ao listar membros:", err);
    res.status(500).json({ error: "Erro ao listar membros." });
  }
});


// ================== INICIAR SERVIDOR ==================
app.listen(PORT, () => {
  console.log(`🚀 SavePad API rodando na porta ${PORT}`);
});
