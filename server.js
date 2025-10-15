import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import sqlite3 from "sqlite3";
import { promisify } from "util";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 4000;

// ========== BANCO DE DADOS ==========
let db;
let dbRun, dbAll, dbGet;

async function initDB() {
  db = new sqlite3.Database("./database/savepad.db");
  dbRun = promisify(db.run).bind(db);
  dbAll = promisify(db.all).bind(db);
  dbGet = promisify(db.get).bind(db);

  // Tabela de usuários
  await dbRun(`CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT,
    email TEXT,
    telefone TEXT UNIQUE,
    senha TEXT,
    criado_em TEXT
  )`);

  // Tabela de planos
  await dbRun(`CREATE TABLE IF NOT EXISTS planos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    tipo TEXT,
    status TEXT,
    criado_em TEXT,
    expira_em TEXT,
    transaction_id TEXT
  )`);

  console.log("🗄️ Banco de dados inicializado em ./database/savepad.db");
}

// ========== ROTAS ==========
import usuariosRouter from "./routes/usuarios.js";
import planosRouter from "./routes/planos.js";
import webhookRouter from "./routes/webhook.js";

app.use("/usuarios", (req, res, next) => {
  req.db = { dbRun, dbAll, dbGet };
  next();
}, usuariosRouter);

app.use("/planos", (req, res, next) => {
  req.db = { dbRun, dbAll, dbGet };
  next();
}, planosRouter);

app.use("/webhook", (req, res, next) => {
  req.db = { dbRun, dbAll, dbGet };
  next();
}, webhookRouter);

// ========== START ==========
app.listen(PORT, async () => {
  await initDB();
  console.log(`🚀 SavePad API rodando na porta ${PORT}`);
});
