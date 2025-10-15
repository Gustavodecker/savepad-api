/****************************************************************************************
 * SAVEpad API - Servidor de Planos e Pagamentos
 * --------------------------------------------------------------------------------------
 * Unificado com o mesmo banco do bot WhatsApp (/root/bot-whatsapp/savepad.db)
 * 
 * Recursos principais:
 *  - Cadastro de usuários e planos
 *  - Integração futura com Mercado Pago
 *  - Consulta de status do plano
 ****************************************************************************************/

import express from "express";
import dotenv from "dotenv";
import sqlite3 from "sqlite3";
import { promisify } from "util";
import dayjs from "dayjs";
import cors from "cors";

dotenv.config();

// ================== CONFIGURAÇÃO BÁSICA ==================
const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 4000;

// ================== BANCO DE DADOS UNIFICADO ==================
let db;
let dbRun, dbAll, dbGet;

async function initDB() {
  try {
    const dbPath = "/root/bot-whatsapp/savepad.db";
    db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error("❌ Erro ao conectar no banco unificado:", err.message);
      } else {
        console.log(`🗄️ Banco de dados unificado conectado: ${dbPath}`);
      }
    });

    // Habilita modo de escrita simultânea
    db.run("PRAGMA journal_mode=WAL;");

    dbRun = promisify(db.run).bind(db);
    dbAll = promisify(db.all).bind(db);
    dbGet = promisify(db.get).bind(db);

    // Cria tabelas se não existirem
    await dbRun(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT UNIQUE,
        name TEXT,
        plan_id INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        type TEXT,
        status TEXT DEFAULT 'ativo',
        expires_at TEXT
      )
    `);

    console.log("✅ Banco inicializado e tabelas garantidas.");
  } catch (error) {
    console.error("❌ Erro ao inicializar o banco unificado:", error);
  }
}

// ================== ROTAS ==================

// 🔹 Rota básica (teste)
app.get("/", (req, res) => {
  res.json({ message: "🚀 SavePad API online e funcional!" });
});

// 🔹 Cria ou renova plano (mock — futura integração Mercado Pago)
app.post("/planos", async (req, res) => {
  try {
    const { user_id, type = "individual", dias = 30 } = req.body;
    if (!user_id) return res.status(400).json({ error: "user_id é obrigatório" });

    const expires = dayjs().add(dias, "day").toISOString();

    await dbRun(
      "INSERT INTO plans (user_id, type, status, expires_at) VALUES (?, ?, 'ativo', ?)",
      [user_id, type, expires]
    );

    res.json({
      success: true,
      message: `Plano ${type} criado com validade até ${dayjs(expires).format("DD/MM/YYYY")}`,
    });
  } catch (err) {
    console.error("❌ Erro ao criar plano:", err);
    res.status(500).json({ error: "Erro interno ao criar plano" });
  }
});

// 🔹 Lista todos os planos ativos
app.get("/planos", async (req, res) => {
  try {
    const rows = await dbAll("SELECT * FROM plans WHERE status = 'ativo'");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao listar planos" });
  }
});

// 🔹 Consulta status de um plano
app.get("/status/:user_id", async (req, res) => {
  try {
    const { user_id } = req.params;
    const plan = await dbGet(
      "SELECT * FROM plans WHERE user_id = ? ORDER BY id DESC LIMIT 1",
      [user_id]
    );

    if (!plan) return res.json({ ativo: false, mensagem: "Nenhum plano ativo encontrado." });

    const diasRestantes = dayjs(plan.expires_at).diff(dayjs(), "day");
    res.json({
      ativo: diasRestantes >= 0,
      tipo: plan.type,
      expira_em: dayjs(plan.expires_at).format("DD/MM/YYYY"),
      dias_restantes: diasRestantes,
    });
  } catch (err) {
    console.error("❌ Erro ao verificar status:", err);
    res.status(500).json({ error: "Erro ao verificar status do plano" });
  }
});

// 🔹 Cadastro rápido de usuário (mock — integração futura com app)
app.post("/usuarios", async (req, res) => {
  try {
    const { phone, name } = req.body;
    if (!phone || !name)
      return res.status(400).json({ error: "Campos obrigatórios: phone e name" });

    await dbRun("INSERT OR IGNORE INTO users (phone, name) VALUES (?, ?)", [phone, name]);
    res.json({ success: true, message: "Usuário cadastrado com sucesso." });
  } catch (err) {
    res.status(500).json({ error: "Erro ao cadastrar usuário" });
  }
});

// 🔹 Lista usuários cadastrados
app.get("/usuarios", async (req, res) => {
  try {
    const rows = await dbAll("SELECT * FROM users ORDER BY id DESC");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao listar usuários" });
  }
});

// ================== INICIALIZAÇÃO ==================
app.listen(PORT, async () => {
  await initDB();
  console.log(`🚀 SavePad API rodando na porta ${PORT}`);
});
