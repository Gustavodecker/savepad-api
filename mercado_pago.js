/****************************************************************************************
 * SAVEpad - Módulo Mercado Pago
 ****************************************************************************************/

import express from "express";
import dotenv from "dotenv";
import { MercadoPagoConfig, Preference, Payment } from "mercadopago";
import sqlite3 from "sqlite3";
import { promisify } from "util";
import dayjs from "dayjs";

dotenv.config();

const router = express.Router();

const db = new sqlite3.Database(process.env.DB_PATH || "/root/bot-whatsapp/savepad.db");
const dbRun = promisify(db.run).bind(db);

// Configuração Mercado Pago
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN,
});

// 🔹 Checkout (criação de link)
router.post("/checkout", async (req, res) => {
  try {
    const { user_id, type = "individual" } = req.body;
    if (!user_id) return res.status(400).json({ error: "user_id é obrigatório" });

    const planPrice = type === "familiar" ? 30 : 15;
    const dias = type === "familiar" ? 60 : 30;
    const expires = dayjs().add(dias, "day").toISOString();

    const preference = new Preference(mpClient);
    const pref = await preference.create({
      body: {
        items: [
          {
            title: `Plano ${type === "familiar" ? "Familiar" : "Individual"} SavePad`,
            quantity: 1,
            unit_price: planPrice,
            currency_id: "BRL",
          },
        ],
        back_urls: {
          success: `${process.env.BASE_URL}/pagamento-sucesso`,
          failure: `${process.env.BASE_URL}/pagamento-erro`,
        },
        notification_url: `${process.env.BASE_URL}/webhook`,
        auto_return: "approved",
        external_reference: `${user_id}|${type}`,
      },
    });

    await dbRun(
      "INSERT INTO plans (user_id, type, status, expires_at) VALUES (?, ?, 'pendente', ?)",
      [user_id, type, expires]
    );

    res.json({
      success: true,
      checkout_url: pref.init_point,
      message: `Plano ${type} criado e aguardando pagamento.`,
    });
  } catch (err) {
    console.error("❌ Erro ao criar checkout:", err);
    res.status(500).json({ error: "Erro ao gerar link de pagamento" });
  }
});

// 🔹 Webhook Mercado Pago
router.post("/webhook", async (req, res) => {
  try {
    const payment = req.body;
    if (!payment || !payment.data || !payment.type) return res.sendStatus(200);

    if (payment.type === "payment") {
      const id = payment.data.id;
      const paymentAPI = new Payment(mpClient);
      const data = await paymentAPI.get({ id });

      const { status, external_reference } = data;
      const [user_id, type] = external_reference.split("|");

      if (status === "approved") {
        const expires = dayjs().add(type === "familiar" ? 60 : 30, "day").toISOString();
        await dbRun(
          "UPDATE plans SET status = 'ativo', expires_at = ? WHERE user_id = ? AND type = ?",
          [expires, user_id, type]
        );
        console.log(`✅ Pagamento aprovado para ${user_id} (${type})`);
      } else {
        console.log(`⚠️ Pagamento não aprovado: ${status}`);
        await dbRun("UPDATE plans SET status = ? WHERE user_id = ? AND type = ?", [
          status,
          user_id,
          type,
        ]);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Erro no webhook:", err);
    res.sendStatus(500);
  }
});

export default router;
