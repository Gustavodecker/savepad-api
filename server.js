/****************************************************************************************
 * SAVEpad API - Servidor de Planos e Pagamentos (SDK v2 Mercado Pago)
 * --------------------------------------------------------------------------------------
 * Banco compartilhado com o bot WhatsApp (/root/bot-whatsapp/savepad.db)
 * 
 * Recursos principais:
 *  - Cadastro de usuários e planos
 *  - Integração com Mercado Pago (sandbox/teste)
 *  - Atualização automática via webhook
 ****************************************************************************************/

import express from "express";
import dotenv from "dotenv";
import sqlite3 from "sqlite3";
import { promisify } from "util";
import dayjs from "dayjs";
import cors from "cors";
import pkg from "mercadopago";
const { MercadoPagoConfig, Preference, Payment } = pkg;

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
    const plano = await dbGet(
      `SELECT * FROM plans
         WHERE user_id = ?
         ORDER BY id DESC
         LIMIT 1`,
      [user_id]
    );

    if (!plano)
      return res.status(404).json({ error: "Plano não encontrado" });

    res.json(plano);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================== INICIAR SERVIDOR ==================
app.listen(PORT, () => {
  console.log(`🚀 SavePad API rodando na porta ${PORT}`);
});
