import express from "express";
const router = express.Router();

// Webhook de teste
router.post("/", (req, res) => {
  console.log("📩 Webhook recebido:", req.body);
  res.sendStatus(200);
});

export default router;
