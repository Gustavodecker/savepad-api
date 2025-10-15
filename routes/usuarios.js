import express from "express";
import dayjs from "dayjs";
const router = express.Router();

// Criar usuário
router.post("/", async (req, res) => {
  const { nome, email, telefone, senha } = req.body;
  const criado_em = dayjs().format("YYYY-MM-DD HH:mm:ss");

  try {
    await req.db.dbRun(
      "INSERT INTO usuarios (nome, email, telefone, senha, criado_em) VALUES (?, ?, ?, ?, ?)",
      [nome, email, telefone, senha, criado_em]
    );
    res.status(201).json({ success: true, message: "Usuário criado com sucesso" });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, error: "Erro ao criar usuário" });
  }
});

// Consultar usuário por telefone
router.get("/:telefone", async (req, res) => {
  const { telefone } = req.params;
  const user = await req.db.dbGet("SELECT * FROM usuarios WHERE telefone = ?", [telefone]);
  res.json(user || {});
});

export default router;
