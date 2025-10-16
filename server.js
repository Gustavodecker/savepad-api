/****************************************************************************************
 * SAVEpad API - Servidor de Planos e Pagamentos (SDK v2 Mercado Pago)
 * --------------------------------------------------------------------------------------
 * Banco compartilhado com o bot WhatsApp (/root/bot-whatsapp/savepad.db)
 * 
 * Recursos principais:
 *  - Cadastro de usuários e planos
 *  - Integração com Mercado Pago (sandbox/teste)
 *  - Consulta de status do plano
 *  - Webhook para atualização automática
 ****************************************************************************************/

import express from "express";
import dotenv from "dotenv";
import sqlite3 from "sqlite3";
import { promisify } from "util";
import dayjs from "dayjs";
import cors from "cors";
import MercadoPagoConfig, { Preference, Payment } from "mercadopago";

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

// ================== MERCADO PAGO (SDK v2) ==================
const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN,
});

// ================== ROTAS BÁSICAS ==================
app.get("/", (req, res) => {
  res.send("🚀 SavePad API rodando com SDK v2 do Mercado Pago!");
});

// ================== LISTAR PLANOS ==================
app.get("/planos", async (req, res) => {
  try {
    const planos = await dbAll("SELECT * FROM planos");
    res.json(planos);
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
      basico: { nome: "SavePad Básico", preco: 10.0 },
      pro: { nome: "SavePad Pro", preco: 20.0 },
    };

    const escolhido = planosDisponiveis[plano];
    if (!escolhido)
      return res.status(400).json({ error: "Plano inválido" });

    // Cria preferência no Mercado Pago
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

    // Grava no banco
    await dbRun(
      "INSERT INTO planos (user_id, nome_plano, preco, status_pagamento, payment_id, data_criacao) VALUES (?, ?, ?, ?, ?, ?)",
      [user_id, escolhido.nome, escolhido.preco, "pendente", preferenceId, dayjs().format("YYYY-MM-DD HH:mm:ss")]
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

    // Busca detalhes completos do pagamento
    const payment = await new Payment(client).get({ id: paymentId });

    const status = payment.status;
    const transaction_amount = payment.transaction_amount;
    const payer_email = payment.payer?.email || "desconhecido";

    console.log(`💰 Pagamento ${paymentId}: ${status} - R$${transaction_amount}`);

    // Atualiza o status do plano no banco
    await dbRun(
      "UPDATE planos SET status_pagamento = ?, data_pagamento = ? WHERE payment_id = ?",
      [status, dayjs().format("YYYY-MM-DD HH:mm:ss"), paymentId]
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
      "SELECT * FROM planos WHERE user_id = ? ORDER BY data_criacao DESC LIMIT 1",
      [user_id]
    );
    if (!plano) return res.status(404).json({ error: "Plano não encontrado" });
    res.json(plano);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================== INICIAR SERVIDOR ==================
app.listen(PORT, () => {
  console.log(`🚀 SavePad API rodando na porta ${PORT}`);
});
