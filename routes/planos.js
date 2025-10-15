import express from "express";
const router = express.Router();

// Rota temporária de teste
router.get("/", (req, res) => {
  res.json({ success: true, message: "Rota de planos funcionando ✅" });
});

export default router;
